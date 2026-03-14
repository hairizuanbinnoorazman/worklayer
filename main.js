const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
ipcMain.handle('terminal:create', (event, { cols, rows, cwd, initialCommand }) => {
  if (!pty) return { error: 'node-pty not available. Run: npm run postinstall' };

  const id = ++termIdCounter;
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : (process.env.SHELL || '/bin/bash');

  const spawnCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: spawnCwd,
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

  if (initialCommand) {
    term.write(initialCommand + '\r');
  }

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

// Directory picker
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) {
    return { cancelled: true };
  }
  return { path: result.filePaths[0] };
});

// File system IPC
ipcMain.handle('fs:readDirectory', (_, { dirPath }) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filtered = entries.filter(e => !e.name.startsWith('.'));
    const dirs = filtered.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = filtered.filter(e => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    return { entries: [...dirs, ...files].map(e => ({ name: e.name, isDirectory: e.isDirectory() })) };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fs:readFile', (_, { filePath }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fs:writeFile', (_, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

app.disableHardwareAcceleration();

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
