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

let state = { activeProfileId: null, profiles: [] };

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

function getActiveProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || null;
}

function getActiveGroupId() {
  const profile = getActiveProfile();
  return profile ? profile.activeGroupId : null;
}

function migrateProfile(profile) {
  if (!profile.templates) profile.templates = [];
  if (!profile.urlHistory) profile.urlHistory = [];
  for (const entry of profile.urlHistory) {
    if (!entry.count) entry.count = 1;
    if (!entry.lastAccessed) entry.lastAccessed = entry.timestamp || Date.now();
  }
  for (const group of profile.groups) {
    group.lspServers = group.lspServers || [];
    for (const panel of group.panels) {
      if (panel.type === 'file' && !panel.openFiles) {
        panel.openFiles = panel.openFile ? [panel.openFile] : [];
      }
    }
  }
  if (!profile.groups.find(g => g.id === profile.activeGroupId)) {
    profile.activeGroupId = profile.groups[0]?.id || null;
  }
}

async function init() {
  const saved = await window.electronAPI.loadState();

  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0) {
    // New format
    state = saved;
    if (!state.maxCachedGroups || state.maxCachedGroups === 5) state.maxCachedGroups = 20;
    if (!state.sidebarWidth) state.sidebarWidth = 210;
    for (const profile of state.profiles) {
      migrateProfile(profile);
    }
    if (!state.profiles.find(p => p.id === state.activeProfileId)) {
      state.activeProfileId = state.profiles[0].id;
    }
  } else if (saved && Array.isArray(saved.groups) && saved.groups.length > 0) {
    // Old format — wrap into a Default profile
    const profileId = generateId();
    const profile = {
      id: profileId,
      name: 'Default',
      activeGroupId: saved.activeGroupId,
      groups: saved.groups,
      templates: saved.templates || [],
      urlHistory: saved.urlHistory || [],
    };
    migrateProfile(profile);
    state = {
      activeProfileId: profileId,
      profiles: [profile],
      maxCachedGroups: saved.maxCachedGroups || 20,
      sidebarWidth: saved.sidebarWidth || 210,
    };
  } else {
    // Fresh state
    const groupId = generateId();
    const profileId = generateId();
    state = {
      activeProfileId: profileId,
      maxCachedGroups: 20,
      sidebarWidth: 210,
      profiles: [{
        id: profileId,
        name: 'Default',
        activeGroupId: groupId,
        groups: [{ id: groupId, label: 'Work 1', panels: [], lspServers: [] }],
        templates: [],
        urlHistory: [],
      }],
    };
  }

  renderSidebar();
  document.getElementById('sidebar').style.width = state.sidebarWidth + 'px';
  renderPanelStrip();

  let windowResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(windowResizeTimer);
    windowResizeTimer = setTimeout(() => {
      const activeGroupId = getActiveGroupId();
      if (activeGroupId) {
        fitVisibleTerminals(activeGroupId);
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
  const profile = getActiveProfile();
  if (!profile) return null;
  return profile.groups.find(g => g.id === profile.activeGroupId) || null;
}

function getGroupById(groupId) {
  const profile = getActiveProfile();
  if (!profile) return null;
  return profile.groups.find(g => g.id === groupId) || null;
}

function resolveTargetGroup(targetGroupId) {
  if (targetGroupId) {
    const group = getGroupById(targetGroupId);
    if (group) return group;
  }
  return getActiveGroup();
}

// ── Group operations ──────────────────────────────

function addGroup() {
  const profile = getActiveProfile();
  if (!profile) return;
  const id = generateId();
  profile.groups.push({ id, label: `Work ${profile.groups.length + 1}`, panels: [], lspServers: [] });
  profile.activeGroupId = id;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function addGroupWithPanels(name, panelConfigs) {
  const profile = getActiveProfile();
  if (!profile) return;
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
      panel.openFiles = [];
    }
    return panel;
  });

  profile.groups.push({ id, label: name || `Work ${profile.groups.length + 1}`, panels, lspServers: [] });
  profile.activeGroupId = id;
  saveState();
  renderSidebar();
  renderPanelStrip(false);
}

function saveTemplate(name, panelConfigs) {
  const profile = getActiveProfile();
  if (!profile) return null;
  const template = {
    id: generateId(),
    name,
    panels: panelConfigs.map(config => ({ ...config })),
  };
  profile.templates.push(template);
  saveState();
  return template;
}

