// app.js - State management and core operations

const DEFAULT_WEB_WIDTH = 750;
const DEFAULT_TERM_WIDTH = 620;
const DEFAULT_FILE_WIDTH = 900;

let state = { activeGroupId: null, groups: [] };

// Map<panelId, { terminal, fitAddon, cleanup, termId }>
const activeTerminals = new Map();

// Map<panelId, { editor, dispose }>
const activeEditors = new Map();

let saveDebounceTimer = null;

async function init() {
  const saved = await window.electronAPI.loadState();
  if (saved && Array.isArray(saved.groups) && saved.groups.length > 0) {
    state = saved;
    if (!state.maxCachedGroups) state.maxCachedGroups = 5;
    if (!state.groups.find(g => g.id === state.activeGroupId)) {
      state.activeGroupId = state.groups[0].id;
    }
  } else {
    const id = generateId();
    state = {
      activeGroupId: id,
      maxCachedGroups: 5,
      groups: [{ id, label: 'Work 1', panels: [] }],
    };
  }

  renderSidebar();
  renderPanelStrip();
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
  state.groups.push({ id, label: `Work ${state.groups.length + 1}`, panels: [] });
  state.activeGroupId = id;
  saveState();
  renderSidebar();
  renderPanelStrip();
}

function deleteGroup(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (group) killGroupTerminals(group);
  removeCachedGroup(groupId);

  state.groups = state.groups.filter(g => g.id !== groupId);

  if (state.groups.length === 0) {
    const id = generateId();
    state.groups.push({ id, label: 'Work 1', panels: [] });
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

function removePanel(panelId) {
  const group = getActiveGroup();
  if (!group) return;

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

document.addEventListener('DOMContentLoaded', init);
