// profile-settings-modal.js - Per-profile panel limit settings

function showProfileSettingsModal(profile) {
  if (!profile) return;
  if (document.querySelector('.profile-settings-overlay')) return;

  const maxPanels = getProfileMaxPanels(profile);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-settings-overlay';

  const container = document.createElement('div');
  container.className = 'modal-container';
  container.style.width = '420px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.textContent = 'Profile Settings';
  container.appendChild(header);

  const fields = [
    { key: 'terminal', label: 'Max Terminal Panels' },
    { key: 'web', label: 'Max Web Panels' },
    { key: 'file', label: 'Max File Panels' },
  ];

  const inputs = {};

  for (const { key, label } of fields) {
    const field = document.createElement('div');
    field.className = 'modal-field';

    const lbl = document.createElement('label');
    lbl.className = 'modal-label';
    lbl.textContent = label;

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'number';
    input.min = '0';
    input.max = '50';
    input.value = maxPanels[key];
    inputs[key] = input;

    field.appendChild(lbl);
    field.appendChild(input);
    container.appendChild(field);
  }

  // ── PDF interception toggle ──
  const pdfField = document.createElement('div');
  pdfField.className = 'modal-field';
  pdfField.style.flexDirection = 'row';
  pdfField.style.alignItems = 'center';
  pdfField.style.gap = '8px';

  const pdfCheckbox = document.createElement('input');
  pdfCheckbox.type = 'checkbox';
  pdfCheckbox.id = 'intercept-pdf-checkbox';
  pdfCheckbox.checked = getProfileInterceptPdf(profile);

  const pdfLabel = document.createElement('label');
  pdfLabel.className = 'modal-label';
  pdfLabel.setAttribute('for', 'intercept-pdf-checkbox');
  pdfLabel.textContent = 'Open PDFs in panel';
  pdfLabel.style.marginBottom = '0';

  pdfField.appendChild(pdfCheckbox);
  pdfField.appendChild(pdfLabel);
  container.appendChild(pdfField);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn modal-btn-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn modal-btn-create';
  saveBtn.textContent = 'Save';

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  container.appendChild(footer);
  overlay.appendChild(container);

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
  }

  function save() {
    const newMaxPanels = {};
    for (const { key } of fields) {
      const val = parseInt(inputs[key].value, 10);
      newMaxPanels[key] = isNaN(val) ? maxPanels[key] : Math.max(0, Math.min(50, val));
    }
    profile.maxPanels = newMaxPanels;
    profile.interceptPdf = pdfCheckbox.checked;
    saveState();
    renderStatusBar();
    dismiss();
  }

  cancelBtn.addEventListener('click', dismiss);
  saveBtn.addEventListener('click', save);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  inputs.terminal.focus();
  inputs.terminal.select();
}
