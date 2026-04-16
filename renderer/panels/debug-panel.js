// debug-panel.js - Debug panel for viewing network requests and console messages

// Map<panelId, { cleanup, remount }>
const activeDebugPanels = new Map();

function renderDebugPanel(panel, container) {
  const layout = document.createElement('div');
  layout.className = 'debug-panel-layout';

  // Toolbar: panel selector + tabs
  const toolbar = document.createElement('div');
  toolbar.className = 'debug-toolbar';

  const panelSelect = document.createElement('select');
  panelSelect.className = 'debug-panel-select';
  panelSelect.title = 'Select web panel to monitor';

  const tabs = document.createElement('div');
  tabs.className = 'debug-tabs';

  const networkTab = document.createElement('button');
  networkTab.className = 'debug-tab active';
  networkTab.textContent = 'Network';
  networkTab.dataset.tab = 'network';

  const consoleTab = document.createElement('button');
  consoleTab.className = 'debug-tab';
  consoleTab.textContent = 'Console';
  consoleTab.dataset.tab = 'console';

  tabs.appendChild(networkTab);
  tabs.appendChild(consoleTab);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'debug-clear-btn';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Clear current tab data';

  toolbar.appendChild(panelSelect);
  toolbar.appendChild(tabs);
  toolbar.appendChild(clearBtn);
  layout.appendChild(toolbar);

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.className = 'debug-filter-bar';

  const filterInput = document.createElement('input');
  filterInput.className = 'debug-filter-input';
  filterInput.type = 'text';
  filterInput.placeholder = 'Filter by URL or text...';

  const levelFilter = document.createElement('div');
  levelFilter.className = 'debug-level-filter';
  levelFilter.style.display = 'none'; // Shown only in console tab

  ['error', 'warning', 'info', 'debug'].forEach(level => {
    const btn = document.createElement('button');
    btn.className = 'debug-level-btn active';
    btn.dataset.level = level;
    btn.textContent = level.charAt(0).toUpperCase() + level.slice(1);
    levelFilter.appendChild(btn);
  });

  filterBar.appendChild(filterInput);
  filterBar.appendChild(levelFilter);
  layout.appendChild(filterBar);

  // Content areas
  const networkContent = document.createElement('div');
  networkContent.className = 'debug-content debug-network-content';

  const consoleContent = document.createElement('div');
  consoleContent.className = 'debug-content debug-console-content';
  consoleContent.style.display = 'none';

  layout.appendChild(networkContent);
  layout.appendChild(consoleContent);

  // Stats bar
  const statsBar = document.createElement('div');
  statsBar.className = 'debug-stats-bar';
  statsBar.textContent = 'No panel selected';
  layout.appendChild(statsBar);

  container.appendChild(layout);

  mountDebugPanel(panel, {
    panelSelect, networkTab, consoleTab, clearBtn,
    filterInput, levelFilter, networkContent, consoleContent, statsBar,
  });
}

