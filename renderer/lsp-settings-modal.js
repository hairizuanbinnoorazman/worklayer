// lsp-settings-modal.js - Per-workspace LSP config modal

async function showLspSettingsModal(group, panelRootDir, onApply) {
  const registry = await window.electronAPI.lspGetRegistry();
  const activeServers = await window.electronAPI.lspGetActiveServers(group.id);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const container = document.createElement('div');
  container.className = 'modal-container';
  container.style.width = '420px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.textContent = 'LSP Servers';
  container.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.style.fontSize = '11px';
  subtitle.style.color = '#778';
  subtitle.style.marginBottom = '6px';
  subtitle.textContent = `Root: ${panelRootDir || 'none'}`;
  container.appendChild(subtitle);

  const serverList = document.createElement('div');
  serverList.style.display = 'flex';
  serverList.style.flexDirection = 'column';
  serverList.style.gap = '8px';

  const toggleStates = {};
  const lspConfig = group.lspServers || [];

  for (const [key, info] of Object.entries(registry)) {
    const isEnabled = lspConfig.some(s => s.serverKey === key && s.enabled);
    const activeInfo = activeServers.find(s => s.serverKey === key);
    const status = activeInfo ? activeInfo.status : 'stopped';

    toggleStates[key] = isEnabled;

    const row = document.createElement('div');
    row.className = 'lsp-server-row';

    const statusDot = document.createElement('span');
    statusDot.className = 'lsp-status-dot';
    if (status === 'running') {
      statusDot.classList.add('running');
    } else if (status === 'error') {
      statusDot.classList.add('error');
    }
    row.appendChild(statusDot);

    const nameLabel = document.createElement('span');
    nameLabel.className = 'lsp-server-name';
    nameLabel.textContent = info.name;
    row.appendChild(nameLabel);

    const langLabel = document.createElement('span');
    langLabel.className = 'lsp-server-lang';
    langLabel.textContent = info.languages.join(', ');
    row.appendChild(langLabel);

    const toggle = document.createElement('label');
    toggle.className = 'lsp-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isEnabled;
    checkbox.addEventListener('change', () => {
      toggleStates[key] = checkbox.checked;
    });
    const slider = document.createElement('span');
    slider.className = 'lsp-toggle-slider';
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);
    row.appendChild(toggle);

    serverList.appendChild(row);
  }

  container.appendChild(serverList);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn modal-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const applyBtn = document.createElement('button');
  applyBtn.className = 'modal-btn modal-btn-create';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', () => {
    // Build new lspServers config
    const newConfig = [];
    for (const [key] of Object.entries(registry)) {
      newConfig.push({ serverKey: key, enabled: toggleStates[key] });
    }
    overlay.remove();
    if (onApply) onApply(newConfig);
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  container.appendChild(footer);

  overlay.appendChild(container);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}
