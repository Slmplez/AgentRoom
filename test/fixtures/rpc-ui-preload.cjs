const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentRoomChat', {
  request: input => ipcRenderer.invoke('chat:request', input),
  subscribe: callback => { const listener = (_, event) => callback(event); ipcRenderer.on('chat:event', listener); return () => ipcRenderer.removeListener('chat:event', listener); },
});
contextBridge.exposeInMainWorld('agentRoom', {
  desktop: true, getState: () => ipcRenderer.invoke('fixture:state'),
  refresh: () => ipcRenderer.invoke('fixture:state'), onState: callback => { const handler = (_, state) => callback(state); ipcRenderer.on('fixture:update', handler); return () => ipcRenderer.removeListener('fixture:update', handler); },
  send: payload => ipcRenderer.invoke('fixture:send', payload),
  inspectSession: id => ipcRenderer.invoke('fixture:inspect', id),
  respondSession: (id, requestId, answer) => ipcRenderer.invoke('fixture:respond', id, requestId, answer),
  cancelSession: id => ipcRenderer.invoke('fixture:cancel', id), stopSession: id => ipcRenderer.invoke('fixture:stop', id),
  windowAction: () => {}, onUsage: () => () => {},
});
