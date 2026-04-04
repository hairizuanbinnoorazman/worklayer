// panel-limit-modal.js - Notification popup when panel limit is reached

function showPanelLimitNotification(type, limit) {
  if (document.querySelector('.panel-limit-overlay')) return;

  if (limit == null) {
    const limits = { terminal: MAX_TERMINAL_PANELS, web: MAX_WEB_PANELS, file: MAX_FILE_PANELS };
    limit = limits[type] || '?';
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay panel-limit-overlay';

  const container = document.createElement('div');
  container.className = 'modal-container';
  container.style.width = '380px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.textContent = 'Panel Limit Reached';
  container.appendChild(header);

  const message = document.createElement('div');
  message.style.fontSize = '13px';
  message.style.color = '#bbb';
  message.style.lineHeight = '1.5';
  message.textContent = `You\u2019ve reached the maximum of ${limit} ${type} panels. Close an existing ${type} panel to add a new one.`;
  container.appendChild(message);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const okBtn = document.createElement('button');
  okBtn.className = 'modal-btn modal-btn-create';
  okBtn.textContent = 'OK';

  footer.appendChild(okBtn);
  container.appendChild(footer);
  overlay.appendChild(container);

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      dismiss();
    }
  }

  okBtn.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  okBtn.focus();
}
