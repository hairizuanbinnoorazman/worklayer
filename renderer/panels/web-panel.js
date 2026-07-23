// web-panel.js - Web panel with webview

// Registry: webContentsId -> { panelId, refresh(), showSearch() }
const webviewRegistry = new Map();

// Electron zoom levels — factor = 1.2^level, so these span ~58% to ~300% with 100% at index 5.
const WEB_ZOOM_LEVELS = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];

function findWebZoomLevelIndex(level) {
  let closest = 0;
  let minDiff = Math.abs(WEB_ZOOM_LEVELS[0] - level);
  for (let i = 1; i < WEB_ZOOM_LEVELS.length; i++) {
    const diff = Math.abs(WEB_ZOOM_LEVELS[i] - level);
    if (diff < minDiff) { minDiff = diff; closest = i; }
  }
  return closest;
}

// Latest TLS cert error details pushed from main, keyed by webContentsId.
// The certificate-error event fires before did-fail-load, so the warning page
// renderer can look up details here. One entry per wc — replaced on each error.
const tlsErrorDetails = new Map();
if (window.electronAPI && window.electronAPI.onTlsErrorDetails) {
  window.electronAPI.onTlsErrorDetails((data) => {
    if (data && data.webContentsId) {
      tlsErrorDetails.set(data.webContentsId, data);
    }
  });
}

// Chromium net error codes for certificate failures (handled in warning page).
// See net/base/net_error_list.h — codes land in did-fail-load's errorCode.
function isCertErrorCode(code) {
  return code <= -200 && code >= -299;
}
function describeCertError(code, description) {
  const map = {
    [-200]: 'Certificate is invalid',
    [-201]: 'Certificate authority is not trusted',
    [-202]: 'Certificate does not match the hostname',
    [-203]: 'Certificate has expired or is not yet valid',
    [-204]: 'Certificate contains errors',
    [-205]: 'No revocation mechanism available',
    [-206]: 'Unable to check certificate revocation',
    [-207]: 'Certificate revoked',
    [-208]: 'Invalid certificate',
    [-209]: 'Certificate is weakly signed',
    [-210]: 'Certificate uses a non-unique name',
    [-211]: 'Certificate chain uses a weak key',
    [-212]: 'Name-constraint violation in certificate',
    [-213]: 'Certificate validity period is too long',
    [-215]: 'Certificate Transparency requirements not met',
    [-216]: 'Certificate known to be compromised',
  };
  return map[code] || description || 'Certificate error';
}

// IPC listeners for Cmd+R and Cmd+F from main process before-input-event
if (window.electronAPI.onWebviewRefresh) {
  window.electronAPI.onWebviewRefresh(({ webContentsId }) => {
    const entry = webviewRegistry.get(webContentsId);
    if (entry) entry.refresh();
  });
}
if (window.electronAPI.onWebviewFind) {
  window.electronAPI.onWebviewFind(({ webContentsId }) => {
    const entry = webviewRegistry.get(webContentsId);
    if (entry) entry.showSearch();
  });
}
// Keep focusedPanelId in sync when a guest gains focus. The host-side <webview>
// 'focus' DOM event is unreliable for guest->guest transitions, so the main
// process forwards a reliable focus signal keyed by webContentsId.
if (window.electronAPI.onWebviewFocus) {
  window.electronAPI.onWebviewFocus(({ webContentsId }) => {
    const entry = webviewRegistry.get(webContentsId);
    if (entry) setFocusedPanel(entry.panelId);
  });
}
// Zoom (Cmd+=/-/0) forwarded from the main process when a webview guest is
// focused — the keystroke never reaches the renderer's global keydown handler.
// Resolve the panel fresh from webContentsId and dispatch the same CustomEvent
// the wrapper already listens for, so zoom hits the panel that actually has
// focus rather than a stale focusedPanelId.
if (window.electronAPI.onWebviewZoom) {
  window.electronAPI.onWebviewZoom(({ webContentsId, direction }) => {
    const entry = webviewRegistry.get(webContentsId);
    if (!entry) return;
    setFocusedPanel(entry.panelId);
    const panelEl = document.querySelector(`[data-panel-id="${entry.panelId}"]`);
    if (!panelEl) return;
    const wrapper = panelEl.querySelector('.webview-wrapper');
    if (!wrapper) return;
    const evtName = direction === 'in' ? 'web-zoom-in'
      : direction === 'out' ? 'web-zoom-out' : 'web-zoom-reset';
    wrapper.dispatchEvent(new CustomEvent(evtName));
  });
}
if (window.electronAPI.onWebviewOpenInNewPanel) {
  window.electronAPI.onWebviewOpenInNewPanel(({ url, sourceWebContentsId, disposition }) => {
    const entry = webviewRegistry.get(sourceWebContentsId);
    let newPanelId;
    if (disposition === 'foreground-tab' && entry) {
      newPanelId = addWebPanelAfter(entry.panelId, url);
    } else {
      newPanelId = addWebPanelAtEnd(url);
    }
    // The incremental insert in addWebPanelAt() does not scroll the strip, so a
    // panel opened from a link can land off-screen and look like "nothing happened".
    // Reveal it. A background-tab disposition keeps the user where they are.
    if (newPanelId && disposition !== 'background-tab') {
      scrollPanelIntoView(newPanelId);
    }
  });
}

