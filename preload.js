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

  debugGetCookies: (url) => ipcRenderer.invoke('debug:getCookies', { url }),
  debugGetCookieCount: () => ipcRenderer.invoke('debug:getCookieCount'),

  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:readDirectory', { dirPath }),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),
});
