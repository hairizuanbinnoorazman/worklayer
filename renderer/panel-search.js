// panel-search.js - Per-panel search bars

const activePanelSearches = new Map();

function createSearchBar(panelId, searchImpl) {
  const bar = document.createElement('div');
  bar.className = 'panel-search-bar';
  bar.dataset.panelSearch = panelId;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'panel-search-input';
  input.placeholder = 'Find in panel...';

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
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(closeBtn);

  let currentQuery = '';
  let debounceTimer = null;
  let findActive = false;

  function reclaimFocus() {
    if (!bar.hidden && !bar.contains(document.activeElement)) {
      input.focus();
      if (input.value !== currentQuery) {
        scheduleSearch();
      }
    }
  }

  function doFind(direction) {
    const query = input.value;
    if (!query) {
      searchImpl.clear();
      currentQuery = '';
      return;
    }
    currentQuery = query;
    findActive = true;
    if (direction === 'prev') {
      searchImpl.findPrevious(query);
    } else {
      searchImpl.findNext(query);
    }
    // findInPage steals focus at unpredictable times (immediate + async on
    // result render). Schedule multiple reclaim attempts to cover all cases.
    setTimeout(reclaimFocus, 0);
    setTimeout(reclaimFocus, 50);
    setTimeout(reclaimFocus, 150);
    setTimeout(reclaimFocus, 300);
    setTimeout(() => { findActive = false; }, 500);
  }

  function scheduleSearch(direction) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doFind(direction || 'next'), 200);
  }

  // When findInPage steals focus, reclaim it. Only fight for focus while
  // a find operation is in progress to avoid interfering with intentional
  // clicks on the webview content.
  input.addEventListener('blur', () => {
    if (findActive) {
      setTimeout(reclaimFocus, 0);
    }
  });

  // Hook into found-in-page event on the webview (if available) — this fires
  // exactly when async result rendering steals focus.
  if (searchImpl.onFoundInPage) {
    searchImpl.onFoundInPage(reclaimFocus);
  }

  // Debounce input so findInPage doesn't steal focus mid-typing
  input.addEventListener('input', () => scheduleSearch());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scheduleSearch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hidePanelSearch(panelId);
    }
  });
  // Prevent focus-tracking from triggering when interacting with search bar
  input.addEventListener('mousedown', e => e.stopPropagation());

  prevBtn.addEventListener('click', () => scheduleSearch('prev'));
  nextBtn.addEventListener('click', () => scheduleSearch('next'));
  closeBtn.addEventListener('click', () => hidePanelSearch(panelId));

  return { bar, input, searchImpl };
}

function getSearchImpl(panelId) {
  // Determine panel type from state
  const group = getActiveGroup();
  if (!group) return null;
  const panel = group.panels.find(p => p.id === panelId);
  if (!panel) return null;

  if (panel.type === 'web') {
    const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
    const webview = panelEl ? panelEl.querySelector('webview') : null;
    if (!webview) return null;
    let lastQuery = '';
    let _foundListener = null;
    return {
      findNext(query) {
        const isSame = query === lastQuery;
        lastQuery = query;
        webview.findInPage(query, { forward: true, findNext: isSame });
      },
      findPrevious(query) {
        const isSame = query === lastQuery;
        lastQuery = query;
        webview.findInPage(query, { forward: false, findNext: isSame });
      },
      clear() {
        lastQuery = '';
        try { webview.stopFindInPage('clearSelection'); } catch (e) {}
      },
      // Allow search bar to reclaim focus when webview reports find results
      onFoundInPage(callback) {
        _foundListener = () => callback();
        webview.addEventListener('found-in-page', _foundListener);
      },
      destroy() {
        if (_foundListener) {
          webview.removeEventListener('found-in-page', _foundListener);
          _foundListener = null;
        }
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
  // If already exists, just show and focus
  const existing = activePanelSearches.get(panelId);
  if (existing) {
    existing.bar.hidden = false;
    existing.input.focus();
    existing.input.select();
    return;
  }

  const searchImpl = getSearchImpl(panelId);
  if (!searchImpl) return;

  const { bar, input } = createSearchBar(panelId, searchImpl);

  // Insert at top of .panel-content
  const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
  if (!panelEl) return;
  const content = panelEl.querySelector('.panel-content');
  if (!content) return;
  content.insertBefore(bar, content.firstChild);

  activePanelSearches.set(panelId, { bar, input, searchImpl });
  input.focus();
}

function hidePanelSearch(panelId) {
  const entry = activePanelSearches.get(panelId);
  if (!entry) return;
  entry.bar.hidden = true;
  entry.searchImpl.clear();
}

function destroyPanelSearch(panelId) {
  const entry = activePanelSearches.get(panelId);
  if (!entry) return;
  try { entry.searchImpl.clear(); } catch (e) {}
  if (entry.searchImpl.destroy) entry.searchImpl.destroy();
  entry.bar.remove();
  activePanelSearches.delete(panelId);
}