// Scroll the panel strip so the given panel is visible. Runs after the DOM
// settles (rAF) since the panel element may have just been inserted.
function scrollPanelIntoView(panelId) {
  requestAnimationFrame(() => {
    const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
    if (panelEl) {
      panelEl.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  });
}
if (window.electronAPI.onWebviewBookmarkPage) {
  window.electronAPI.onWebviewBookmarkPage(({ webContentsId, url, title }) => {
    if (!url || url === 'about:blank' || url.startsWith('data:')) return;
    const entry = webviewRegistry.get(webContentsId);
    if (!entry) return;
    if (!isBookmarked(url)) {
      addBookmark(url, title);
    }
    // Update the star button for the relevant panel
    const panelEl = document.querySelector(`[data-panel-id="${entry.panelId}"]`);
    if (panelEl) {
      const bmBtn = panelEl.querySelector('.bookmark-btn');
      if (bmBtn) {
        bmBtn.textContent = '\u2605';
        bmBtn.classList.add('bookmarked');
      }
    }
  });
}

function isAbortedError(err) {
  return err && err.message && err.message.includes('ERR_ABORTED');
}

// A GUEST_VIEW_MANAGER_CALL / ERR_FAILED(-2) rejection from loadURL is TRANSIENT
// after a renderer crash: the browser-side guest WebContents survives the crash,
// and Chromium spawns a fresh renderer on the next load. The first loadURL can
// race that respawn and reject, but a retry lands on the live process. So these
// must be RETRIED, not treated as terminal. (Verified against Electron 28.3.3:
// webview.src= would just call loadURL internally and swallow the same rejection.)
function isTransientGuestError(err) {
  if (!err || !err.message) return false;
  return err.message.includes('GUEST_VIEW_MANAGER') ||
    err.code === 'ERR_FAILED' ||
    (err.message.includes('ERR_FAILED') && err.message.includes('(-2)'));
}

function loadURLWithRetry(webview, url, maxRetries, onFail, onAbort) {
  let attempt = 0;
  function tryLoad() {
    let promise;
    try {
      promise = webview.loadURL(url);
    } catch (err) {
      // A synchronous throw still gets retries — same transient-respawn reasoning.
      attempt++;
      if (attempt <= maxRetries) {
        console.log(`[WebPanel] loadURL threw, retry ${attempt}/${maxRetries} url=${url} error=${err.message}`);
        setTimeout(tryLoad, 500);
      } else {
        onFail(err);
      }
      return;
    }
    if (!promise || typeof promise.catch !== 'function') {
      onFail(new Error('loadURL did not return a promise'));
      return;
    }
    promise.catch(err => {
      if (isAbortedError(err)) {
        // ERR_ABORTED means the navigation never happened — e.g. a beforeunload
        // handler on a page with unsaved edits cancelled it, or the user chose
        // "Stay". This is NOT a retry case, but the caller's in-flight guard must
        // be released or the panel stays locked and refuses all future navigation.
        if (onAbort) onAbort(err);
        return;
      }
      attempt++;
      if (attempt <= maxRetries) {
        const note = isTransientGuestError(err) ? ' (transient guest error)' : '';
        console.log(`[WebPanel] loadURL retry ${attempt}/${maxRetries}${note} url=${url} error=${err.message}`);
        setTimeout(tryLoad, 500);
      } else {
        onFail(err);
      }
    });
  }
  tryLoad();
}

function renderWebPanel(panel, container) {
  const urlBar = document.createElement('div');
  urlBar.className = 'url-bar';

  const backBtn = document.createElement('button');
  backBtn.className = 'nav-btn';
  backBtn.textContent = '\u2190';
  backBtn.title = 'Back';

  const forwardBtn = document.createElement('button');
  forwardBtn.className = 'nav-btn';
  forwardBtn.textContent = '\u2192';
  forwardBtn.title = 'Forward';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'nav-btn';
  refreshBtn.textContent = '\u21bb';
  refreshBtn.title = 'Refresh';

  const bookmarkBtn = document.createElement('button');
  bookmarkBtn.className = 'nav-btn bookmark-btn';
  bookmarkBtn.textContent = '\u2606';
  bookmarkBtn.title = 'Bookmark this page';

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
  urlBar.appendChild(bookmarkBtn);
  urlBar.appendChild(urlInputWrapper);
  container.appendChild(urlBar);

  const loadingBar = document.createElement('div');
  loadingBar.className = 'webview-loading-bar';
  container.appendChild(loadingBar);

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
  webview.setAttribute('webpreferences', 'plugins');
  const initialUrl = panel.url || 'about:blank';
  const webviewWrapper = document.createElement('div');
  webviewWrapper.className = 'webview-wrapper';
  container.appendChild(webviewWrapper);
  webviewWrapper.appendChild(webview);
  // Use src attribute for initial load — loadURL() requires the webview to be
  // attached to the live DOM with dom-ready fired, but at this point the
  // wrapper hasn't been appended to the panel strip yet.
  webview.src = initialUrl;

  const defaultWebZoom = getProfileDefaultWebZoomLevel(getActiveProfile());
  const initialZoomLevel = panel.zoomLevel !== undefined ? panel.zoomLevel : defaultWebZoom;
  let currentZoomIndex = findWebZoomLevelIndex(initialZoomLevel);

  // Re-derive the panel's current zoom index from live state. The panel may
  // have been rearranged or re-rendered since this closure was created, so the
  // cached `currentZoomIndex` can be stale — read the persisted zoomLevel fresh.
  function liveZoomIndex() {
    const livePanel = getActivePanelById(panel.id) || panel;
    const level = livePanel.zoomLevel !== undefined
      ? livePanel.zoomLevel
      : getProfileDefaultWebZoomLevel(getActiveProfile());
    return findWebZoomLevelIndex(level);
  }

  function applyWebZoom(newIndex) {
    currentZoomIndex = Math.max(0, Math.min(WEB_ZOOM_LEVELS.length - 1, newIndex));
    const level = WEB_ZOOM_LEVELS[currentZoomIndex];
    try { webview.setZoomLevel(level); } catch (e) {}
    updatePanelZoomLevel(panel.id, level);
  }

  webviewWrapper.addEventListener('web-zoom-in', () => applyWebZoom(liveZoomIndex() + 1));
  webviewWrapper.addEventListener('web-zoom-out', () => applyWebZoom(liveZoomIndex() - 1));
  webviewWrapper.addEventListener('web-zoom-reset', () => applyWebZoom(findWebZoomLevelIndex(0)));

  // ── Bookmark overlay ────────────────────────────

  const bookmarkOverlay = document.createElement('div');
  bookmarkOverlay.className = 'bookmark-overlay';
  bookmarkOverlay.hidden = true;

  const bmSearchInput = document.createElement('input');
  bmSearchInput.type = 'text';
  bmSearchInput.className = 'bookmark-search-input';
  bmSearchInput.placeholder = 'Search bookmarks...';

  const bmGrid = document.createElement('div');
  bmGrid.className = 'bookmark-grid';

  bookmarkOverlay.appendChild(bmSearchInput);
  bookmarkOverlay.appendChild(bmGrid);
  webviewWrapper.appendChild(bookmarkOverlay);

  function updateBookmarkOverlay() {
    const query = bmSearchInput.value;
    const bookmarks = getFilteredBookmarks(query);
    bmGrid.innerHTML = '';

    if (bookmarks.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'bookmark-empty';
      emptyMsg.textContent = query
        ? 'No matching bookmarks.'
        : 'No bookmarks yet. Navigate to a page and click \u2606 to add one.';
      bmGrid.appendChild(emptyMsg);
      return;
    }

    bookmarks.forEach(bm => {
      const tile = document.createElement('div');
      tile.className = 'bookmark-tile';

      const iconEl = document.createElement('div');
      iconEl.className = 'bookmark-tile-icon';
      try {
        const domain = new URL(bm.url).hostname;
        iconEl.textContent = domain.replace(/^www\./, '').charAt(0).toUpperCase();
      } catch { iconEl.textContent = '?'; }

      const titleEl = document.createElement('div');
      titleEl.className = 'bookmark-tile-title';
      titleEl.textContent = bm.title || bm.url;
      titleEl.title = bm.title || bm.url;

      const urlEl = document.createElement('div');
      urlEl.className = 'bookmark-tile-url';
      try { urlEl.textContent = new URL(bm.url).hostname; } catch { urlEl.textContent = bm.url; }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'bookmark-tile-delete';
      deleteBtn.textContent = '\u00d7';
      deleteBtn.title = 'Remove bookmark';
      deleteBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeBookmark(bm.id);
        updateBookmarkOverlay();
      });

      tile.appendChild(deleteBtn);
      tile.appendChild(iconEl);
      tile.appendChild(titleEl);
      tile.appendChild(urlEl);

      tile.addEventListener('click', () => navigate(bm.url));
      bmGrid.appendChild(tile);
    });
  }

  function showBookmarkOverlay() {
    bookmarkOverlay.hidden = false;
    webview.classList.add('webview-hidden');
    bmSearchInput.value = '';
    updateBookmarkOverlay();
  }

  function hideBookmarkOverlay() {
    bookmarkOverlay.hidden = true;
    webview.classList.remove('webview-hidden');
  }

  bmSearchInput.addEventListener('input', () => updateBookmarkOverlay());
  bmSearchInput.addEventListener('mousedown', e => e.stopPropagation());

  if (initialUrl === 'about:blank') showBookmarkOverlay();

  // ── Bookmark button logic ───────────────────────
  function updateBookmarkBtn() {
    const currentUrl = urlInput.value;
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('data:') || currentUrl.startsWith('file://')) {
      bookmarkBtn.style.display = 'none';
      return;
    }
    bookmarkBtn.style.display = '';
    const marked = isBookmarked(currentUrl);
    bookmarkBtn.textContent = marked ? '\u2605' : '\u2606';
    bookmarkBtn.classList.toggle('bookmarked', marked);
  }

  bookmarkBtn.addEventListener('click', () => {
    const currentUrl = urlInput.value;
    if (!currentUrl || currentUrl === 'about:blank') return;
    if (isBookmarked(currentUrl)) {
      const profile = getActiveProfile();
      const bm = profile.bookmarks.find(b => b.url === currentUrl);
      if (bm) removeBookmark(bm.id);
    } else {
      const title = webview.getTitle ? webview.getTitle() : '';
      addBookmark(currentUrl, title);
    }
    updateBookmarkBtn();
  });

  updateBookmarkBtn();

  console.log(`[WebPanel] Created webview panel=${panel.id} url=${panel.url || 'about:blank'} partition=persist:webpanels`);

  let lastRealUrl = panel.url || '';
  let crashRetryCount = 0;
  let errorPageShownForUrl = null;
  let navigateInFlight = false;
  let retryInProgress = false;
  let guestViewBroken = false;
  let rendererDead = false;
  let crashRetryTimer = null;

  // DOM-based error overlay shown when webview.loadURL() itself is broken
  function showErrorOverlay(url, errorDescription) {
    let overlay = webviewWrapper.querySelector('.webview-error-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'webview-error-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
      webviewWrapper.appendChild(overlay);
    }
    const retryUrl = url || lastRealUrl || '';
    overlay.innerHTML = `
      <div style="text-align:center;max-width:480px;padding:2rem;">
        <div style="font-size:3rem;margin-bottom:1rem;">\u26a0</div>
        <h2 style="margin:0 0 0.5rem;">Failed to load page</h2>
        <p style="color:#a6adc8;margin:0 0 1rem;">${url || ''}</p>
        <p style="color:#f38ba8;">${errorDescription || 'Unknown error'}</p>
        ${retryUrl ? '<button class="error-overlay-retry" style="margin-top:1rem;padding:0.5rem 1.5rem;border:none;border-radius:6px;background:#89b4fa;color:#1e1e2e;font-size:1rem;cursor:pointer;">Retry</button>' : ''}
      </div>`;
    const retryBtn = overlay.querySelector('.error-overlay-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        overlay.remove();
        navigate(retryUrl);
      });
    }
    overlay.hidden = false;
  }

  function removeErrorOverlay() {
    const overlay = webviewWrapper.querySelector('.webview-error-overlay');
    if (overlay) overlay.remove();
    const tlsOverlay = webviewWrapper.querySelector('.webview-tls-overlay');
    if (tlsOverlay) tlsOverlay.remove();
  }

  // TLS warning page. Rendered as a DOM overlay (not a data: URL) so the
  // "Continue anyway" button can call IPC from the main renderer context.
  function showTlsWarningPage(url, errorDescription, errorCode) {
    loadingBar.classList.remove('active');
    errorPageShownForUrl = url;

    let host = '';
    try { host = new URL(url).host; } catch (e) {}
    const wcId = webview._webContentsId;
    const details = wcId ? tlsErrorDetails.get(wcId) : null;
    const cert = details && details.certificate ? details.certificate : null;
    const errorTitle = describeCertError(errorCode, errorDescription);

    const fmtDate = (ts) => {
      if (!ts) return '—';
      try { return new Date(ts * 1000).toUTCString(); } catch (e) { return String(ts); }
    };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    let overlay = webviewWrapper.querySelector('.webview-tls-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'webview-tls-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;overflow:auto;';

    const certRows = cert ? `
      <div style="margin-top:1rem;border-top:1px solid #45475a;padding-top:1rem;font-size:0.9rem;color:#a6adc8;text-align:left;">
        <div><span style="color:#bac2de;">Subject:</span> ${esc(cert.subjectName) || '—'}</div>
        <div><span style="color:#bac2de;">Issuer:</span> ${esc(cert.issuerName) || '—'}</div>
        <div><span style="color:#bac2de;">Valid from:</span> ${esc(fmtDate(cert.validStart))}</div>
        <div><span style="color:#bac2de;">Valid until:</span> ${esc(fmtDate(cert.validExpiry))}</div>
        ${cert.fingerprint ? `<div style="word-break:break-all;"><span style="color:#bac2de;">Fingerprint:</span> ${esc(cert.fingerprint)}</div>` : ''}
      </div>` : '<div style="margin-top:0.75rem;color:#6c7086;font-size:0.85rem;">Certificate details unavailable.</div>';

    overlay.innerHTML = `
      <div style="max-width:560px;padding:2rem;text-align:center;">
        <div style="font-size:3rem;margin-bottom:0.5rem;">\u26a0</div>
        <h2 style="margin:0 0 0.25rem;color:#f38ba8;">Your connection is not private</h2>
        <p style="color:#a6adc8;margin:0 0 0.5rem;word-break:break-all;">${esc(url)}</p>
        <p style="color:#f9e2af;margin:0.5rem 0 0;"><strong>${esc(errorTitle)}</strong></p>
        <p style="color:#6c7086;font-size:0.85rem;margin:0.25rem 0 0;">${esc(errorDescription || '')} (${errorCode})</p>
        ${certRows}
        <div style="margin-top:1.5rem;display:flex;gap:0.75rem;justify-content:center;">
          <button class="tls-back-btn" style="padding:0.5rem 1.25rem;border:1px solid #45475a;border-radius:6px;background:transparent;color:#cdd6f4;font-size:0.95rem;cursor:pointer;">Go back</button>
          <button class="tls-continue-btn" style="padding:0.5rem 1.25rem;border:none;border-radius:6px;background:#f38ba8;color:#1e1e2e;font-size:0.95rem;font-weight:600;cursor:pointer;">Continue anyway</button>
        </div>
        <p style="color:#6c7086;font-size:0.8rem;margin-top:1rem;">Exemption applies to this panel only until it is closed.</p>
      </div>`;

    webviewWrapper.appendChild(overlay);

    overlay.querySelector('.tls-back-btn').addEventListener('click', () => {
      overlay.remove();
      if (webview.canGoBack()) {
        webview.goBack();
      } else {
        webview.src = 'about:blank';
      }
    });
    overlay.querySelector('.tls-continue-btn').addEventListener('click', async () => {
      if (!wcId || !host) {
        overlay.remove();
        return;
      }
      try {
        await window.electronAPI.tlsAllowHost(wcId, host);
      } catch (e) {
        console.log(`[WebPanel] tlsAllowHost failed panel=${panel.id} host=${host} err=${e.message}`);
      }
      overlay.remove();
      errorPageShownForUrl = null;
    });
  }

  let errorPageLoadFailed = false;

  function showErrorPage(url, errorDescription, errorCode) {
    if (errorPageShownForUrl === url) return;
    errorPageShownForUrl = url;
    loadingBar.classList.remove('active');
    const retryUrl = url || lastRealUrl || '';
    const desc = errorDescription || 'Unknown error';

    if (errorPageLoadFailed || guestViewBroken || rendererDead) {
      try { showErrorOverlay(retryUrl, desc); } catch (e) {}
      return;
    }

    const errorPage = `
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1e1e2e; color: #cdd6f4;">
        <div style="text-align: center; max-width: 480px; padding: 2rem;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">\u26a0</div>
          <h2 style="margin: 0 0 0.5rem;">Failed to load page</h2>
          <p style="color: #a6adc8; margin: 0 0 1rem;">${url || ''}</p>
          <p style="color: #f38ba8;">${desc} (${errorCode})</p>
          ${retryUrl ? `<button data-url="${encodeURIComponent(retryUrl)}" onclick="window.location.href=decodeURIComponent(this.dataset.url)" style="margin-top: 1rem; padding: 0.5rem 1.5rem; border: none; border-radius: 6px; background: #89b4fa; color: #1e1e2e; font-size: 1rem; cursor: pointer;">Retry</button>` : ''}
        </div>
      </body>
      </html>`;
    try {
      webview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage)).catch(err => {
        console.log(`[WebPanel] Error page loadURL rejected panel=${panel.id}, falling back to overlay`);
        errorPageLoadFailed = true;
        try { showErrorOverlay(retryUrl, desc); } catch (e) {}
      });
    } catch (err) {
      console.log(`[WebPanel] Error page loadURL threw panel=${panel.id}, falling back to overlay`);
      errorPageLoadFailed = true;
      try { showErrorOverlay(retryUrl, desc); } catch (e) {}
    }
  }

  const navigate = (raw) => {
    let url = raw.trim();
    if (!url) return;
    hideBookmarkOverlay();
    if (navigateInFlight && !guestViewBroken && !rendererDead) {
      console.log(`[WebPanel] navigate blocked — already in flight panel=${panel.id}`);
      return;
    }
    if (!/^[a-z][a-z\d+\-.]*:/i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }
    // Reset broken state — user explicitly navigating should always unstick the panel.
    // loadURLWithRetry retries the transient post-crash guest error, so a navigation
    // away from a crashed page lands on the freshly respawned renderer.
    if (crashRetryTimer) { clearTimeout(crashRetryTimer); crashRetryTimer = null; }
    guestViewBroken = false;
    errorPageLoadFailed = false;
    rendererDead = false;
    crashRetryCount = 0;
    lastRealUrl = url;
    errorPageShownForUrl = null;
    navigateInFlight = true;
    retryInProgress = true;
    removeErrorOverlay();
    loadURLWithRetry(webview, url, 3, (err) => {
      navigateInFlight = false;
      retryInProgress = false;
      console.log(`[WebPanel] loadURL failed (navigate) panel=${panel.id} url=${url} error=${err.message}`);
      showErrorPage(url, err.message, -2);
    }, () => {
      // Navigation aborted (e.g. beforeunload cancelled it). Release the guard
      // so the panel isn't permanently locked out of navigating.
      navigateInFlight = false;
      retryInProgress = false;
      console.log(`[WebPanel] loadURL aborted (navigate) panel=${panel.id} url=${url}`);
    });
    urlInput.value = url;
    updatePanelUrl(panel.id, url);
    if (!url.startsWith('file://')) addToUrlHistory(url, '');
  };

  backBtn.addEventListener('click', () => webview.goBack());
  forwardBtn.addEventListener('click', () => webview.goForward());
  refreshBtn.addEventListener('click', () => {
    if (guestViewBroken || rendererDead) {
      if (lastRealUrl) navigate(lastRealUrl);
      return;
    }
    let currentUrl;
    try { currentUrl = webview.getURL(); } catch (e) { currentUrl = ''; }
    if ((!currentUrl || currentUrl.startsWith('data:')) && lastRealUrl) {
      navigate(lastRealUrl);
    } else {
      webview.reload();
    }
  });

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

  // Store webContentsId once the webview is ready and register in webviewRegistry
  webview.addEventListener('dom-ready', () => {
    console.log(`[WebPanel] dom-ready panel=${panel.id}`);
    webview._webContentsId = webview.getWebContentsId();
    webviewRegistry.set(webview._webContentsId, {
      panelId: panel.id,
      refresh: () => refreshBtn.click(),
      showSearch: () => {
        setFocusedPanel(panel.id);
        showPanelSearch(panel.id);
      },
    });
    // Register webview with main process for CDP access
    if (window.electronAPI.cdpRegisterWebview) {
      window.electronAPI.cdpRegisterWebview(webview._webContentsId, panel.id, panel.url || '');
    }
    // Re-apply zoom from live persisted state. dom-ready fires again after a
    // reorder recreates the guest WebContents (DOM move of a <webview> tears
    // down and rebuilds the guest), and the new guest defaults back to zoom 0.
    // Re-derive from live state so the panel keeps its zoom after being moved,
    // and keep the closure index in sync for subsequent relative steps.
    currentZoomIndex = liveZoomIndex();
    try { webview.setZoomLevel(WEB_ZOOM_LEVELS[currentZoomIndex]); } catch (e) {}
  });

  // Handle found-in-page results from findInPage
  webview.addEventListener('found-in-page', e => {
    console.log('[WebPanel] found-in-page (webview event) panel:', panel.id,
      'requestId:', e.result.requestId, 'active:', e.result.activeMatchOrdinal,
      'matches:', e.result.matches, 'final:', e.result.finalUpdate);
    const entry = activePanelSearches.get(panel.id);
    if (entry && entry.updateMatchInfo) {
      entry.updateMatchInfo(e.result.activeMatchOrdinal || 0, e.result.matches || 0);
    }
  });

  webview.addEventListener('did-navigate', e => {
    console.log(`[WebPanel] did-navigate panel=${panel.id} url=${e.url}`);
    navigateInFlight = false;
    retryInProgress = false;
    errorPageLoadFailed = false;
    guestViewBroken = false;
    rendererDead = false;
    removeErrorOverlay();
    const tlsOverlay = webviewWrapper.querySelector('.webview-tls-overlay');
    if (tlsOverlay) tlsOverlay.remove();
    if (!e.url.startsWith('data:')) {
      errorPageShownForUrl = null;
      lastRealUrl = e.url;
      crashRetryCount = 0;
      urlInput.value = e.url;
      updatePanelUrl(panel.id, e.url);
      if (!e.url.startsWith('file://')) addToUrlHistory(e.url, '');
      if (window.electronAPI.cdpUpdateWebview && webview._webContentsId) {
        window.electronAPI.cdpUpdateWebview(webview._webContentsId, e.url, undefined);
      }
    }
    // Show/hide bookmark overlay based on URL
    if (e.url === 'about:blank') {
      showBookmarkOverlay();
    } else {
      hideBookmarkOverlay();
    }
    updateBookmarkBtn();
  });

  webview.addEventListener('did-navigate-in-page', e => {
    if (e.isMainFrame && !e.url.startsWith('data:')) {
      lastRealUrl = e.url;
      urlInput.value = e.url;
      updatePanelUrl(panel.id, e.url);
      if (!e.url.startsWith('file://')) addToUrlHistory(e.url, '');
    }
    updateBookmarkBtn();
  });

  webview.addEventListener('did-fail-load', e => {
    console.log(`[WebPanel] did-fail-load panel=${panel.id} error=${e.errorDescription} code=${e.errorCode} url=${e.validatedURL} isMainFrame=${e.isMainFrame}`);
    if (e.errorCode === 0 || e.errorCode === -3) return; // ignore aborted loads
    if (!e.isMainFrame) return;
    if (retryInProgress) return;
    if (guestViewBroken || rendererDead) return;
    if (e.validatedURL && e.validatedURL.startsWith('data:')) return;
    const failUrl = e.validatedURL || lastRealUrl || '';
    if (isCertErrorCode(e.errorCode)) {
      showTlsWarningPage(failUrl, e.errorDescription, e.errorCode);
      return;
    }
    showErrorPage(failUrl, e.errorDescription, e.errorCode);
  });

  // Handle errors dispatched from navigateWebPanel in app.js
  webview.addEventListener('loadurl-error', e => {
    if (e.detail.message && e.detail.message.includes('ERR_ABORTED')) return;
    if (retryInProgress) return;
    if (guestViewBroken || rendererDead) return;
    console.log(`[WebPanel] loadurl-error (custom) panel=${panel.id} url=${e.detail.url} error=${e.detail.message}`);
    showErrorPage(e.detail.url, e.detail.message, -2);
  });

  // Handle renderer crashes with auto-retry (max 2, not 5 \u2014 prevents tight crash loops)
  webview.addEventListener('render-process-gone', e => {
    const reason = e.reason || 'unknown';
    const exitCode = e.exitCode;
    console.log(`[WebPanel] render-process-gone panel=${panel.id} reason=${reason} exitCode=${exitCode} url=${lastRealUrl}`);

    rendererDead = true;
    navigateInFlight = false;
    retryInProgress = false;
    if (crashRetryTimer) { clearTimeout(crashRetryTimer); crashRetryTimer = null; }

    if (guestViewBroken || crashRetryCount >= 2) {
      console.log(`[WebPanel] webview unrecoverable, showing overlay panel=${panel.id}`);
      guestViewBroken = true;
      showErrorOverlay(lastRealUrl, `Page crashed (${reason}). Enter a URL to navigate away.`);
      return;
    }

    if (!lastRealUrl) {
      guestViewBroken = true;
      showErrorOverlay('', `Page crashed (${reason}).`);
      return;
    }

    crashRetryCount++;
    retryInProgress = true;
    console.log(`[WebPanel] Auto-retry ${crashRetryCount}/2 for panel=${panel.id} url=${lastRealUrl}`);
    crashRetryTimer = setTimeout(() => {
      crashRetryTimer = null;
      rendererDead = false;
      // The browser-side guest WebContents survives the crash; loadURL on it spawns
      // a fresh renderer. loadURLWithRetry absorbs the transient GUEST_VIEW_MANAGER /
      // ERR_FAILED(-2) rejection that can race the respawn. On success, did-navigate
      // clears retryInProgress/rendererDead; on exhaustion, onFail clears them and
      // surfaces the overlay (so flags never get stuck).
      loadURLWithRetry(webview, lastRealUrl, 2, (err) => {
        retryInProgress = false;
        guestViewBroken = true;
        console.log(`[WebPanel] loadURL failed (crash-retry) panel=${panel.id} url=${lastRealUrl} error=${err.message}`);
        showErrorOverlay(lastRealUrl, `Page crashed (${reason}). Enter a URL to navigate away.`);
      });
    }, 1000);
  });

  // Focus tracking when webview gains focus; stop search capture so keystrokes go to webview
  // BUT keep capture alive if the search bar is currently visible/active
  webview.addEventListener('focus', () => {
    setFocusedPanel(panel.id);
    const entry = activePanelSearches.get(panel.id);
    if (entry && !entry.bar.hidden) {
      console.log('[WebPanel] focus event — search bar active, refocusing search input');
      entry.input.focus(); // Immediately reclaim focus for the search input
      return;
    }
    if (entry && entry.searchImpl.stopCapture) {
      entry.searchImpl.stopCapture();
    }
  });

  webview.addEventListener('did-start-loading', () => {
    loadingBar.classList.add('active');
  });

  webview.addEventListener('did-stop-loading', () => {
    loadingBar.classList.remove('active');
  });

  webview.addEventListener('page-title-updated', e => {
    if (webview.getURL().startsWith('data:')) return;
    // Update CDP tracking with new title
    if (window.electronAPI.cdpUpdateWebview && webview._webContentsId) {
      window.electronAPI.cdpUpdateWebview(webview._webContentsId, undefined, e.title);
    }
    // Update the panel header label with the page title
    const panelEl = webview.closest('.panel');
    if (panelEl) {
      const lbl = panelEl.querySelector('.panel-type-label');
      if (lbl) lbl.textContent = e.title || 'Web';
    }
    // Update the title in URL history for this URL
    const currentUrl = urlInput.value;
    if (e.title && currentUrl) {
      const profile = getActiveProfile();
      if (profile) {
        const entry = profile.urlHistory.find(h => h.url === currentUrl);
        if (entry) {
          entry.title = e.title;
          saveState();
        }
      }
    }
  });

  // Cleanup function — mirrors the pattern used by mountTerminal() in term-panel.js
  const cleanup = () => {
    const wcId = webview._webContentsId;
    if (wcId !== undefined) {
      webviewRegistry.delete(wcId);
      if (window.electronAPI.cdpUnregisterWebview) {
        window.electronAPI.cdpUnregisterWebview(wcId);
      }
    }
    destroyPanelSearch(panel.id);
    activeWebPanels.delete(panel.id);
  };
  // reapplyZoom re-pushes the panel's persisted zoom onto the (possibly
  // recreated) guest. Called after a reorder DOM move — see onDragEnd in
  // panel-drag.js, mirroring how terminals re-fit after being moved.
  const reapplyZoom = () => applyWebZoom(liveZoomIndex());
  activeWebPanels.set(panel.id, { cleanup, reapplyZoom });
}
