const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEBUG_LOG = '/tmp/worklayer-debug.log';
function debugLog(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(DEBUG_LOG, msg); } catch (_) {}
}
debugLog('=== main.js loaded ===');

process.on('unhandledRejection', (reason) => {
  debugLog('Unhandled rejection:', String(reason), reason?.stack || '');
});

const lspManager = require('./lsp-manager');

let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.warn('node-pty unavailable:', e.message);
}

let STATE_FILE;
let cookieBackupFile;
let cookieSaveInterval;
const terminals = new Map();
let termIdCounter = 0;

function saveSessionCookies() {
  if (!cookieBackupFile) return;
  const ses = session.fromPartition('persist:webpanels');
  ses.cookies.get({}).then(allCookies => {
    const sessionCookies = allCookies.filter(c => !c.expirationDate);
    fs.writeFileSync(cookieBackupFile, JSON.stringify(sessionCookies, null, 2));
    debugLog('[CookieSave] Saved', sessionCookies.length, 'session cookies (of', allCookies.length, 'total)');
  }).catch(e => {
    debugLog('[CookieSave] Failed:', e.message);
  });
}

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

  win.on('close', () => {
    lspManager.stopAllServers();
    for (const [id, term] of terminals) {
      try { term.kill(); } catch (e) {}
    }
    terminals.clear();
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
    if (!event.sender.isDestroyed()) {
      event.sender.send(`terminal:data:${id}`, data);
    }
  });

  term.onExit(() => {
    terminals.delete(id);
    if (!event.sender.isDestroyed()) {
      event.sender.send(`terminal:exit:${id}`);
    }
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

// Debug cookie inspection for persist:webpanels partition
ipcMain.handle('debug:getCookies', async (_, { url }) => {
  const ses = session.fromPartition('persist:webpanels');
  const cookies = await ses.cookies.get({ url });
  return cookies;
});

ipcMain.handle('debug:getCookieCount', async () => {
  const ses = session.fromPartition('persist:webpanels');
  const cookies = await ses.cookies.get({});
  const sessionCookies = cookies.filter(c => !c.expirationDate);
  return {
    total: cookies.length,
    session: sessionCookies.length,
    persistent: cookies.length - sessionCookies.length,
  };
});

// LSP IPC handlers
ipcMain.handle('lsp:getRegistry', () => {
  return lspManager.getServerRegistry();
});

ipcMain.handle('lsp:startServer', (event, { groupId, rootDir, serverKey }) => {
  return lspManager.startServer(event.sender, { groupId, rootDir, serverKey });
});

ipcMain.handle('lsp:stopServer', (_, { serverId }) => {
  lspManager.stopServer(serverId);
  return { success: true };
});

ipcMain.handle('lsp:getActiveServers', (_, { groupId }) => {
  return lspManager.getActiveServers(groupId);
});

ipcMain.handle('lsp:sendRequest', async (_, { serverId, method, params }) => {
  try {
    return await lspManager.sendRequest(serverId, method, params);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('lsp:sendNotification', (_, { serverId, method, params }) => {
  lspManager.sendNotification(serverId, method, params);
  return { success: true };
});

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  debugLog('whenReady callback entered');
  STATE_FILE = path.join(app.getPath('userData'), 'worklayer-state.json');
  cookieBackupFile = path.join(app.getPath('userData'), 'session-cookies.json');
  debugLog('userData path:', app.getPath('userData'));
  debugLog('cookieBackupFile:', cookieBackupFile);

  const ses = session.fromPartition('persist:webpanels');

  // One-time migration: clear stale persistent cookies created by the old
  // cookies.on('changed') fix that converted session cookies to persistent ones.
  const migrationFlag = path.join(app.getPath('userData'), '.cookie-migration-v2-done');
  if (!fs.existsSync(migrationFlag)) {
    debugLog('[Migration] Clearing stale persistent cookies from old fix');
    try {
      const allCookies = await ses.cookies.get({});
      const stalePersistent = allCookies.filter(c => c.expirationDate);
      for (const cookie of stalePersistent) {
        const protocol = cookie.secure ? 'https' : 'http';
        const domain = cookie.domain.startsWith('.')
          ? cookie.domain.substring(1) : cookie.domain;
        const url = `${protocol}://${domain}${cookie.path || '/'}`;
        await ses.cookies.remove(url, cookie.name);
      }
      debugLog('[Migration] Removed', stalePersistent.length, 'stale persistent cookies');
      fs.writeFileSync(migrationFlag, new Date().toISOString());
    } catch (e) {
      debugLog('[Migration] Error:', e.message, e.stack);
    }
  }

  // Restore session cookies from previous shutdown
  try {
    const backupExists = fs.existsSync(cookieBackupFile);
    debugLog('Cookie backup file exists:', backupExists);
    if (backupExists) {
      const raw = fs.readFileSync(cookieBackupFile, 'utf-8');
      debugLog('Cookie backup file size:', raw.length, 'bytes');
      const backed = JSON.parse(raw);
      debugLog('Parsed', backed.length, 'cookies from backup');
      let restored = 0;
      let failed = 0;
      for (const cookie of backed) {
        const protocol = cookie.secure ? 'https' : 'http';
        const domain = cookie.domain.startsWith('.')
          ? cookie.domain.substring(1) : cookie.domain;
        const url = `${protocol}://${domain}${cookie.path || '/'}`;
        try {
          await ses.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite || 'unspecified',
          });
          restored++;
        } catch (e) {
          failed++;
          debugLog('[CookieRestore] FAIL:', cookie.name, '@', cookie.domain, '-', e.message);
        }
      }
      debugLog('[CookieRestore] Done. Restored:', restored, 'Failed:', failed);
    }
  } catch (e) {
    debugLog('[CookieRestore] Fatal error:', e.message, e.stack);
  }

  // Log webview render process crashes
  app.on('web-contents-created', (_, contents) => {
    debugLog('[web-contents-created] type:', contents.getType());
    contents.on('render-process-gone', (event, details) => {
      debugLog('[render-process-gone] reason:', details.reason, 'exitCode:', details.exitCode);
    });
    contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      debugLog('[did-fail-load] code:', errorCode, 'desc:', errorDescription, 'url:', validatedURL);
    });
    contents.on('console-message', (event, level, message, line, sourceId) => {
      debugLog('[webcontents-console]', `level:${level}`, message);
    });
  });

  debugLog('About to call createWindow()');
  createWindow();
  debugLog('createWindow() returned');

  // Periodically save session cookies to disk (every 60s)
  cookieSaveInterval = setInterval(saveSessionCookies, 60 * 1000);
  debugLog('Cookie save interval started (60s)');
}).catch(err => {
  debugLog('FATAL whenReady error:', err.message, err.stack);
});

app.on('window-all-closed', () => {
  debugLog('[window-all-closed] saving cookies and cleaning up');
  clearInterval(cookieSaveInterval);
  saveSessionCookies();
  lspManager.stopAllServers();
  for (const [, term] of terminals) {
    try { term.kill(); } catch (e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
