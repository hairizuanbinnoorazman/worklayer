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

  webview.addEventListener('page-title-updated', e => {
    // Update the panel header label with the page title
    const panelEl = webview.closest('.panel');
    if (panelEl) {
      const lbl = panelEl.querySelector('.panel-type-label');
      if (lbl) lbl.textContent = e.title || 'Web';
    }
  });
}