function deleteTemplate(templateId) {
  const profile = getActiveProfile();
  if (!profile) return;
  profile.templates = profile.templates.filter(t => t.id !== templateId);
  saveState();
}

function deleteGroup(groupId) {
  const profile = getActiveProfile();
  if (!profile) return;
  const group = profile.groups.find(g => g.id === groupId);
  if (group) killGroupTerminals(group);
  removeCachedGroup(groupId);

  profile.groups = profile.groups.filter(g => g.id !== groupId);

  if (profile.groups.length === 0) {
    const id = generateId();
    profile.groups.push({ id, label: 'Work 1', panels: [], lspServers: [] });
  }
  if (!profile.groups.find(g => g.id === profile.activeGroupId)) {
    profile.activeGroupId = profile.groups[0].id;
  }

  saveState();
  renderSidebar();
  renderPanelStrip();
}

function renameGroup(groupId, newLabel) {
  const profile = getActiveProfile();
  if (!profile) return;
  const group = profile.groups.find(g => g.id === groupId);
  if (group && newLabel.trim()) {
    group.label = newLabel.trim();
    saveState();
    renderSidebar();
  }
}

function selectGroup(groupId) {
  const profile = getActiveProfile();
  if (!profile || profile.activeGroupId === groupId) return;
  setFocusedPanel(null);
  profile.activeGroupId = groupId;
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

  const profile = getActiveProfile();
  if (!profile) return;
  const maxLimits = { terminal: MAX_TERMINAL_PANELS, web: MAX_WEB_PANELS, file: MAX_FILE_PANELS };
  const maxForType = maxLimits[type];
  const profileCount = profile.groups.flatMap(g => g.panels).filter(p => p.type === type).length;
  if (maxForType && profileCount >= maxForType) {
    showPanelLimitNotification(type);
    return;
  }

  let extraProps = {};
  if (type === 'web') {
    extraProps = { url: '' };
  } else if (type === 'file') {
    const result = await window.electronAPI.openDirectory();
    if (result.cancelled) return;
    extraProps = { rootDir: result.path, openFile: null, openFiles: [] };
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
  const activeGId = getActiveGroupId();
  const cached = getCachedContainer(activeGId);
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
      removeCachedGroup(activeGId);
      renderPanelStrip();
    }
  } else {
    renderPanelStrip();
  }

  renderSidebar();
  saveState();
}

function addWebPanelAt(url, insertIndex, targetGroupId) {
  const group = resolveTargetGroup(targetGroupId);
  if (!group) return null;

  const profile = getActiveProfile();
  if (!profile) return null;
  const profileWebCount = profile.groups.flatMap(g => g.panels).filter(p => p.type === 'web').length;
  if (profileWebCount >= MAX_WEB_PANELS) {
    showPanelLimitNotification('web');
    return null;
  }

  const panel = {
    id: generateId(),
    type: 'web',
    width: DEFAULT_WEB_WIDTH,
    url: url || '',
  };

  const idx = Math.max(0, Math.min(insertIndex, group.panels.length));
  group.panels.splice(idx, 0, panel);

  const activeGId = getActiveGroupId();
  const isActiveGroup = group.id === activeGId;

  if (isActiveGroup) {
    const cached = getCachedContainer(activeGId);
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
        removeCachedGroup(activeGId);
        renderPanelStrip();
        renderSidebar();
        saveState();
        return panel.id;
      }
      renderStatusBar();
    } else {
      renderPanelStrip();
    }
  } else {
    // Non-active group: insert into cached DOM if available
    const cached = getCachedContainer(group.id);
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
        removeCachedGroup(group.id);
      }
    }
    renderStatusBar();
  }

  renderSidebar();
  saveState();
  return panel.id;
}

function addWebPanelAfter(sourcePanelId, url, targetGroupId) {
  const group = resolveTargetGroup(targetGroupId);
  if (!group) return null;
  const sourceIndex = group.panels.findIndex(p => p.id === sourcePanelId);
  if (sourceIndex === -1) {
    return addWebPanelAt(url, group.panels.length, targetGroupId);
  } else {
    return addWebPanelAt(url, sourceIndex + 1, targetGroupId);
  }
}

