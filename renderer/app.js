// app.js - State management and core operations

const DEFAULT_WEB_WIDTH = 750;
const DEFAULT_TERM_WIDTH = 620;

let state = { activeGroupId: null, groups: [] };

// Map<panelId, { terminal, fitAddon, cleanup, termId }>
const activeTerminals = new Map();

let saveDebounceTimer = null;

async function init() {
  const saved = await window.electronAPI.loadState();
  if (saved && Array.isArray(saved.groups) && saved.groups.length > 0) {
    state = saved;
    if (!state.groups.find(g => g.id === state.activeGroupId)) {
      state.activeGroupId = state.groups[0].id;
    }
  } else {
    const id = generateId();
    state = {
      activeGroupId: id,
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
  });
}

// ── Panel operations ──────────────────────────────

function addPanel(type) {
  const group = getActiveGroup();
  if (!group) return;

  const panel = {
    id: generateId(),
    type,
    width: type === 'terminal' ? DEFAULT_TERM_WIDTH : DEFAULT_WEB_WIDTH,
    ...(type === 'web' ? { url: '' } : {}),
  };

  group.panels.push(panel);
  saveState();
  renderPanelStrip();
}

function removePanel(panelId) {
  const group = getActiveGroup();
  if (!group) return;

  if (activeTerminals.has(panelId)) {
    const { cleanup } = activeTerminals.get(panelId);
    if (cleanup) cleanup();
  }

  group.panels = group.panels.filter(p => p.id !== panelId);
  saveState();
  renderPanelStrip();
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
