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
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch (e) {}
  });

  // Spawn the pty process
  const { id: termId, error } = await window.electronAPI.createTerminal({
    cols: terminal.cols,
    rows: terminal.rows,
    cwd: panel.cwd || undefined,
    initialCommand: panel.initialCommand || undefined,
  });

  if (error) {
    terminal.write(`\r\n\x1b[31mError: ${error}\x1b[0m\r\n`);
    activeTerminals.set(panel.id, { terminal, fitAddon, cleanup: () => terminal.dispose() });
    return;
  }

  // pty -> xterm
  const removeDataListener = window.electronAPI.onTerminalData(termId, data => {
    terminal.write(data);
  });

  window.electronAPI.onTerminalExit(termId, () => {
    terminal.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
    activeTerminals.delete(panel.id);
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
    removeDataListener();
    try { terminal.dispose(); } catch (e) {}
    window.electronAPI.killTerminal(termId);
    activeTerminals.delete(panel.id);
  };

  activeTerminals.set(panel.id, { terminal, fitAddon, cleanup, termId });
}