function addWebPanelAtEnd(url, targetGroupId) {
  const group = resolveTargetGroup(targetGroupId);
  if (!group) return null;
  return addWebPanelAt(url, group.panels.length, targetGroupId);
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
  const activeGId = getActiveGroupId();
  const cached = getCachedContainer(activeGId);
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
    removeCachedGroup(activeGId);
    renderPanelStrip();
  }

  renderSidebar();
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
      panel.openFiles = [];
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
    let navAttempt = 0;
    const maxNavRetries = 2;
    function tryNav() {
      webview.loadURL(normalizedUrl).catch(err => {
        if (err && err.message && err.message.includes('ERR_ABORTED')) return;
        navAttempt++;
        if (navAttempt <= maxNavRetries) {
          console.log(`[navigateWebPanel] retry ${navAttempt}/${maxNavRetries} url=${normalizedUrl} error=${err.message}`);
          setTimeout(tryNav, 500);
        } else {
          console.log(`[navigateWebPanel] loadURL failed panelId=${panelId} url=${normalizedUrl} error=${err.message}`);
          webview.dispatchEvent(new CustomEvent('loadurl-error', {
            detail: { url: normalizedUrl, message: err.message }
          }));
        }
      });
    }
    tryNav();
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
  const profile = getActiveProfile();
  if (!profile) return;
  const idx = profile.urlHistory.findIndex(e => e.url === url);
  if (idx !== -1) {
    const entry = profile.urlHistory[idx];
    entry.count = Math.min((entry.count || 1) + 1, MAX_URL_COUNT);
    entry.lastAccessed = Date.now();
    if (title) entry.title = title;
    profile.urlHistory.splice(idx, 1);
    profile.urlHistory.unshift(entry);
  } else {
    profile.urlHistory.unshift({ url, title: title || '', timestamp: Date.now(), count: 1, lastAccessed: Date.now() });
  }
  if (profile.urlHistory.length > MAX_URL_HISTORY) {
    profile.urlHistory = profile.urlHistory.slice(0, MAX_URL_HISTORY);
  }
  saveState();
}

function getFilteredUrlHistory(query) {
  applyUrlHistoryDecay();
  const profile = getActiveProfile();
  if (!profile) return [];
  const q = (query || '').toLowerCase().trim();
  let results = profile.urlHistory;
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
  const profile = getActiveProfile();
  if (!profile) return;
  let changed = false;
  profile.urlHistory = profile.urlHistory.filter(entry => {
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

// ── Profile operations ────────────────────────────

function teardownCurrentProfile() {
  const profile = getActiveProfile();
  if (!profile) return;

  // Kill all terminals and editors in every group of the current profile
  for (const group of profile.groups) {
    killGroupTerminals(group);
  }

  // Clear DOM cache
  groupDOMCache.forEach((el) => el.remove());
  groupDOMCache.clear();
  lruOrder.length = 0;

  // Clear active maps
  activeTerminals.clear();
  activeEditors.clear();
  activeLspServers.clear();

  // Destroy all panel searches
  for (const [panelId] of activePanelSearches) {
    destroyPanelSearch(panelId);
  }

  // Clear webview registry
  webviewRegistry.clear();

  // Disconnect LSP
  if (typeof disconnectAllLsp === 'function') disconnectAllLsp();

  // Reset focus
  setFocusedPanel(null);
}

function addProfile(name) {
  const groupId = generateId();
  const profileId = generateId();
  const profile = {
    id: profileId,
    name: name || 'New Profile',
    activeGroupId: groupId,
    groups: [{ id: groupId, label: 'Work 1', panels: [], lspServers: [] }],
    templates: [],
    urlHistory: [],
  };

  teardownCurrentProfile();
  state.profiles.push(profile);
  state.activeProfileId = profileId;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function switchProfile(profileId) {
  if (state.activeProfileId === profileId) return;
  if (!state.profiles.find(p => p.id === profileId)) return;

  teardownCurrentProfile();
  state.activeProfileId = profileId;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function renameProfile(profileId, newName) {
  const profile = state.profiles.find(p => p.id === profileId);
  if (profile && newName.trim()) {
    profile.name = newName.trim();
    saveState();
    renderSidebar();
  }
}

function deleteProfile(profileId) {
  if (state.profiles.length <= 1) return;
  const profile = state.profiles.find(p => p.id === profileId);
  if (!profile) return;

  // If deleting active profile, switch to another first
  if (state.activeProfileId === profileId) {
    const other = state.profiles.find(p => p.id !== profileId);
    if (other) switchProfile(other.id);
  }

  // Now teardown and remove
  for (const group of profile.groups) {
    killGroupTerminals(group);
    removeCachedGroup(group.id);
  }
  state.profiles = state.profiles.filter(p => p.id !== profileId);
  saveState();
  renderSidebar();
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
