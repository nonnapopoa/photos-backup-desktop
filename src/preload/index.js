'use strict';

// Preload bridge: the renderer's entire view of the main process.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photosBackup', {
  getState: () => ipcRenderer.invoke('get-state'),
  connectAccount: () => ipcRenderer.invoke('connect-account'),
  disconnectAccount: () => ipcRenderer.invoke('disconnect-account'),
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  removeFolder: (folder) => ipcRenderer.invoke('remove-folder', folder),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  runBackup: () => ipcRenderer.invoke('run-backup'),
  recheckBackup: () => ipcRenderer.invoke('recheck-backup'),
  pause: () => ipcRenderer.invoke('queue-pause'),
  resume: () => ipcRenderer.invoke('queue-resume'),
  cancelAll: () => ipcRenderer.invoke('queue-cancel'),
  retryFailed: () => ipcRenderer.invoke('queue-retry-failed'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  on: (channel, listener) => {
    const allowed = ['account-state', 'settings', 'queue-snapshot', 'scan-started', 'scan-finished', 'account-warning'];
    if (!allowed.includes(channel)) return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