async function mountDebugPanel(panel, ui) {
  if (activeDebugPanels.has(panel.id)) {
    // Already mounted — just refresh
    return;
  }

  let activeTab = 'network';
  let monitoredWcId = null;
  let networkData = [];
  let consoleData = [];
  let activeLevels = new Set(['error', 'warning', 'info', 'debug']);
  let filterText = '';

  // Load panel list
  async function refreshPanelList() {
    try {
      const panels = await window.electronAPI.debugListPanels();
      ui.panelSelect.innerHTML = '';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '-- Select panel --';
      ui.panelSelect.appendChild(emptyOpt);
      for (const p of panels) {
        const opt = document.createElement('option');
        opt.value = String(p.webContentsId);
        opt.textContent = `${p.title || p.url || p.panelId} (${p.panelId})`;
        ui.panelSelect.appendChild(opt);
      }
      if (monitoredWcId) ui.panelSelect.value = String(monitoredWcId);
    } catch (e) {
      // Panels not available yet
    }
  }

  await refreshPanelList();

  // Refresh panel list periodically (panels come and go)
  const panelListInterval = setInterval(refreshPanelList, 5000);

  // Load data for selected panel
  async function loadData() {
    if (!monitoredWcId) return;
    try {
      const [netResp, conResp] = await Promise.all([
        window.electronAPI.debugGetNetworkRequests(monitoredWcId),
        window.electronAPI.debugGetConsoleMessages(monitoredWcId),
      ]);
      networkData = netResp || [];
      consoleData = conResp || [];
      renderActiveTab();
    } catch (e) {
      // Panel may have been destroyed
    }
  }

  // Tab switching
  function switchTab(tab) {
    activeTab = tab;
    ui.networkTab.classList.toggle('active', tab === 'network');
    ui.consoleTab.classList.toggle('active', tab === 'console');
    ui.networkContent.style.display = tab === 'network' ? '' : 'none';
    ui.consoleContent.style.display = tab === 'console' ? '' : 'none';
    ui.levelFilter.style.display = tab === 'console' ? '' : 'none';
    renderActiveTab();
  }

  ui.networkTab.addEventListener('click', () => switchTab('network'));
  ui.consoleTab.addEventListener('click', () => switchTab('console'));

  // Panel selector
  ui.panelSelect.addEventListener('change', () => {
    const val = ui.panelSelect.value;
    monitoredWcId = val ? Number(val) : null;
    networkData = [];
    consoleData = [];
    renderActiveTab();
    if (monitoredWcId) loadData();
    updateStats();
  });

  // Clear button
  ui.clearBtn.addEventListener('click', async () => {
    if (!monitoredWcId) return;
    if (activeTab === 'network') {
      await window.electronAPI.debugClearNetwork(monitoredWcId);
      networkData = [];
    } else {
      await window.electronAPI.debugClearConsole(monitoredWcId);
      consoleData = [];
    }
    renderActiveTab();
    updateStats();
  });

  // Filter input
  ui.filterInput.addEventListener('input', () => {
    filterText = ui.filterInput.value;
    renderActiveTab();
  });

  // Level filter buttons
  ui.levelFilter.querySelectorAll('.debug-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const level = btn.dataset.level;
      if (activeLevels.has(level)) activeLevels.delete(level);
      else activeLevels.add(level);
      btn.classList.toggle('active', activeLevels.has(level));
      renderActiveTab();
    });
  });

  // Real-time event listener
  const removeEventListener = window.electronAPI.onDebugCdpEvent(({ wcId, category, data }) => {
    if (wcId !== monitoredWcId) return;

    if (category === 'network') {
      if (data.type === 'request') {
        networkData.push({
          requestId: data.requestId, url: data.url, method: data.method,
          resourceType: data.resourceType, status: null, failed: false,
          errorText: null, encodedDataLength: null,
        });
      } else if (data.type === 'response') {
        const entry = networkData.findLast(r => r.requestId === data.requestId);
        if (entry) {
          entry.status = data.status;
          entry.statusText = data.statusText;
        }
      } else if (data.type === 'failed') {
        const entry = networkData.findLast(r => r.requestId === data.requestId);
        if (entry) {
          entry.failed = true;
          entry.errorText = data.errorText;
        }
      }
      if (activeTab === 'network') renderNetworkTab();
      updateStats();
    } else if (category === 'console') {
      consoleData.push(data);
      if (activeTab === 'console') renderConsoleTab();
      updateStats();
    }
  });

  function renderActiveTab() {
    if (activeTab === 'network') renderNetworkTab();
    else renderConsoleTab();
  }

  function renderNetworkTab() {
    const container = ui.networkContent;
    container.innerHTML = '';

    if (!monitoredWcId) {
      container.innerHTML = '<div class="debug-empty">Select a web panel to monitor</div>';
      return;
    }

    let filtered = networkData;
    if (filterText) {
      try {
        const re = new RegExp(filterText, 'i');
        filtered = filtered.filter(r => re.test(r.url));
      } catch {
        filtered = filtered.filter(r => r.url.toLowerCase().includes(filterText.toLowerCase()));
      }
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="debug-empty">No network requests</div>';
      return;
    }

    // Table header
    const header = document.createElement('div');
    header.className = 'debug-request-row debug-request-header';
    header.innerHTML = '<span class="dr-status">Status</span><span class="dr-method">Method</span><span class="dr-url">URL</span><span class="dr-type">Type</span><span class="dr-size">Size</span>';
    container.appendChild(header);

    for (const r of filtered) {
      const row = document.createElement('div');
      row.className = 'debug-request-row';

      // Status color
      let statusClass = 'dr-pending';
      let statusText = '...';
      if (r.failed) { statusClass = 'dr-failed'; statusText = 'FAIL'; }
      else if (r.status) {
        statusText = String(r.status);
        if (r.status >= 200 && r.status < 300) statusClass = 'dr-success';
        else if (r.status >= 300 && r.status < 400) statusClass = 'dr-redirect';
        else if (r.status >= 400) statusClass = 'dr-error';
      }

      const size = r.encodedDataLength != null ? formatBytesUI(r.encodedDataLength) : '';

      row.innerHTML = `<span class="dr-status ${statusClass}">${statusText}</span><span class="dr-method">${r.method || ''}</span><span class="dr-url" title="${escapeHtml(r.url)}">${escapeHtml(truncateUrl(r.url))}</span><span class="dr-type">${r.resourceType || ''}</span><span class="dr-size">${size}</span>`;

      if (r.failed && r.errorText) {
        const errorSpan = document.createElement('div');
        errorSpan.className = 'dr-error-detail';
        errorSpan.textContent = r.errorText;
        row.appendChild(errorSpan);
      }

      container.appendChild(row);
    }

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function renderConsoleTab() {
    const container = ui.consoleContent;
    container.innerHTML = '';

    if (!monitoredWcId) {
      container.innerHTML = '<div class="debug-empty">Select a web panel to monitor</div>';
      return;
    }

    const typeToLevel = {
      error: 'error', warning: 'warning', warn: 'warning',
      info: 'info', log: 'info', debug: 'debug', trace: 'debug', dir: 'debug', table: 'debug',
    };

    let filtered = consoleData.filter(m => {
      const level = typeToLevel[m.level] || 'info';
      return activeLevels.has(level);
    });

    if (filterText) {
      const lower = filterText.toLowerCase();
      filtered = filtered.filter(m => m.text.toLowerCase().includes(lower));
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="debug-empty">No console messages</div>';
      return;
    }

    for (const m of filtered) {
      const level = typeToLevel[m.level] || 'info';
      const entry = document.createElement('div');
      entry.className = `debug-console-entry debug-level-${level}`;

      const tag = document.createElement('span');
      tag.className = 'dc-level';
      tag.textContent = level.toUpperCase();
      entry.appendChild(tag);

      const text = document.createElement('span');
      text.className = 'dc-text';
      text.textContent = m.text;
      entry.appendChild(text);

      if (m.url) {
        const source = document.createElement('span');
        source.className = 'dc-source';
        source.textContent = `${shortenUrl(m.url)}${m.lineNumber != null ? ':' + m.lineNumber : ''}`;
        entry.appendChild(source);
      }

      container.appendChild(entry);
    }

    container.scrollTop = container.scrollHeight;
  }

  function updateStats() {
    if (!monitoredWcId) {
      ui.statsBar.textContent = 'No panel selected';
      return;
    }
    const errors = networkData.filter(r => r.failed || (r.status && r.status >= 400)).length;
    const consoleErrors = consoleData.filter(m => m.level === 'error').length;
    ui.statsBar.textContent = `Network: ${networkData.length} requests${errors ? ` (${errors} errors)` : ''} | Console: ${consoleData.length} messages${consoleErrors ? ` (${consoleErrors} errors)` : ''}`;
  }

  updateStats();

  // Helpers
  function formatBytesUI(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncateUrl(url) {
    if (url.length <= 80) return url;
    try {
      const u = new URL(url);
      const path = u.pathname + u.search;
      if (path.length > 60) return u.origin + path.slice(0, 57) + '...';
      return url;
    } catch {
      return url.slice(0, 77) + '...';
    }
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      return parts[parts.length - 1] || u.pathname;
    } catch {
      return url;
    }
  }

  const cleanup = () => {
    clearInterval(panelListInterval);
    removeEventListener();
    activeDebugPanels.delete(panel.id);
  };

  activeDebugPanels.set(panel.id, { cleanup });
}
