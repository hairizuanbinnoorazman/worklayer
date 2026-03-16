// panel-search.js - Per-panel search bars using findInPage + main-process keystroke capture

const activePanelSearches = new Map();

// Global IPC keystroke listener (set up once)
if (window.electronAPI && window.electronAPI.onSearchKeystroke) {
  window.electronAPI.onSearchKeystroke(data => {
    console.log('[PanelSearch] keystroke received wcId:', data.webContentsId, 'key:', data.key);
    let matched = false;
    for (const [panelId, entry] of activePanelSearches) {
      if (!entry.searchImpl.webContentsId || entry.searchImpl.webContentsId !== data.webContentsId) continue;
      if (entry.bar.hidden) continue;
      matched = true;

      const inp = entry.input;
      inp.focus(); // Ensure input has DOM focus for correct selectionStart/selectionEnd

      if (data.key.length === 1) {
        const s = inp.selectionStart;
        const end = inp.selectionEnd;
        const v = inp.value;
        inp.value = v.slice(0, s) + data.key + v.slice(end);
        inp.selectionStart = inp.selectionEnd = s + 1;
        console.log('[PanelSearch] inserted char, input.value now:', inp.value);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (data.key === 'Backspace') {
        const s = inp.selectionStart;
        const end = inp.selectionEnd;
        const v = inp.value;
        if (s !== end) {
          inp.value = v.slice(0, s) + v.slice(end);
          inp.selectionStart = inp.selectionEnd = s;
        } else if (s > 0) {
          inp.value = v.slice(0, s - 1) + v.slice(s);
          inp.selectionStart = inp.selectionEnd = s - 1;
        }
        console.log('[PanelSearch] backspace, input.value now:', inp.value);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (data.key === 'Escape') {
        hidePanelSearch(panelId);
      } else if (data.key === 'Enter') {
        inp.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', shiftKey: data.shift, bubbles: true, cancelable: true,
        }));
      }
      break;
    }
    if (!matched) {
      console.log('[PanelSearch] keystroke NOT matched to any panel. activePanelSearches size:', activePanelSearches.size);
      for (const [pid, e] of activePanelSearches) {
        console.log('  panel:', pid, 'wcId:', e.searchImpl.webContentsId, 'hidden:', e.bar.hidden);
      }
    }
  });
}

if (window.electronAPI && window.electronAPI.onSearchFoundInPage) {
  window.electronAPI.onSearchFoundInPage(data => {
    for (const [panelId, entry] of activePanelSearches) {
      if (!entry.searchImpl.webContentsId || entry.searchImpl.webContentsId !== data.webContentsId) continue;
      if (entry.bar.hidden) continue;
      console.log('[PanelSearch] found-in-page via IPC wcId:', data.webContentsId,
        'requestId:', data.result.requestId, 'active:', data.result.activeMatchOrdinal,
        'matches:', data.result.matches, 'final:', data.result.finalUpdate);
      if (entry.updateMatchInfo) {
        entry.updateMatchInfo(data.result.activeMatchOrdinal || 0, data.result.matches || 0);
      }
      break;
    }
  });
}

function createSearchBar(panelId, searchImpl) {
  const bar = document.createElement('div');
  bar.className = 'panel-search-bar';
  bar.dataset.panelSearch = panelId;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'panel-search-input';
  input.placeholder = 'Find in panel...';

  const matchInfo = document.createElement('span');
  matchInfo.className = 'panel-search-match-info';
  matchInfo.textContent = '';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'panel-search-btn';
  prevBtn.textContent = '\u2191';
  prevBtn.title = 'Previous match';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'panel-search-btn';
  nextBtn.textContent = '\u2193';
  nextBtn.title = 'Next match';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-search-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close search';

  bar.appendChild(input);
  bar.appendChild(matchInfo);
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(closeBtn);

  let currentQuery = '';
  let debounceTimer = null;

  function updateMatchInfo(activeIndex, total) {
    if (total > 0) {
      matchInfo.textContent = `${activeIndex} of ${total}`;
    } else if (currentQuery) {
      matchInfo.textContent = 'No matches';
    } else {
      matchInfo.textContent = '';
    }
  }

  function doFind(direction) {
    const query = input.value;
    console.log('[PanelSearch] doFind direction:', direction, 'query:', query);
    if (!query) {
      searchImpl.clear();
      currentQuery = '';
      updateMatchInfo(0, 0);
      return;
    }
    currentQuery = query;
    if (direction === 'prev') {
      searchImpl.findPrevious(query);
    } else {
      searchImpl.findNext(query);
    }
  }

  function scheduleSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doFind('next'), 200);
  }

  function navigateSearch(direction) {
    clearTimeout(debounceTimer);
    const query = input.value;
    if (!query) return;
    if (direction === 'prev' && searchImpl.navigatePrevious) {
      searchImpl.navigatePrevious(query);
    } else if (searchImpl.navigateNext) {
      searchImpl.navigateNext(query);
    } else {
      doFind(direction);
      return; // doFind already handles focus restore
    }
    // Backup: re-focus search input after findInPage to counteract webview focus steal
    setTimeout(() => { if (!bar.hidden) input.focus(); }, 100);
  }

  input.addEventListener('input', () => scheduleSearch());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateSearch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hidePanelSearch(panelId);
    }
  });
  // Prevent focus-tracking from triggering when interacting with search bar
  input.addEventListener('mousedown', e => e.stopPropagation());
  // Re-enable keystroke capture when search input regains focus
  input.addEventListener('focus', () => {
    if (searchImpl.startCapture) searchImpl.startCapture();
  });

  prevBtn.addEventListener('click', () => navigateSearch('prev'));
  nextBtn.addEventListener('click', () => navigateSearch('next'));
  closeBtn.addEventListener('click', () => hidePanelSearch(panelId));

  return { bar, input, searchImpl, updateMatchInfo };
}

