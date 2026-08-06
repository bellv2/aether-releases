// Bridges the update system into the page without turning on node
// integration — the page can ask about updates and trigger one, and
// nothing more. Keeps contextIsolation on, which is the safe default.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aetherUpdater', {
  check: () => ipcRenderer.invoke('updater:check'),
  install: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:version'),
  onStatus: (cb) => {
    ipcRenderer.on('updater:status', (_e, payload) => cb(payload));
  },
});
