// app.js - State management and core operations

const DEFAULT_WEB_WIDTH = 750;
const DEFAULT_TERM_WIDTH = 620;
const DEFAULT_FILE_WIDTH = 900;

const MAX_TERMINAL_PANELS = 20;
const MAX_WEB_PANELS = 20;
const MAX_FILE_PANELS = 10;
const MAX_URL_HISTORY = 100;
const MAX_URL_COUNT = 10;
const URL_DECAY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

let state = { activeGroupId: null, groups: [], templates: [], urlHistory: [] };

// Map<panelId, { terminal, fitAddon, cleanup, termId }>
const activeTerminals = new Map();

// Map<panelId, { editor, dispose }>
const activeEditors = new Map();

// Map<serverId, { groupId, serverKey, cleanup }>
const activeLspServers = new Map();

let saveDebounceTimer = null;

// ── Focus tracking ───────────────────────────────
let focusedPanelId = null;

function setFocusedPanel(panelId) {
  if (focusedPanelId === panelId) return;

  // Clear previous
  if (focusedPanelId) {
    const prevEl = document.querySelector(`[data-panel-id="${focusedPanelId}"]`);
    if (prevEl) prevEl.classList.remove('panel-focused');
    hidePanelSearch(focusedPanelId);
  }

  focusedPanelId = panelId;

  // Set new
  if (panelId) {
    const el = document.querySelector(`[data-panel-id="${panelId}"]`);
    if (el) el.classList.add('panel-focused');
  }
}

async function init() {
  const saved = await window.electronAPI.loadState();
  if (saved && Array.isArray(saved.groups) && saved.groups.length > 0) {
    state = saved;
    if (!state.maxCachedGroups || state.maxCachedGroups === 5) state.maxCachedGroups = 20;
    if (!state.templates) state.templates = [];
    if (!state.urlHistory) state.urlHistory = [];
    if (!state.sidebarWidth) state.sidebarWidth = 210;
    // Migrate: ensure all URL history entries have count/lastAccessed
    for (const entry of state.urlHistory) {
      if (!entry.count) entry.count = 1;
      if (!entry.lastAccessed) entry.lastAccessed = entry.timestamp || Date.now();
    }
    // Migrate: ensure all groups have lspServers
    for (const group of state.groups) {
      group.lspServers = group.lspServers || [];
    }
    if (!state.groups.find(g => g.id === state.activeGroupId)) {
      state.activeGroupId = state.groups[0].id;
    }
  } else {
    const id = generateId();
    state = {
      activeGroupId: id,
      maxCachedGroups: 20,
      sidebarWidth: 210,
      groups: [{ id, label: 'Work 1', panels: [], lspServers: [] }],
    };
  }

  renderSidebar();
  document.getElementById('sidebar').style.width = state.sidebarWidth + 'px';
  renderPanelStrip();

  let windowResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(windowResizeTimer);
    windowResizeTimer = setTimeout(() => {
      if (state.activeGroupId) {
        fitVisibleTerminals(state.activeGroupId);
      }
    }, 100);
  });
}

function saveState() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    window.electronAPI.saveState(state);
  }, 400);
}

