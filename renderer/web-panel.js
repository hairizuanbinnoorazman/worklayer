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

  const urlInputWrapper = document.createElement('div');
  urlInputWrapper.className = 'url-input-wrapper';

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'url-input';
  urlInput.placeholder = 'Enter URL or search...';
  urlInput.value = panel.url || '';

  const dropdown = document.createElement('div');
  dropdown.className = 'url-history-dropdown';

  urlInputWrapper.appendChild(urlInput);
  urlInputWrapper.appendChild(dropdown);

  urlBar.appendChild(backBtn);
  urlBar.appendChild(forwardBtn);
  urlBar.appendChild(refreshBtn);
  urlBar.appendChild(urlInputWrapper);
  container.appendChild(urlBar);

  let selectedIndex = -1;

  function showDropdown(query) {
    const items = getFilteredUrlHistory(query);
    if (items.length === 0) {
      hideDropdown();
      return;
    }
    selectedIndex = -1;
    dropdown.innerHTML = '';
    items.forEach((entry, i) => {
      const item = document.createElement('div');
      item.className = 'url-history-item';
      item.dataset.index = i;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'url-history-title';
      titleSpan.textContent = entry.title || entry.url;

      const urlSpan = document.createElement('span');
      urlSpan.className = 'url-history-url';
      urlSpan.textContent = entry.url;

      item.appendChild(titleSpan);
      item.appendChild(urlSpan);

      item.addEventListener('mousedown', e => {
        e.preventDefault();
        urlInput.value = entry.url;
        hideDropdown();
        navigate(urlInput.value);
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.add('visible');
  }

  function hideDropdown() {
    dropdown.classList.remove('visible');
    selectedIndex = -1;
  }

  function updateSelection() {
    const items = dropdown.querySelectorAll('.url-history-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === selectedIndex);
      if (i === selectedIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  const webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('partition', 'persist:webpanels');
  webview.src = panel.url || 'about:blank';
  container.appendChild(webview);

  console.log(`[WebPanel] Created webview panel=${panel.id} url=${panel.url || 'about:blank'} partition=persist:webpanels`);

  const navigate = (raw) => {
    let url = raw.trim();
    if (!url) return;
    if (!/^[a-z][a-z\d+\-.]*:/i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }
    webview.src = url;
    urlInput.value = url;
    updatePanelUrl(panel.id, url);
    addToUrlHistory(url, '');
  };

  backBtn.addEventListener('click', () => webview.goBack());
  forwardBtn.addEventListener('click', () => webview.goForward());
  refreshBtn.addEventListener('click', () => webview.reload());

  urlInput.addEventListener('focus', () => {
    showDropdown(urlInput.value);
  });

  urlInput.addEventListener('input', () => {
    showDropdown(urlInput.value);
  });

  urlInput.addEventListener('blur', () => {
    setTimeout(() => hideDropdown(), 150);
  });

  urlInput.addEventListener('keydown', e => {
    const isDropdownVisible = dropdown.classList.contains('visible');
    const items = dropdown.querySelectorAll('.url-history-item');

    if (e.key === 'ArrowDown' && isDropdownVisible && items.length > 0) {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp' && isDropdownVisible && items.length > 0) {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
      updateSelection();
    } else if (e.key === 'Enter') {
      if (isDropdownVisible && selectedIndex >= 0 && selectedIndex < items.length) {
        e.preventDefault();
        const urlSpan = items[selectedIndex].querySelector('.url-history-url');
        urlInput.value = urlSpan.textContent;
        hideDropdown();
        navigate(urlInput.value);
      } else {
        hideDropdown();
        navigate(urlInput.value);
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  // Stop propagation so clicks in the URL bar don't lose focus unexpectedly
  urlInput.addEventListener('mousedown', e => e.stopPropagation());

  webview.addEventListener('dom-ready', () => {
    console.log(`[WebPanel] dom-ready panel=${panel.id}`);
  });

  webview.addEventListener('did-navigate', e => {
    console.log(`[WebPanel] did-navigate panel=${panel.id} url=${e.url}`);
    urlInput.value = e.url;
    updatePanelUrl(panel.id, e.url);
    addToUrlHistory(e.url, '');
    if (window.electronAPI.debugGetCookieCount) {
      window.electronAPI.debugGetCookieCount().then(info => {
        console.log(`[WebPanel] Cookies after navigate: total=${info.total} session=${info.session} persistent=${info.persistent}`);
      }).catch(() => {});
    }
  });

  webview.addEventListener('did-navigate-in-page', e => {
    if (e.isMainFrame) {
      urlInput.value = e.url;
      updatePanelUrl(panel.id, e.url);
      addToUrlHistory(e.url, '');
    }
  });

  webview.addEventListener('did-fail-load', e => {
    console.log(`[WebPanel] did-fail-load panel=${panel.id} error=${e.errorDescription} code=${e.errorCode} url=${e.validatedURL}`);
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

  // Focus tracking when webview gains focus
  webview.addEventListener('focus', () => {
    setFocusedPanel(panel.id);
  });

  // Inject Cmd+F interceptor into webview guest pages.
  // Key events inside a webview don't bubble to the parent document,
  // so we inject a listener and use console-message as a back-channel.
  const injectSearchInterceptor = () => {
    webview.executeJavaScript(`
      if (!window.__panelSearchInjected) {
        window.__panelSearchInjected = true;
        document.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
            e.preventDefault();
            e.stopPropagation();
            console.log('__PANEL_SEARCH_CMD_F__');
          }
        }, true);
      }
    `).catch(() => {});
  };

  webview.addEventListener('dom-ready', injectSearchInterceptor);
  webview.addEventListener('did-navigate', injectSearchInterceptor);

  webview.addEventListener('console-message', e => {
    if (e.message === '__PANEL_SEARCH_CMD_F__') {
      setFocusedPanel(panel.id);
      showPanelSearch(panel.id);
    }
  });

  webview.addEventListener('page-title-updated', e => {
    // Update the panel header label with the page title
    const panelEl = webview.closest('.panel');
    if (panelEl) {
      const lbl = panelEl.querySelector('.panel-type-label');
      if (lbl) lbl.textContent = e.title || 'Web';
    }
    // Update the title in URL history for this URL
    const currentUrl = urlInput.value;
    if (e.title && currentUrl) {
      const entry = state.urlHistory.find(h => h.url === currentUrl);
      if (entry) {
        entry.title = e.title;
        saveState();
      }
    }
  });
}