function getSearchImpl(panelId) {
  const group = getActiveGroup();
  if (!group) return null;
  const panel = group.panels.find(p => p.id === panelId);
  if (!panel) return null;

  if (panel.type === 'web') {
    const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
    const webview = panelEl ? panelEl.querySelector('webview') : null;
    if (!webview) return null;

    const wcId = webview._webContentsId;
    let lastQuery = '';

    return {
      webContentsId: wcId,
      findNext(query) {
        const isNew = query !== lastQuery;
        lastQuery = query;
        console.log('[PanelSearch] findNext query:', query, 'isNew:', isNew);
        if (isNew) {
          // Workaround: findNext:false never fires found-in-page for webview guests
          // in Electron 28. Instead, clear the old session and use findNext:true.
          webview.stopFindInPage('clearSelection');
        }
        const reqId = webview.findInPage(query, { forward: true, findNext: true });
        console.log('[PanelSearch] findInPage requestId:', reqId);
      },
      findPrevious(query) {
        const isNew = query !== lastQuery;
        lastQuery = query;
        console.log('[PanelSearch] findPrevious query:', query, 'isNew:', isNew);
        if (isNew) {
          webview.stopFindInPage('clearSelection');
        }
        webview.findInPage(query, { forward: false, findNext: true });
      },
      navigateNext(query) {
        webview.findInPage(query, { forward: true, findNext: true });
      },
      navigatePrevious(query) {
        webview.findInPage(query, { forward: false, findNext: true });
      },
      clear() {
        lastQuery = '';
        webview.stopFindInPage('clearSelection');
      },
      startCapture() {
        if (wcId) window.electronAPI.searchStartCapture(wcId);
      },
      stopCapture() {
        if (wcId) window.electronAPI.searchStopCapture(wcId);
      },
    };
  }

  if (panel.type === 'terminal') {
    const termEntry = activeTerminals.get(panelId);
    if (!termEntry || !termEntry.searchAddon) return null;
    const sa = termEntry.searchAddon;
    return {
      findNext(query) { sa.findNext(query); },
      findPrevious(query) { sa.findPrevious(query); },
      clear() { sa.clearDecorations(); },
    };
  }

  return null;
}

function showPanelSearch(panelId) {
  const existing = activePanelSearches.get(panelId);
  if (existing) {
    existing.bar.hidden = false;
    existing.input.focus();
    existing.input.select();
    if (existing.searchImpl.startCapture) existing.searchImpl.startCapture();
    return;
  }

  const searchImpl = getSearchImpl(panelId);
  if (!searchImpl) return;

  const { bar, input, updateMatchInfo } = createSearchBar(panelId, searchImpl);

  const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
  if (!panelEl) return;
  const content = panelEl.querySelector('.panel-content');
  if (!content) return;
  content.insertBefore(bar, content.firstChild);

  activePanelSearches.set(panelId, { bar, input, searchImpl, updateMatchInfo });
  if (searchImpl.startCapture) searchImpl.startCapture();
  input.focus();
}

function hidePanelSearch(panelId) {
  const entry = activePanelSearches.get(panelId);
  if (!entry) return;
  entry.bar.hidden = true;
  entry.searchImpl.clear();
  if (entry.searchImpl.stopCapture) entry.searchImpl.stopCapture();
}

function destroyPanelSearch(panelId) {
  const entry = activePanelSearches.get(panelId);
  if (!entry) return;
  try { entry.searchImpl.clear(); } catch (e) {}
  if (entry.searchImpl.stopCapture) entry.searchImpl.stopCapture();
  entry.bar.remove();
  activePanelSearches.delete(panelId);
}
