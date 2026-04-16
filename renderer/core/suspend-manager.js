// suspend-manager.js - Auto-suspend inactive web panels to save resources

const suspendTimers = new Map();   // panelId -> timeoutId
const suspendedPanels = new Map(); // panelId -> { url, title }

function getSuspendTimeoutMs() {
  const profile = getActiveProfile();
  const minutes = profile ? (profile.suspendTimeoutMinutes ?? 30) : 30;
  if (minutes <= 0) return Infinity;
  return minutes * 60 * 1000;
}

function startSuspendTimer(panelId) {
  clearSuspendTimer(panelId);
  if (isSuspended(panelId)) return;
  if (panelId === focusedPanelId) return;
  const ms = getSuspendTimeoutMs();
  if (!isFinite(ms)) return;
  const id = setTimeout(() => {
    suspendTimers.delete(panelId);
    suspendPanel(panelId);
  }, ms);
  suspendTimers.set(panelId, id);
}

function resetSuspendTimer(panelId) {
  if (isSuspended(panelId)) return;
  startSuspendTimer(panelId);
}

function clearSuspendTimer(panelId) {
  const id = suspendTimers.get(panelId);
  if (id !== undefined) {
    clearTimeout(id);
    suspendTimers.delete(panelId);
  }
}

function clearAllSuspendTimers() {
  for (const [, id] of suspendTimers) clearTimeout(id);
  suspendTimers.clear();
}

function suspendPanel(panelId) {
  if (isSuspended(panelId)) return;
  const entry = activeWebPanels.get(panelId);
  if (!entry || !entry.suspend) return;
  entry.suspend();
  renderStatusBar();
}

function resumePanel(panelId) {
  if (!isSuspended(panelId)) return;
  const entry = activeWebPanels.get(panelId);
  if (!entry || !entry.resume) return;
  const saved = suspendedPanels.get(panelId);
  suspendedPanels.delete(panelId);
  entry.resume(saved ? saved.url : '');
  startSuspendTimer(panelId);
  renderStatusBar();
}

function isSuspended(panelId) {
  return suspendedPanels.has(panelId);
}

function resetTimersForGroup(groupId) {
  const profile = getActiveProfile();
  if (!profile) return;
  const group = profile.groups.find(g => g.id === groupId);
  if (!group) return;
  for (const panel of group.panels) {
    if (panel.type === 'web' && !isSuspended(panel.id)) {
      startSuspendTimer(panel.id);
    }
  }
}
