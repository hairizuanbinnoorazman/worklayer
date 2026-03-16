// auth-modal.js - HTTP Basic Auth dialog for webview login events

(function () {
  window.electronAPI.onAuthLoginRequest((data) => {
    const { requestId, host, port, realm, isProxy } = data;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const container = document.createElement('div');
    container.className = 'modal-container';
    container.style.width = '380px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = isProxy ? 'Proxy Authentication' : 'Authentication Required';
    container.appendChild(header);

    const info = document.createElement('div');
    info.className = 'auth-modal-info';
    const hostLabel = document.createElement('div');
    hostLabel.className = 'auth-modal-host';
    hostLabel.textContent = port ? `${host}:${port}` : host;
    info.appendChild(hostLabel);
    if (realm) {
      const realmLabel = document.createElement('div');
      realmLabel.className = 'auth-modal-realm';
      realmLabel.textContent = realm;
      info.appendChild(realmLabel);
    }
    container.appendChild(info);

    const userField = document.createElement('div');
    userField.className = 'modal-field';
    const userLabel = document.createElement('label');
    userLabel.className = 'modal-label';
    userLabel.textContent = 'Username';
    const userInput = document.createElement('input');
    userInput.className = 'modal-input';
    userInput.type = 'text';
    userInput.autocomplete = 'username';
    userField.appendChild(userLabel);
    userField.appendChild(userInput);
    container.appendChild(userField);

    const passField = document.createElement('div');
    passField.className = 'modal-field';
    const passLabel = document.createElement('label');
    passLabel.className = 'modal-label';
    passLabel.textContent = 'Password';
    const passInput = document.createElement('input');
    passInput.className = 'modal-input';
    passInput.type = 'password';
    passInput.autocomplete = 'current-password';
    passField.appendChild(passLabel);
    passField.appendChild(passInput);
    container.appendChild(passField);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-btn-cancel';
    cancelBtn.textContent = 'Cancel';

    const loginBtn = document.createElement('button');
    loginBtn.className = 'modal-btn modal-btn-create';
    loginBtn.textContent = 'Log In';

    footer.appendChild(cancelBtn);
    footer.appendChild(loginBtn);
    container.appendChild(footer);

    overlay.appendChild(container);

    function submit() {
      window.electronAPI.authLoginResponse(requestId, userInput.value, passInput.value, false);
      overlay.remove();
    }

    function cancel() {
      window.electronAPI.authLoginResponse(requestId, '', '', true);
      overlay.remove();
    }

    loginBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', cancel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cancel();
    });

    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') passInput.focus();
      if (e.key === 'Escape') cancel();
    });
    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') cancel();
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => userInput.focus());
  });
})();
