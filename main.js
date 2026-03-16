const { app, BrowserWindow, ipcMain, dialog, session, webContents, Menu, clipboard } = require('electron');
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

// Track which webContents are in search keystroke capture mode
const capturingWebContents = new Set();

// HTTP Basic Auth request tracking
let authRequestIdCounter = 0;
const pendingAuthCallbacks = new Map();

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
  debugLog('[IPC] lsp:getRegistry');
  return lspManager.getServerRegistry();
});

ipcMain.handle('lsp:startServer', async (event, { groupId, rootDir, serverKey }) => {
  debugLog(`[IPC] lsp:startServer serverKey=${serverKey} rootDir=${rootDir}`);
  const result = await lspManager.startServer(event.sender, { groupId, rootDir, serverKey });
  debugLog(`[IPC] lsp:startServer result:`, JSON.stringify(result));
  return result;
});

ipcMain.handle('lsp:stopServer', (_, { serverId }) => {
  debugLog(`[IPC] lsp:stopServer serverId=${serverId}`);
  lspManager.stopServer(serverId);
  return { success: true };
});

ipcMain.handle('lsp:getActiveServers', (_, { groupId }) => {
  debugLog(`[IPC] lsp:getActiveServers groupId=${groupId}`);
  return lspManager.getActiveServers(groupId);
});

ipcMain.handle('lsp:sendRequest', async (_, { serverId, method, params }) => {
  debugLog(`[IPC] lsp:sendRequest serverId=${serverId} method=${method}`);
  try {
    const result = await lspManager.sendRequest(serverId, method, params);
    debugLog(`[IPC] lsp:sendRequest response for ${method}: hasResult=${!!result?.result} hasError=${!!result?.error}`);
    return result;
  } catch (e) {
    debugLog(`[IPC] lsp:sendRequest error for ${method}: ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('lsp:sendNotification', (_, { serverId, method, params }) => {
  debugLog(`[IPC] lsp:sendNotification serverId=${serverId} method=${method}`);
  lspManager.sendNotification(serverId, method, params);
  return { success: true };
});

// Search keystroke capture IPC
ipcMain.on('search:startCapture', (e, { webContentsId }) => {
  capturingWebContents.add(webContentsId);
  debugLog('[Search] startCapture wcId:', webContentsId);
});

ipcMain.on('search:stopCapture', (e, { webContentsId }) => {
  capturingWebContents.delete(webContentsId);
  debugLog('[Search] stopCapture wcId:', webContentsId);
});

ipcMain.handle('search:findInPage', (_, { webContentsId, text, options }) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return null;
  const requestId = wc.findInPage(text, options);
  debugLog('[Search] findInPage wcId:', webContentsId, 'text:', text, 'opts:', JSON.stringify(options), 'requestId:', requestId);
  return requestId;
});

ipcMain.handle('search:stopFindInPage', (_, { webContentsId, action }) => {
  debugLog('[Search] stopFindInPage wcId:', webContentsId, 'action:', action);
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) wc.stopFindInPage(action);
});

// HTTP Basic Auth IPC
ipcMain.on('auth:login-response', (_, { requestId, username, password, cancelled }) => {
  const callback = pendingAuthCallbacks.get(requestId);
  pendingAuthCallbacks.delete(requestId);
  if (!callback) return;
  if (cancelled) callback();
  else callback(username, password);
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

    // Intercept keystrokes in webview contents when search capture is active
    if (contents.getType() === 'webview') {
      contents.on('before-input-event', (event, input) => {
        const wcId = contents.id;
        if (!capturingWebContents.has(wcId)) return;
        if (input.type !== 'keyDown') return;
        // Allow system shortcuts through
        if ((input.meta || input.control) && ['c', 'v', 'a', 'x', 'z'].includes(input.key.toLowerCase())) return;
        // Skip modifier-only keys
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(input.key)) return;

        const shouldIntercept = input.key.length === 1 || input.key === 'Backspace' || input.key === 'Enter' || input.key === 'Escape';
        if (!shouldIntercept) return;

        event.preventDefault();
        const host = contents.hostWebContents;
        if (host && !host.isDestroyed()) {
          host.send('search:keystroke', { webContentsId: wcId, key: input.key, shift: input.shift });
        }
      });

      contents.on('found-in-page', (event, result) => {
        debugLog('[Search] found-in-page wcId:', contents.id, 'requestId:', result.requestId,
          'active:', result.activeMatchOrdinal, 'matches:', result.matches, 'final:', result.finalUpdate);
        const host = contents.hostWebContents;
        if (host && !host.isDestroyed()) {
          host.send('search:foundInPage', { webContentsId: contents.id, result });
        }
      });

      contents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
        event.preventDefault();
        const requestId = ++authRequestIdCounter;
        pendingAuthCallbacks.set(requestId, callback);
        const host = contents.hostWebContents;
        if (host && !host.isDestroyed()) {
          host.send('auth:login-request', {
            requestId, webContentsId: contents.id,
            url: authenticationResponseDetails.url,
            host: authInfo.host, port: authInfo.port,
            realm: authInfo.realm, scheme: authInfo.scheme,
            isProxy: authInfo.isProxy,
          });
        } else {
          pendingAuthCallbacks.delete(requestId);
          callback();
        }
      });

      contents.on('context-menu', (event, params) => {
        const menuTemplate = [];

        if (params.linkURL) {
          menuTemplate.push({
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL),
          });
          menuTemplate.push({ type: 'separator' });
        }

        if (params.isEditable) {
          menuTemplate.push({ label: 'Cut', role: 'cut' });
          menuTemplate.push({ label: 'Copy', role: 'copy' });
          menuTemplate.push({ label: 'Paste', role: 'paste' });
          menuTemplate.push({ label: 'Select All', role: 'selectAll' });
        } else if (params.selectionText) {
          menuTemplate.push({ label: 'Copy', role: 'copy' });
        }

        if (menuTemplate.length > 0 && menuTemplate[menuTemplate.length - 1].type !== 'separator') {
          menuTemplate.push({ type: 'separator' });
        }

        menuTemplate.push({
          label: 'Back',
          enabled: contents.canGoBack(),
          click: () => contents.goBack(),
        });
        menuTemplate.push({
          label: 'Forward',
          enabled: contents.canGoForward(),
          click: () => contents.goForward(),
        });
        menuTemplate.push({
          label: 'Reload',
          click: () => contents.reload(),
        });
        menuTemplate.push({ type: 'separator' });
        menuTemplate.push({
          label: 'Copy Page URL',
          click: () => clipboard.writeText(contents.getURL()),
        });

        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup();
      });
    }
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
