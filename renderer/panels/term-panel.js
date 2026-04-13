// term-panel.js - Terminal panel backed by node-pty via IPC

function renderTermPanel(panel, container) {
  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';
  container.appendChild(termContainer);
  mountTerminal(panel, termContainer);
}

async function mountTerminal(panel, container) {
  // If a terminal already exists for this panel, remount it (group switch)
  if (activeTerminals.has(panel.id)) {
    const { terminal, fitAddon } = activeTerminals.get(panel.id);
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
    fontSize: 13,
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
