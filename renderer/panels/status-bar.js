// status-bar.js - Renders panel count status bar

function renderStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const profile = getActiveProfile();
  const allPanels = profile ? profile.groups.flatMap(g => g.panels) : [];

  const maxLimits = getProfileMaxPanels(profile);
  const types = [
    { type: 'terminal', label: 'Terminal', max: maxLimits.terminal },
    { type: 'web', label: 'Web', max: maxLimits.web },
    { type: 'file', label: 'Files', max: maxLimits.file },
  ];

  const profileLabel = profile ? `<span class="status-bar-item status-bar-profile">${profile.name}</span>` : '';

  bar.innerHTML = profileLabel + types.map(({ type, label, max }) => {
    const count = allPanels.filter(p => p.type === type).length;
    if (type === 'terminal') {
      const activeCount = activeTerminals.size;
      return `<span class="status-bar-item">` +
        `<span class="status-bar-dot ${type}"></span>` +
        `${label} ${activeCount} active \u00b7 ${count} / ${max}` +
        `</span>`;
    }
    if (type === 'web') {
      const suspCount = typeof suspendedPanels !== 'undefined' ? suspendedPanels.size : 0;
      const suffix = suspCount > 0 ? ` \u00b7 ${suspCount} suspended` : '';
      return `<span class="status-bar-item">` +
        `<span class="status-bar-dot ${type}"></span>` +
        `${label} ${count} / ${max}${suffix}` +
        `</span>`;
    }
    return `<span class="status-bar-item">` +
      `<span class="status-bar-dot ${type}"></span>` +
      `${label} ${count} / ${max}` +
      `</span>`;
  }).join('');
}
