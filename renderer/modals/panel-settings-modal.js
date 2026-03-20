// panel-settings-modal.js - Per-panel settings modal

function createSettingsTextField(placeholder, value, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input modal-field-input';
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function createSettingsFieldWithBrowse(placeholder, value, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-browse-field';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input modal-field-input';
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));

  const browseBtn = document.createElement('button');
  browseBtn.className = 'modal-btn modal-btn-browse';
  browseBtn.textContent = '...';
  browseBtn.title = 'Browse';
  browseBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.openDirectory();
    if (!result.cancelled) {
      input.value = result.path;
      onChange(result.path);
    }
  });

  wrapper.appendChild(input);
  wrapper.appendChild(browseBtn);
  return wrapper;
}

function showPanelSettingsModal(panel) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const container = document.createElement('div');
  container.className = 'modal-container';
  container.style.width = '460px';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const typeNames = { terminal: 'Terminal', web: 'Web', file: 'File' };
  header.textContent = (typeNames[panel.type] || 'Panel') + ' Settings';
  container.appendChild(header);

  // Track new settings
  const newSettings = {};

  // Type-specific fields
  const fieldsSection = document.createElement('div');
  fieldsSection.style.display = 'flex';
  fieldsSection.style.flexDirection = 'column';
  fieldsSection.style.gap = '10px';

  if (panel.type === 'terminal') {
    const cwdLabel = document.createElement('label');
    cwdLabel.className = 'modal-label';
    cwdLabel.textContent = 'Working Directory';
    fieldsSection.appendChild(cwdLabel);

    newSettings.cwd = panel.cwd || '';
    const cwdField = createSettingsFieldWithBrowse('Directory', panel.cwd || '', val => {
      newSettings.cwd = val;
    });
    fieldsSection.appendChild(cwdField);

    const cmdLabel = document.createElement('label');
    cmdLabel.className = 'modal-label';
    cmdLabel.textContent = 'Startup Command';
    fieldsSection.appendChild(cmdLabel);

    newSettings.initialCommand = panel.initialCommand || '';
    const cmdField = createSettingsTextField('Startup command', panel.initialCommand || '', val => {
      newSettings.initialCommand = val;
    });
    fieldsSection.appendChild(cmdField);
  } else if (panel.type === 'web') {
    const urlLabel = document.createElement('label');
    urlLabel.className = 'modal-label';
    urlLabel.textContent = 'URL';
    fieldsSection.appendChild(urlLabel);

    newSettings.url = panel.url || '';
    const urlField = createSettingsTextField('URL', panel.url || '', val => {
      newSettings.url = val;
    });
    fieldsSection.appendChild(urlField);
  } else if (panel.type === 'file') {
    const dirLabel = document.createElement('label');
    dirLabel.className = 'modal-label';
    dirLabel.textContent = 'Root Directory';
    fieldsSection.appendChild(dirLabel);

    newSettings.rootDir = panel.rootDir || '';
    const dirField = createSettingsFieldWithBrowse('Root directory', panel.rootDir || '', val => {
      newSettings.rootDir = val;
    });
    fieldsSection.appendChild(dirField);
  }

  container.appendChild(fieldsSection);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn modal-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn modal-btn-create';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    applyPanelSettings(panel.id, newSettings);
    overlay.remove();
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  container.appendChild(footer);

  overlay.appendChild(container);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}
