const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.warn('node-pty unavailable:', e.message);
}

let STATE_FILE;
const terminals = new Map();
let termIdCounter = 0;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// State persistence
ipcMain.handle('state:load', () => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
  return null;
});

ipcMain.handle('state:save', (_, state) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save state:', e);
    return false;
  }
});

// Terminal IPC
ipcMain.handle('terminal:create', (event, { cols, rows }) => {
  if (!pty) return { error: 'node-pty not available. Run: npm run postinstall' };

  const id = ++termIdCounter;
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : (process.env.SHELL || '/bin/bash');

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: process.env,
  });

  term.onData((data) => {
    event.sender.send(`terminal:data:${id}`, data);
  });

  term.onExit(() => {
    terminals.delete(id);
    event.sender.send(`terminal:exit:${id}`);
  });

  terminals.set(id, term);
  return { id };
});

ipcMain.handle('terminal:write', (_, { id, data }) => {
  const term = terminals.get(id);
  if (term) term.write(data);
});

ipcMain.handle('terminal:resize', (_, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term) {
    try { term.resize(cols, rows); } catch (e) {}
  }
});

ipcMain.handle('terminal:kill', (_, { id }) => {
  const term = terminals.get(id);
  if (term) {
    try { term.kill(); } catch (e) {}
    terminals.delete(id);
  }
});

app.whenReady().then(() => {
  STATE_FILE = path.join(app.getPath('userData'), 'worklayer-state.json');
  createWindow();
});

app.on('window-all-closed', () => {
  for (const [, term] of terminals) {
    try { term.kill(); } catch (e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
