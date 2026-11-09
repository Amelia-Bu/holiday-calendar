const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nat', {
  setHeight: (h) => ipcRenderer.send('set-height', h),
  hide: () => ipcRenderer.send('hide'),
  openUrl: (u) => ipcRenderer.send('open-url', u),
  onRefresh: (cb) => ipcRenderer.on('refresh', () => cb())
});
