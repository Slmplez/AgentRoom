const { contextBridge, ipcRenderer } = require('electron');
if (!process.argv.includes('--persistent-ui')) contextBridge.exposeInMainWorld('agentRoomChat', {
  request: input => ipcRenderer.invoke('chat:request', input),
  subscribe: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
});
contextBridge.exposeInMainWorld('agentRoomPlatform', {
  ...(!process.argv.includes('--persistent-ui') ? {
  openWorkbench: section => ipcRenderer.invoke('platform:workbench', section),
  chooseCertificate: kind => ipcRenderer.invoke('platform:certificate', kind),
  chooseDirectory: () => ipcRenderer.invoke('platform:directory'),
  } : {}),
  openSource: () => ipcRenderer.invoke('platform:open-source'),
  windowAction: action => ipcRenderer.send('platform:window', action),
});
