const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeApp', {
  getState: () => ipcRenderer.invoke('get-state'),
  pair: (code) => ipcRenderer.invoke('pair', code),
  unpair: () => ipcRenderer.invoke('unpair'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
