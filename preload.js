const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),

  createTerminal: (opts) => ipcRenderer.invoke('terminal:create', opts),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', { id }),

  onTerminalData: (id, callback) => {
    const channel = `terminal:data:${id}`;
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  onTerminalExit: (id, callback) => {
    const channel = `terminal:exit:${id}`;
    ipcRenderer.once(channel, callback);
  },

  onTerminalBrowserOpen: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('terminal:browser-open', listener);
    return () => ipcRenderer.removeListener('terminal:browser-open', listener);
  },

  debugGetCookies: (url) => ipcRenderer.invoke('debug:getCookies', { url }),
  debugGetCookieCount: () => ipcRenderer.invoke('debug:getCookieCount'),

  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:readDirectory', { dirPath }),
  scanDirectory: (rootDir, maxFiles) => ipcRenderer.invoke('fs:scanDirectory', { rootDir, maxFiles }),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),
  gitDiff: (filePath) => ipcRenderer.invoke('git:diff', { filePath }),
  gitStatus: (rootDir) => ipcRenderer.invoke('git:status', { rootDir }),

  // LSP
  lspGetRegistry: () => ipcRenderer.invoke('lsp:getRegistry'),
  lspStartServer: (opts) => ipcRenderer.invoke('lsp:startServer', opts),
  lspStopServer: (serverId) => ipcRenderer.invoke('lsp:stopServer', { serverId }),
  lspGetActiveServers: (groupId) => ipcRenderer.invoke('lsp:getActiveServers', { groupId }),
  lspSendRequest: (serverId, method, params) => ipcRenderer.invoke('lsp:sendRequest', { serverId, method, params }),
  lspSendNotification: (serverId, method, params) => ipcRenderer.invoke('lsp:sendNotification', { serverId, method, params }),

  // Search keystroke capture
  searchStartCapture: (webContentsId) => ipcRenderer.send('search:startCapture', { webContentsId }),
  searchStopCapture: (webContentsId) => ipcRenderer.send('search:stopCapture', { webContentsId }),
  onSearchKeystroke: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('search:keystroke', listener);
    return () => ipcRenderer.removeListener('search:keystroke', listener);
  },
  onWebviewRefresh: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('webview:refresh', listener);
    return () => ipcRenderer.removeListener('webview:refresh', listener);
  },
  onWebviewFind: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('webview:find', listener);
    return () => ipcRenderer.removeListener('webview:find', listener);
  },
  onWebviewOpenInNewPanel: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('webview:open-in-new-panel', listener);
    return () => ipcRenderer.removeListener('webview:open-in-new-panel', listener);
  },
  onWebviewBookmarkPage: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('webview:bookmark-page', listener);
    return () => ipcRenderer.removeListener('webview:bookmark-page', listener);
  },
  searchFindInPage: (webContentsId, text, options) =>
    ipcRenderer.invoke('search:findInPage', { webContentsId, text, options }),
  searchStopFindInPage: (webContentsId, action) =>
    ipcRenderer.invoke('search:stopFindInPage', { webContentsId, action }),
  onSearchFoundInPage: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('search:foundInPage', listener);
    return () => ipcRenderer.removeListener('search:foundInPage', listener);
  },

  // HTTP Basic Auth
  onAuthLoginRequest: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('auth:login-request', listener);
    return () => ipcRenderer.removeListener('auth:login-request', listener);
  },
  authLoginResponse: (requestId, username, password, cancelled) =>
    ipcRenderer.send('auth:login-response', { requestId, username, password, cancelled }),

  // Panel creation (MCP open_panel)
  onPanelCreateRequest: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('panel:create-request', listener);
    return () => ipcRenderer.removeListener('panel:create-request', listener);
  },
  panelCreateResponse: (requestId, panelId, error) =>
    ipcRenderer.send('panel:create-response', { requestId, panelId, error }),

  // Debug panel
  onDebugCdpEvent: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('debug:cdp-event', listener);
    return () => ipcRenderer.removeListener('debug:cdp-event', listener);
  },
  debugGetNetworkRequests: (wcId) => ipcRenderer.invoke('debug:getNetworkRequests', { wcId }),
  debugGetConsoleMessages: (wcId) => ipcRenderer.invoke('debug:getConsoleMessages', { wcId }),
  debugClearNetwork: (wcId) => ipcRenderer.invoke('debug:clearNetwork', { wcId }),
  debugClearConsole: (wcId) => ipcRenderer.invoke('debug:clearConsole', { wcId }),
  debugListPanels: () => ipcRenderer.invoke('debug:listPanels'),

  // CDP webview registration
  cdpRegisterWebview: (webContentsId, panelId, url) =>
    ipcRenderer.send('cdp:register-webview', { webContentsId, panelId, url }),
  cdpUnregisterWebview: (webContentsId) =>
    ipcRenderer.send('cdp:unregister-webview', { webContentsId }),
  cdpUpdateWebview: (webContentsId, url, title) =>
    ipcRenderer.send('cdp:update-webview', { webContentsId, url, title }),

  onLspNotification: (serverId, callback) => {
    const channel = `lsp:notification:${serverId}`;
    const listener = (_, msg) => callback(msg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // TLS certificate error handling for web panels
  tlsAllowHost: (webContentsId, host) =>
    ipcRenderer.invoke('tls:allow-host', { webContentsId, host }),
  tlsSetIgnoreAll: (enabled) =>
    ipcRenderer.invoke('tls:set-ignore-all', { enabled }),
  onTlsErrorDetails: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('tls:error-details', listener);
    return () => ipcRenderer.removeListener('tls:error-details', listener);
  },
});
