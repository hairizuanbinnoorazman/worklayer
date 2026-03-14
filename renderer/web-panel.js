// web-panel.js - Web panel with webview

function renderWebPanel(panel, container) {
  const urlBar = document.createElement('div');
  urlBar.className = 'url-bar';

  const backBtn = document.createElement('button');
  backBtn.className = 'nav-btn';
  backBtn.textContent = '←';
  backBtn.title = 'Back';

  const forwardBtn = document.createElement('button');
  forwardBtn.className = 'nav-btn';
  forwardBtn.textContent = '→';
  forwardBtn.title = 'Forward';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'nav-btn';
  refreshBtn.textContent = '↻';
  refreshBtn.title = 'Refresh';

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'url-input';
  urlInput.placeholder = 'Enter URL or search...';
  urlInput.value = panel.url || '';

  urlBar.appendChild(backBtn);
  urlBar.appendChild(forwardBtn);
  urlBar.appendChild(refreshBtn);
  urlBar.appendChild(urlInput);
  container.appendChild(urlBar);

  const webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.src = panel.url || 'about:blank';
  container.appendChild(webview);

  const navigate = (raw) => {
    let url = raw.trim();
    if (!url) return;
    if (!/^[a-z][a-z\d+\-.]*:/i.test(url)) {
      // Treat as URL if it looks like a domain, else search
      if (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }
    webview.src = url;
    urlInput.value = url;
    updatePanelUrl(panel.id, url);
  };

  backBtn.addEventListener('click', () => webview.goBack());
  forwardBtn.addEventListener('click', () => webview.goForward());
  refreshBtn.addEventListener('click', () => webview.reload());

  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate(urlInput.value);
  });

  // Stop propagation so clicks in the URL bar don't lose focus unexpectedly
  urlInput.addEventListener('mousedown', e => e.stopPropagation());

  webview.addEventListener('did-navigate', e => {
    urlInput.value = e.url;
    updatePanelUrl(panel.id, e.url);
  });

  webview.addEventListener('did-navigate-in-page', e => {
    if (e.isMainFrame) {
      urlInput.value = e.url;
      updatePanelUrl(panel.id, e.url);
    }
  });

  webview.addEventListener('did-fail-load', e => {
    if (e.errorCode === 0 || e.errorCode === -3) return; // ignore aborted loads
    const errorPage = `
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1e1e2e; color: #cdd6f4;">
        <div style="text-align: center; max-width: 480px; padding: 2rem;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">⚠</div>
          <h2 style="margin: 0 0 0.5rem;">Failed to load page</h2>
          <p style="color: #a6adc8; margin: 0 0 1rem;">${e.validatedURL || ''}</p>
          <p style="color: #f38ba8;">${e.errorDescription || 'Unknown error'} (${e.errorCode})</p>
        </div>
      </body>
      </html>`;
    webview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage));
  });

  webview.addEventListener('page-title-updated', e => {
    // Update the panel header label with the page title
    const panelEl = webview.closest('.panel');
    if (panelEl) {
      const lbl = panelEl.querySelector('.panel-type-label');
      if (lbl) lbl.textContent = e.title || 'Web';
    }
  });
}
