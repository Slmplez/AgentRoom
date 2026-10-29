const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentRoom', {
  desktop: true, getState: () => ipcRenderer.invoke('fixture:state'),
  refresh: () => ipcRenderer.invoke('fixture:state'), onState: () => () => {},
  inspectSession: id => ipcRenderer.invoke('fixture:inspect', id),
  respondSession: (id, requestId, answer) => ipcRenderer.invoke('fixture:respond', id, requestId, answer),
  cancelSession: id => ipcRenderer.invoke('fixture:cancel', id), stopSession: id => ipcRenderer.invoke('fixture:stop', id),
  windowAction: () => {}, onUsage: () => () => {},
});
