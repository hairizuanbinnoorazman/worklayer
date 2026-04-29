// term-panel.js - Terminal panel backed by node-pty via IPC

const TERM_FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];

function findFontSizeIndex(size) {
  let closest = 0;
  let minDiff = Math.abs(TERM_FONT_SIZES[0] - size);
  for (let i = 1; i < TERM_FONT_SIZES.length; i++) {
    const diff = Math.abs(TERM_FONT_SIZES[i] - size);
    if (diff < minDiff) { minDiff = diff; closest = i; }
  }
  return closest;
}

function renderTermPanel(panel, container) {
  const profile = getActiveProfile();
  const defaultFontSize = getProfileDefaultTermFontSize(profile);
  const initialFontSize = panel.fontSize !== undefined ? panel.fontSize : defaultFontSize;
  let currentIndex = findFontSizeIndex(initialFontSize);

  // ── Zoom toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'term-toolbar';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'nav-btn';
  zoomOutBtn.textContent = '−';
  zoomOutBtn.title = 'Decrease font size';

  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'term-zoom-label';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'nav-btn';
  zoomInBtn.textContent = '+';
  zoomInBtn.title = 'Increase font size';

  function updateZoomUI() {
    zoomLabel.textContent = TERM_FONT_SIZES[currentIndex] + 'px';
    zoomOutBtn.disabled = currentIndex <= 0;
    zoomInBtn.disabled = currentIndex >= TERM_FONT_SIZES.length - 1;
  }
  updateZoomUI();

  function applyZoom(newIndex) {
    currentIndex = Math.max(0, Math.min(TERM_FONT_SIZES.length - 1, newIndex));
    const fontSize = TERM_FONT_SIZES[currentIndex];
    updateZoomUI();
    const entry = activeTerminals.get(panel.id);
    if (entry) {
      entry.terminal.options.fontSize = fontSize;
      try { entry.fitAddon.fit(); } catch (e) {}
    }
    updatePanelFontSize(panel.id, fontSize);
  }

  zoomInBtn.addEventListener('click', () => applyZoom(currentIndex + 1));
  zoomOutBtn.addEventListener('click', () => applyZoom(currentIndex - 1));
  zoomLabel.addEventListener('dblclick', () => {
    applyZoom(findFontSizeIndex(13));
  });
  zoomLabel.title = 'Double-click to reset to 13px';
  zoomLabel.style.cursor = 'pointer';

  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomLabel);
  toolbar.appendChild(zoomInBtn);
  container.appendChild(toolbar);

  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';
  container.appendChild(termContainer);

  // Listen for keyboard shortcut events dispatched from app.js
  termContainer.addEventListener('term-zoom-in', () => applyZoom(currentIndex + 1));
  termContainer.addEventListener('term-zoom-out', () => applyZoom(currentIndex - 1));
  termContainer.addEventListener('term-zoom-reset', () => applyZoom(findFontSizeIndex(13)));

  mountTerminal(panel, termContainer, TERM_FONT_SIZES[currentIndex]);
}

async function mountTerminal(panel, container, fontSize) {
  if (fontSize === undefined) fontSize = 13;

  // If a terminal already exists for this panel, remount it (group switch)
  if (activeTerminals.has(panel.id)) {
    const { terminal, fitAddon } = activeTerminals.get(panel.id);
    terminal.options.fontSize = fontSize;
    terminal.open(container);
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (e) {}
    });
    return;
  }

  // Create a new xterm Terminal
  const openLinkInPanel = (url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      addWebPanelAfter(panel.id, url);
    }
  };

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#0d0d0d',
      foreground: '#d4d4d4',
      cursor: '#c0a0ff',
      selectionBackground: '#3d2b6e',
    },
    scrollback: 5000,
    linkHandler: {
      activate: (_event, text) => openLinkInPanel(text),
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);

  const webLinksAddon = new WebLinksAddon.WebLinksAddon((_event, url) => openLinkInPanel(url));
  terminal.loadAddon(webLinksAddon);

  terminal.open(container);

  // Wait for DOM layout to settle, then fit before creating the PTY
  await new Promise(resolve => requestAnimationFrame(resolve));
  try { fitAddon.fit(); } catch (e) {}

  const resizeObserver = new ResizeObserver(() => {
    try { fitAddon.fit(); } catch (e) {}
  });
  resizeObserver.observe(container);

  // Spawn the pty process
  const { id: termId, error } = await window.electronAPI.createTerminal({
    cols: terminal.cols,
    rows: terminal.rows,
    cwd: panel.cwd || undefined,
    initialCommand: panel.initialCommand || undefined,
    profileId: getActiveProfile()?.id,
    groupId: getActiveGroupId(),
    interceptPdf: getProfileInterceptPdf(getActiveProfile()),
  });

  if (error) {
    terminal.write(`\r\n\x1b[31mError: ${error}\x1b[0m\r\n`);
    activeTerminals.set(panel.id, { terminal, fitAddon, searchAddon, cleanup: () => terminal.dispose() });
    renderStatusBar();
    return;
  }

  // pty -> xterm
  const removeDataListener = window.electronAPI.onTerminalData(termId, data => {
    terminal.write(data);
  });

  window.electronAPI.onTerminalExit(termId, () => {
    terminal.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
    activeTerminals.delete(panel.id);
    renderStatusBar();
  });

  // Shift+Enter: insert a newline without executing the command
  terminal.attachCustomKeyEventHandler(ev => {
    if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      window.electronAPI.writeTerminal(termId, '\x16\n');
      return false;
    }
    return true;
  });

  // xterm -> pty
  terminal.onData(data => {
    window.electronAPI.writeTerminal(termId, data);
  });

  // Sync resize
  terminal.onResize(({ cols, rows }) => {
    window.electronAPI.resizeTerminal(termId, cols, rows);
  });

  const cleanup = () => {
    resizeObserver.disconnect();
    removeDataListener();
    try { terminal.dispose(); } catch (e) {}
    window.electronAPI.killTerminal(termId);
    activeTerminals.delete(panel.id);
  };

  activeTerminals.set(panel.id, { terminal, fitAddon, searchAddon, cleanup, termId });
  renderStatusBar();
}
