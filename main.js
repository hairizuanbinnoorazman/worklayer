const { app, BrowserWindow, ipcMain, dialog, session, webContents, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

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

// Panel creation request tracking (MCP open_panel)
let panelRequestIdCounter = 0;
const pendingPanelCallbacks = new Map();

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

// CDP webview tracking
const webviewPanelMap = new Map(); // webContentsId -> { panelId, url, title }
const attachedDebuggers = new Map(); // webContentsId -> true

// Browser intercept: local HTTP server + helper scripts
let browserInterceptServer = null;
let browserInterceptPort = 0;
const browserInterceptToken = crypto.randomBytes(16).toString('hex');
let browserHelperDir = null;

function execFilePromise(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

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
ipcMain.handle('terminal:create', (event, { cols, rows, cwd, initialCommand, profileId, groupId }) => {
  if (!pty) return { error: 'node-pty not available. Run: npm run postinstall' };

  const id = ++termIdCounter;
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : (process.env.SHELL || '/bin/bash');

  const spawnCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const termEnv = { ...process.env };
  termEnv.WORKLAYER_TERM_ID = String(id);
  if (browserHelperDir) {
    termEnv.BROWSER = path.join(browserHelperDir, 'worklayer-browser');
    termEnv.PATH = browserHelperDir + ':' + (termEnv.PATH || '');
  }
  if (browserInterceptPort) {
    termEnv.WORKLAYER_MCP_PORT = String(browserInterceptPort);
    termEnv.WORKLAYER_MCP_TOKEN = browserInterceptToken;
  }
  if (profileId) termEnv.WORKLAYER_PROFILE_ID = String(profileId);
  if (groupId) termEnv.WORKLAYER_GROUP_ID = String(groupId);

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: spawnCwd,
    env: termEnv,
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

// Git diff IPC handler
ipcMain.handle('git:diff', async (_, { filePath }) => {
  const execOpts = { timeout: 5000, maxBuffer: 5 * 1024 * 1024 };
  const cwd = path.dirname(filePath);

  // Check if inside a git repo
  const topLevel = await execFilePromise('git', ['rev-parse', '--show-toplevel'], { ...execOpts, cwd });
  if (topLevel.error) return { changes: [] };

  // Check if there are any commits
  const headCheck = await execFilePromise('git', ['rev-parse', 'HEAD'], { ...execOpts, cwd });
  if (headCheck.error) {
    // No commits yet — treat entire file as added
    const content = fs.readFileSync(filePath, 'utf-8');
    const lineCount = content.split('\n').length;
    if (lineCount > 0) {
      return { changes: [{ type: 'added', startLine: 1, endLine: lineCount }] };
    }
    return { changes: [] };
  }

  // Check if file is tracked
  const lsFiles = await execFilePromise('git', ['ls-files', '--error-unmatch', filePath], { ...execOpts, cwd });
  if (lsFiles.error) {
    // Untracked file — all lines are added
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lineCount = content.split('\n').length;
      if (lineCount > 0) {
        return { changes: [{ type: 'added', startLine: 1, endLine: lineCount }] };
      }
    } catch (_e) {}
    return { changes: [] };
  }

  // Run git diff HEAD
  const diff = await execFilePromise('git', ['diff', 'HEAD', '--', filePath], { ...execOpts, cwd });
  if (!diff.stdout) return { changes: [] };

  // Parse unified diff
  const lines = diff.stdout.split('\n');
  const rawChanges = [];

  let newLine = 0;
  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!newLine) continue;

    if (line.startsWith('+')) {
      rawChanges.push({ type: 'added', line: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      rawChanges.push({ type: 'deleted', line: newLine });
      // deleted lines don't advance newLine
    } else if (!line.startsWith('\\')) {
      newLine++;
    }
  }

  // Classify: consecutive added after deleted = modified
  const classified = [];
  let i = 0;
  while (i < rawChanges.length) {
    if (rawChanges[i].type === 'deleted') {
      // Collect consecutive deleted
      const delStart = i;
      while (i < rawChanges.length && rawChanges[i].type === 'deleted') i++;
      const delCount = i - delStart;

      // Collect consecutive added that follow
      const addStart = i;
      while (i < rawChanges.length && rawChanges[i].type === 'added') i++;
      const addCount = i - addStart;

      // Pair up as modified
      const modCount = Math.min(delCount, addCount);
      for (let j = 0; j < modCount; j++) {
        classified.push({ type: 'modified', line: rawChanges[addStart + j].line });
      }

      // Remaining added
      for (let j = modCount; j < addCount; j++) {
        classified.push({ type: 'added', line: rawChanges[addStart + j].line });
      }

      // Remaining deleted (marker at the current new-file position)
      if (delCount > modCount) {
        const markerLine = addCount > 0 ? rawChanges[addStart + addCount - 1].line : rawChanges[delStart].line;
        classified.push({ type: 'deleted', line: markerLine });
      }
    } else {
      classified.push(rawChanges[i]);
      i++;
    }
  }

  // Consolidate consecutive same-type entries into ranges
  const changes = [];
  for (const entry of classified) {
    const last = changes[changes.length - 1];
    if (last && last.type === entry.type && entry.line === last.endLine + 1) {
      last.endLine = entry.line;
    } else {
      changes.push({ type: entry.type, startLine: entry.line, endLine: entry.line });
    }
  }

  return { changes };
});

// Git status IPC handler (for file tree coloring)
ipcMain.handle('git:status', async (_, { rootDir }) => {
  const execOpts = { timeout: 5000, maxBuffer: 1024 * 1024 };
  try {
    const topLevel = await execFilePromise('git', ['rev-parse', '--show-toplevel'], { ...execOpts, cwd: rootDir });
    if (topLevel.error) return { files: {} };
    const gitRoot = topLevel.stdout.trim();

    const status = await execFilePromise('git', ['status', '--porcelain'], { ...execOpts, cwd: gitRoot });
    if (status.error) return { files: {} };

    const files = {};
    for (const line of status.stdout.split('\n')) {
      if (!line || line.length < 4) continue;
      const xy = line.substring(0, 2);
      const filePart = line.substring(3);
      // Handle renames: "R  old -> new"
      const relPath = filePart.includes(' -> ') ? filePart.split(' -> ')[1] : filePart;
      const absPath = path.join(gitRoot, relPath);

      if (xy === '??') {
        files[absPath] = 'new';
      } else if (xy === 'A ' || xy === 'AM') {
        files[absPath] = 'new';
      } else if (xy === 'D ' || xy === ' D') {
        files[absPath] = 'deleted';
      } else {
        // M , MM,  M, etc.
        files[absPath] = 'modified';
      }
    }
    return { files };
  } catch (e) {
    return { files: {} };
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

// Panel creation response IPC (MCP open_panel)
ipcMain.on('panel:create-response', (_, { requestId, panelId, error }) => {
  const pending = pendingPanelCallbacks.get(requestId);
  if (!pending) return;
  pendingPanelCallbacks.delete(requestId);
  clearTimeout(pending.timer);
  if (error) pending.reject(new Error(error));
  else pending.resolve({ panelId });
});

// CDP webview registration IPC
ipcMain.on('cdp:register-webview', (_, { webContentsId, panelId, url, title }) => {
  webviewPanelMap.set(webContentsId, { panelId, url: url || '', title: title || '' });
  debugLog('[CDP] Registered webview wcId:', webContentsId, 'panelId:', panelId);
});

ipcMain.on('cdp:unregister-webview', (_, { webContentsId }) => {
  webviewPanelMap.delete(webContentsId);
  attachedDebuggers.delete(webContentsId);
  debugLog('[CDP] Unregistered webview wcId:', webContentsId);
});

ipcMain.on('cdp:update-webview', (_, { webContentsId, url, title }) => {
  const info = webviewPanelMap.get(webContentsId);
  if (info) {
    if (url !== undefined) info.url = url;
    if (title !== undefined) info.title = title;
  }
});

function setupBrowserHelperScripts() {
  browserHelperDir = path.join(app.getPath('userData'), 'browser-helpers');
  if (!fs.existsSync(browserHelperDir)) {
    fs.mkdirSync(browserHelperDir, { recursive: true });
  }

  // worklayer-browser: used as $BROWSER env var
  const worklayerBrowserPath = path.join(browserHelperDir, 'worklayer-browser');
  const worklayerBrowserScript = `#!/bin/sh
URL="$1"
if [ -z "$URL" ]; then exit 0; fi
TERM_ID="$WORKLAYER_TERM_ID"
curl -s -o /dev/null "http://127.0.0.1:${browserInterceptPort}/open?token=${browserInterceptToken}&termId=$TERM_ID&url=$(printf '%s' "$URL" | sed 's/ /%20/g; s/&/%26/g; s/?/%3F/g; s/#/%23/g')" 2>/dev/null
`;
  fs.writeFileSync(worklayerBrowserPath, worklayerBrowserScript, { mode: 0o755 });

  // open wrapper: intercepts URLs, passes non-URLs to /usr/bin/open
  const openWrapperPath = path.join(browserHelperDir, 'open');
  const openWrapperScript = `#!/bin/sh
# Worklayer open wrapper — intercepts URL arguments
IS_URL=0
TARGET=""
PASSTHROUGH_ARGS=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      IS_URL=1
      TARGET="$arg"
      ;;
    -*)
      PASSTHROUGH_ARGS="$PASSTHROUGH_ARGS $arg"
      ;;
    *)
      if [ -z "$TARGET" ]; then
        TARGET="$arg"
      else
        PASSTHROUGH_ARGS="$PASSTHROUGH_ARGS $arg"
      fi
      ;;
  esac
done
if [ "$IS_URL" = "1" ] && [ -n "$TARGET" ]; then
  TERM_ID="$WORKLAYER_TERM_ID"
  curl -s -o /dev/null "http://127.0.0.1:${browserInterceptPort}/open?token=${browserInterceptToken}&termId=$TERM_ID&url=$(printf '%s' "$TARGET" | sed 's/ /%20/g; s/&/%26/g; s/?/%3F/g; s/#/%23/g')" 2>/dev/null
else
  /usr/bin/open $PASSTHROUGH_ARGS "$TARGET"
fi
`;
  fs.writeFileSync(openWrapperPath, openWrapperScript, { mode: 0o755 });

  debugLog('[BrowserIntercept] Helper scripts written to', browserHelperDir);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function startBrowserInterceptServer() {
  return new Promise((resolve, reject) => {
    browserInterceptServer = http.createServer(async (req, res) => {
      try {
        const parsedUrl = new URL(req.url, `http://127.0.0.1`);
        const token = parsedUrl.searchParams.get('token');

        if (token !== browserInterceptToken) {
          debugLog('[BrowserIntercept] Invalid token');
          res.writeHead(403);
          res.end();
          return;
        }

        // --- /open: browser intercept from terminal ---
        if (parsedUrl.pathname === '/open') {
          const termId = parsedUrl.searchParams.get('termId');
          const openUrl = parsedUrl.searchParams.get('url');
          if (!openUrl) {
            res.writeHead(400);
            res.end();
            return;
          }

          debugLog('[BrowserIntercept] Open request: termId=', termId, 'url=', openUrl);
          const wins = BrowserWindow.getAllWindows();
          if (wins.length > 0 && !wins[0].webContents.isDestroyed()) {
            wins[0].webContents.send('terminal:browser-open', {
              termId: termId ? parseInt(termId, 10) : null,
              url: openUrl,
            });
          }
          res.writeHead(200);
          res.end('ok');
          return;
        }

        // --- /cdp/panels: list registered web panels ---
        if (parsedUrl.pathname === '/cdp/panels') {
          const panels = [];
          for (const [wcId, info] of webviewPanelMap) {
            const wc = webContents.fromId(wcId);
            if (wc && !wc.isDestroyed()) {
              panels.push({
                webContentsId: wcId,
                panelId: info.panelId,
                url: info.url || wc.getURL(),
                title: info.title || '',
              });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(panels));
          return;
        }

        // --- /cdp/command: send CDP command to a webview ---
        if (parsedUrl.pathname === '/cdp/command' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const { webContentsId: wcId, method, params } = body;
          const wc = webContents.fromId(wcId);
          if (!wc || wc.isDestroyed()) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'webContents not found or destroyed' }));
            return;
          }

          // Auto-attach debugger if needed
          if (!attachedDebuggers.has(wcId)) {
            try {
              wc.debugger.attach('1.3');
              attachedDebuggers.set(wcId, true);
              await wc.debugger.sendCommand('Page.enable');
              await wc.debugger.sendCommand('DOM.enable');
              await wc.debugger.sendCommand('Accessibility.enable');
              await wc.debugger.sendCommand('Network.enable');
              debugLog('[CDP] Attached debugger to wcId:', wcId);
            } catch (e) {
              debugLog('[CDP] Attach error:', e.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to attach debugger: ' + e.message }));
              return;
            }
          }

          try {
            const result = await wc.debugger.sendCommand(method, params || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (e) {
            debugLog('[CDP] Command error:', method, e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        // --- /cdp/detach: detach CDP debugger from a webview ---
        if (parsedUrl.pathname === '/cdp/detach' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const { webContentsId: wcId } = body;
          const wc = webContents.fromId(wcId);
          if (wc && !wc.isDestroyed() && attachedDebuggers.has(wcId)) {
            try { wc.debugger.detach(); } catch (e) {}
            attachedDebuggers.delete(wcId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // --- /open-panel: create a new web panel (MCP open_panel) ---
        if (parsedUrl.pathname === '/open-panel' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const { url: panelUrl, termId: reqTermId, profileId: reqProfileId, groupId: reqGroupId } = body;
          if (!panelUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'url is required' }));
            return;
          }

          const requestId = ++panelRequestIdCounter;
          try {
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingPanelCallbacks.delete(requestId);
                reject(new Error('Panel creation timed out'));
              }, 10000);
              pendingPanelCallbacks.set(requestId, { resolve, reject, timer });

              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0 && !wins[0].webContents.isDestroyed()) {
                wins[0].webContents.send('panel:create-request', {
                  requestId,
                  url: panelUrl,
                  termId: reqTermId !== undefined ? reqTermId : null,
                });
              } else {
                pendingPanelCallbacks.delete(requestId);
                clearTimeout(timer);
                reject(new Error('No renderer window available'));
              }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            debugLog('[open-panel] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        debugLog('[BrowserIntercept] Error:', e.message);
        res.writeHead(500);
        res.end();
      }
    });

    browserInterceptServer.listen(0, '127.0.0.1', () => {
      browserInterceptPort = browserInterceptServer.address().port;
      debugLog('[BrowserIntercept] Server listening on 127.0.0.1:' + browserInterceptPort);
      resolve();
    });

    browserInterceptServer.on('error', (err) => {
      debugLog('[BrowserIntercept] Server error:', err.message);
      reject(err);
    });
  });
}

// Re-enable GPU compositing (was disabled only to silence log noise in commit 79af0a5).
// Suppress the cosmetic GPU compositor warnings via log-level flag.
app.commandLine.appendSwitch('log-level', '3');

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
        if (input.type !== 'keyDown') return;
        const wcId = contents.id;

        // Intercept Cmd+R and Cmd+F before search capture logic —
        // works even on blank/crashed pages where injected JS can't run.
        if ((input.meta || input.control) && input.key.toLowerCase() === 'r') {
          event.preventDefault();
          const host = contents.hostWebContents;
          if (host && !host.isDestroyed()) {
            host.send('webview:refresh', { webContentsId: wcId });
          }
          return;
        }
        if ((input.meta || input.control) && input.key.toLowerCase() === 'f') {
          event.preventDefault();
          const host = contents.hostWebContents;
          if (host && !host.isDestroyed()) {
            host.send('webview:find', { webContentsId: wcId });
          }
          return;
        }

        if (!capturingWebContents.has(wcId)) return;
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

      contents.setWindowOpenHandler(({ url, disposition }) => {
        debugLog('[setWindowOpenHandler] url:', url, 'disposition:', disposition);
        if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          return { action: 'deny' };
        }
        const host = contents.hostWebContents;
        if (host && !host.isDestroyed()) {
          host.send('webview:open-in-new-panel', {
            url,
            sourceWebContentsId: contents.id,
            disposition,
          });
        }
        return { action: 'deny' };
      });

      contents.on('context-menu', (event, params) => {
        const menuTemplate = [];

        if (params.linkURL) {
          menuTemplate.push({
            label: 'Open Link in New Panel',
            click: () => {
              const host = contents.hostWebContents;
              if (host && !host.isDestroyed()) {
                host.send('webview:open-in-new-panel', {
                  url: params.linkURL,
                  sourceWebContentsId: contents.id,
                  disposition: 'new-window',
                });
              }
            },
          });
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

      contents.once('destroyed', () => {
        attachedDebuggers.delete(contents.id);
        webviewPanelMap.delete(contents.id);
      });
    }
  });

  // Custom application menu — omits Reload / Force Reload so Cmd+R
  // doesn't blow away the renderer (the renderer handles it per-panel).
  const appMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' },
      { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ]}] : []),
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      ...(process.platform === 'darwin'
        ? [{ type: 'separator' }, { role: 'front' }]
        : [{ role: 'close' }]),
    ]},
  ]);
  Menu.setApplicationMenu(appMenu);

  debugLog('About to call createWindow()');
  createWindow();
  debugLog('createWindow() returned');

  // Start browser intercept server and generate helper scripts
  try {
    await startBrowserInterceptServer();
    setupBrowserHelperScripts();
  } catch (e) {
    debugLog('[BrowserIntercept] Failed to start:', e.message);
  }

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

  // Clean up browser intercept server and helper scripts
  if (browserInterceptServer) {
    try { browserInterceptServer.close(); } catch (e) {}
  }
  if (browserHelperDir && fs.existsSync(browserHelperDir)) {
    try { fs.rmSync(browserHelperDir, { recursive: true, force: true }); } catch (e) {}
  }

  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