function generateId() {
  return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getActiveGroup() {
  return state.groups.find(g => g.id === state.activeGroupId) || null;
}

// ── Group operations ──────────────────────────────

function addGroup() {
  const id = generateId();
  state.groups.push({ id, label: `Work ${state.groups.length + 1}`, panels: [], lspServers: [] });
  state.activeGroupId = id;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function addGroupWithPanels(name, panelConfigs) {
  const id = generateId();
  const widths = { terminal: DEFAULT_TERM_WIDTH, web: DEFAULT_WEB_WIDTH, file: DEFAULT_FILE_WIDTH };

  const panels = panelConfigs.map(config => {
    const panel = {
      id: generateId(),
      type: config.type,
      width: (widths[config.type] || DEFAULT_WEB_WIDTH) * (config.widthMultiplier || 1),
    };
    if (config.type === 'terminal') {
      if (config.cwd) panel.cwd = config.cwd;
      if (config.initialCommand) panel.initialCommand = config.initialCommand;
    } else if (config.type === 'web') {
      panel.url = config.url || '';
    } else if (config.type === 'file') {
      panel.rootDir = config.rootDir || '';
      panel.openFile = null;
    }
    return panel;
  });

  state.groups.push({ id, label: name || `Work ${state.groups.length + 1}`, panels, lspServers: [] });
  state.activeGroupId = id;
  saveState();
  renderSidebar();
  renderPanelStrip(false);
}

function saveTemplate(name, panelConfigs) {
  const template = {
    id: generateId(),
    name,
    panels: panelConfigs.map(config => ({ ...config })),
  };
  state.templates.push(template);
  saveState();
  return template;
}

function deleteTemplate(templateId) {
  state.templates = state.templates.filter(t => t.id !== templateId);
  saveState();
}

function deleteGroup(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (group) killGroupTerminals(group);
  removeCachedGroup(groupId);

  state.groups = state.groups.filter(g => g.id !== groupId);

  if (state.groups.length === 0) {
    const id = generateId();
    state.groups.push({ id, label: 'Work 1', panels: [], lspServers: [] });
  }
  if (!state.groups.find(g => g.id === state.activeGroupId)) {
    state.activeGroupId = state.groups[0].id;
  }

  saveState();
  renderSidebar();
  renderPanelStrip();
}

function renameGroup(groupId, newLabel) {
  const group = state.groups.find(g => g.id === groupId);
  if (group && newLabel.trim()) {
    group.label = newLabel.trim();
    saveState();
    renderSidebar();
  }
}

function selectGroup(groupId) {
  if (state.activeGroupId === groupId) return;
  setFocusedPanel(null);
  state.activeGroupId = groupId;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function killGroupTerminals(group) {
  group.panels.forEach(p => {
    if (p.type === 'terminal' && activeTerminals.has(p.id)) {
      const { cleanup } = activeTerminals.get(p.id);
      if (cleanup) cleanup();
    }
    if (p.type === 'file' && activeEditors.has(p.id)) {
      const { dispose } = activeEditors.get(p.id);
      if (dispose) dispose();
    }
  });
}

// ── Panel operations ──────────────────────────────

async function addPanel(type) {
  const group = getActiveGroup();
  if (!group) return;

  const maxLimits = { terminal: MAX_TERMINAL_PANELS, web: MAX_WEB_PANELS, file: MAX_FILE_PANELS };
  const maxForType = maxLimits[type];
  const globalCount = state.groups.flatMap(g => g.panels).filter(p => p.type === type).length;
  if (maxForType && globalCount >= maxForType) return;

  let extraProps = {};
  if (type === 'web') {
    extraProps = { url: '' };
  } else if (type === 'file') {
    const result = await window.electronAPI.openDirectory();
    if (result.cancelled) return;
    extraProps = { rootDir: result.path, openFile: null };
  }

  const widths = { terminal: DEFAULT_TERM_WIDTH, web: DEFAULT_WEB_WIDTH, file: DEFAULT_FILE_WIDTH };
  const panel = {
    id: generateId(),
    type,
    width: widths[type] || DEFAULT_WEB_WIDTH,
    ...extraProps,
  };

  group.panels.push(panel);

  // Surgically insert into cached DOM to avoid destroying existing terminals
  const cached = getCachedContainer(state.activeGroupId);
  if (cached) {
    const addControls = cached.querySelector('.add-panel-controls');
    if (addControls) {
      // Insert new panel element + resize handle before the add-controls div
      const panelEl = createPanelElement(panel);
      const resizeHandle = createResizeHandle(panel.id);
      cached.insertBefore(panelEl, addControls);
      cached.insertBefore(resizeHandle, addControls);
      renderStatusBar();
    } else {
      // Was showing empty state — rebuild entirely
      removeCachedGroup(state.activeGroupId);
      renderPanelStrip();
    }
  } else {
    renderPanelStrip();
  }

  saveState();
}

function addWebPanelAt(url, insertIndex) {
  const group = getActiveGroup();
  if (!group) return;

  const globalWebCount = state.groups.flatMap(g => g.panels).filter(p => p.type === 'web').length;
  if (globalWebCount >= MAX_WEB_PANELS) return;

  const panel = {
    id: generateId(),
    type: 'web',
    width: DEFAULT_WEB_WIDTH,
    url: url || '',
  };

  const idx = Math.max(0, Math.min(insertIndex, group.panels.length));
  group.panels.splice(idx, 0, panel);

  const cached = getCachedContainer(state.activeGroupId);
  if (cached) {
    const panelEls = cached.querySelectorAll('.panel');
    const addControls = cached.querySelector('.add-panel-controls');
    const panelEl = createPanelElement(panel);
    const resizeHandle = createResizeHandle(panel.id);

    if (idx < panelEls.length) {
      cached.insertBefore(panelEl, panelEls[idx]);
      cached.insertBefore(resizeHandle, panelEls[idx]);
    } else if (addControls) {
      cached.insertBefore(panelEl, addControls);
      cached.insertBefore(resizeHandle, addControls);
    } else {
      removeCachedGroup(state.activeGroupId);
      renderPanelStrip();
      saveState();
      return;
    }
    renderStatusBar();
  } else {
    renderPanelStrip();
  }

  saveState();
}

function addWebPanelAfter(sourcePanelId, url) {
  const group = getActiveGroup();
  if (!group) return;
  const sourceIndex = group.panels.findIndex(p => p.id === sourcePanelId);
  if (sourceIndex === -1) {
    addWebPanelAt(url, group.panels.length);
  } else {
    addWebPanelAt(url, sourceIndex + 1);
  }
}

function addWebPanelAtEnd(url) {
  const group = getActiveGroup();
  if (!group) return;
  addWebPanelAt(url, group.panels.length);
}

function removePanel(panelId) {
  const group = getActiveGroup();
  if (!group) return;

  destroyPanelSearch(panelId);
  if (focusedPanelId === panelId) focusedPanelId = null;

  if (activeTerminals.has(panelId)) {
    const { cleanup } = activeTerminals.get(panelId);
    if (cleanup) cleanup();
  }
  if (activeEditors.has(panelId)) {
    const { dispose } = activeEditors.get(panelId);
    if (dispose) dispose();
  }

  group.panels = group.panels.filter(p => p.id !== panelId);

  // Surgically remove from cached DOM to avoid destroying existing terminals
  const cached = getCachedContainer(state.activeGroupId);
  if (cached && group.panels.length > 0) {
    const panelEl = cached.querySelector(`[data-panel-id="${panelId}"]`);
    if (panelEl) {
      // Remove the adjacent resize handle (next sibling)
      const resizeHandle = panelEl.nextElementSibling;
      if (resizeHandle && resizeHandle.classList.contains('resize-handle')) {
        resizeHandle.remove();
      }
      panelEl.remove();
    }
    renderStatusBar();
  } else {
    // Group is empty or no cache — rebuild
    removeCachedGroup(state.activeGroupId);
    renderPanelStrip();
  }

  saveState();
}

function updatePanelUrl(panelId, url) {
  const group = getActiveGroup();
  if (!group) return;
  const panel = group.panels.find(p => p.id === panelId);
  if (panel) { panel.url = url; saveState(); }
}

function updatePanelWidth(panelId, width) {
  const group = getActiveGroup();
  if (!group) return;
  const panel = group.panels.find(p => p.id === panelId);
  if (panel) panel.width = Math.max(300, Math.round(width));
}

function applyPanelSettings(panelId, newSettings) {
  const group = getActiveGroup();
  if (!group) return;
  const panel = group.panels.find(p => p.id === panelId);
  if (!panel) return;

  if (panel.type === 'terminal') {
    const cwdChanged = (newSettings.cwd || '') !== (panel.cwd || '');
    const cmdChanged = (newSettings.initialCommand || '') !== (panel.initialCommand || '');
    panel.cwd = newSettings.cwd || '';
    panel.initialCommand = newSettings.initialCommand || '';
    if (cwdChanged || cmdChanged) {
      rebuildTerminalPanel(panelId, panel);
    }
  } else if (panel.type === 'web') {
    const urlChanged = (newSettings.url || '') !== (panel.url || '');
    if (urlChanged && newSettings.url) {
      navigateWebPanel(panelId, newSettings.url);
    }
  } else if (panel.type === 'file') {
    const dirChanged = (newSettings.rootDir || '') !== (panel.rootDir || '');
    panel.rootDir = newSettings.rootDir || '';
    if (dirChanged) {
      panel.openFile = null;
      rebuildFilePanel(panelId, panel);
    }
  }

  saveState();
}

function rebuildTerminalPanel(panelId, panel) {
  // Kill existing PTY
  if (activeTerminals.has(panelId)) {
    const { cleanup } = activeTerminals.get(panelId);
    if (cleanup) cleanup();
  }

  const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
  if (!panelEl) return;
  const content = panelEl.querySelector('.panel-content');
  if (!content) return;
  content.innerHTML = '';
  renderTermPanel(panel, content);
}

function navigateWebPanel(panelId, url) {
  let normalizedUrl = url.trim();
  if (!normalizedUrl) return;
  if (!/^[a-z][a-z\d+\-.]*:/i.test(normalizedUrl)) {
    if (/^[\w-]+(\.[\w-]+)+/.test(normalizedUrl) && !normalizedUrl.includes(' ')) {
      normalizedUrl = 'https://' + normalizedUrl;
    } else {
      normalizedUrl = 'https://www.google.com/search?q=' + encodeURIComponent(normalizedUrl);
    }
  }

  const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
  if (!panelEl) return;
  const webview = panelEl.querySelector('webview');
  if (webview) {
    webview.src = normalizedUrl;
  }
  const urlInput = panelEl.querySelector('.url-input');
  if (urlInput) {
    urlInput.value = normalizedUrl;
  }
  // State is updated by the did-navigate handler on the webview
}

function rebuildFilePanel(panelId, panel) {
  // Dispose active editor
  if (activeEditors.has(panelId)) {
    const { dispose } = activeEditors.get(panelId);
    if (dispose) dispose();
  }

  const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
  if (!panelEl) return;
  const content = panelEl.querySelector('.panel-content');
  if (!content) return;
  content.innerHTML = '';
  renderFilePanel(panel, content);
}

function addToUrlHistory(url, title) {
  if (!url || url === 'about:blank' || url.startsWith('data:')) return;
  const idx = state.urlHistory.findIndex(e => e.url === url);
  if (idx !== -1) {
    const entry = state.urlHistory[idx];
    entry.count = Math.min((entry.count || 1) + 1, MAX_URL_COUNT);
    entry.lastAccessed = Date.now();
    if (title) entry.title = title;
    state.urlHistory.splice(idx, 1);
    state.urlHistory.unshift(entry);
  } else {
    state.urlHistory.unshift({ url, title: title || '', timestamp: Date.now(), count: 1, lastAccessed: Date.now() });
  }
  if (state.urlHistory.length > MAX_URL_HISTORY) {
    state.urlHistory = state.urlHistory.slice(0, MAX_URL_HISTORY);
  }
  saveState();
}

function getFilteredUrlHistory(query) {
  applyUrlHistoryDecay();
  const q = (query || '').toLowerCase().trim();
  let results = state.urlHistory;
  if (q) {
    results = results.filter(e => e.url.toLowerCase().includes(q) || (e.title && e.title.toLowerCase().includes(q)));
  }
  return results.slice().sort((a, b) => {
    const cd = (b.count || 1) - (a.count || 1);
    if (cd !== 0) return cd;
    return (b.lastAccessed || b.timestamp || 0) - (a.lastAccessed || a.timestamp || 0);
  }).slice(0, 10);
}

let lastDecayCheck = 0;

function applyUrlHistoryDecay() {
  const now = Date.now();
  if (now - lastDecayCheck < 60000) return;
  lastDecayCheck = now;
  let changed = false;
  state.urlHistory = state.urlHistory.filter(entry => {
    const lastAccessed = entry.lastAccessed || entry.timestamp || 0;
    const weeks = Math.floor((now - lastAccessed) / URL_DECAY_INTERVAL_MS);
    if (weeks > 0) {
      const newCount = (entry.count || 1) - weeks;
      if (newCount <= 0) { changed = true; return false; }
      if (newCount !== (entry.count || 1)) { entry.count = newCount; changed = true; }
    }
    return true;
  });
  if (changed) saveState();
}

// ── Global Cmd+F / Ctrl+F handler ────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    if (!focusedPanelId) return; // let browser default

    // Check panel type - let Monaco handle its own find
    const group = getActiveGroup();
    if (group) {
      const panel = group.panels.find(p => p.id === focusedPanelId);
      if (panel && panel.type === 'file') return; // Monaco handles natively
    }

    e.preventDefault();
    showPanelSearch(focusedPanelId);
  }
});

// ── Global Cmd+R / Ctrl+R handler ────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    if (!focusedPanelId) return;
    const group = getActiveGroup();
    if (!group) return;
    const panel = group.panels.find(p => p.id === focusedPanelId);
    if (!panel || panel.type !== 'web') return;
    const panelEl = document.querySelector(`[data-panel-id="${focusedPanelId}"]`);
    if (panelEl) {
      const refreshBtn = panelEl.querySelector('.nav-btn[title="Refresh"]');
      if (refreshBtn) refreshBtn.click();
    }
  }
});

document.addEventListener('DOMContentLoaded', init);
