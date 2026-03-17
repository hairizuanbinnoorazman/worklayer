// status-bar.js - Renders panel count status bar

function renderStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const allPanels = state.groups.flatMap(g => g.panels);

  const types = [
    { type: 'terminal', label: 'Terminal', max: MAX_TERMINAL_PANELS },
    { type: 'web', label: 'Web', max: MAX_WEB_PANELS },
    { type: 'file', label: 'Files', max: MAX_FILE_PANELS },
  ];

  bar.innerHTML = types.map(({ type, label, max }) => {
    const count = allPanels.filter(p => p.type === type).length;
    if (type === 'terminal') {
      const activeCount = activeTerminals.size;
      return `<span class="status-bar-item">` +
        `<span class="status-bar-dot ${type}"></span>` +
        `${label} ${activeCount} active · ${count} / ${max}` +
        `</span>`;
    }
    return `<span class="status-bar-item">` +
      `<span class="status-bar-dot ${type}"></span>` +
      `${label} ${count} / ${max}` +
      `</span>`;
  }).join('');
}
