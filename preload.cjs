const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentRoom', {
  desktop: true,
  getState: () => ipcRenderer.invoke('room:state'),
  refresh: () => ipcRenderer.invoke('room:refresh'),
  send: payload => ipcRenderer.invoke('room:send', payload),
  createRoom: payload => ipcRenderer.invoke('room:create', payload),
  terminal: id => ipcRenderer.invoke('room:terminal', id),
  launch: payload => ipcRenderer.invoke('room:launch', payload),
  createWorkspace: payload => ipcRenderer.invoke('room:workspace', payload),
  saveConnection: payload => ipcRenderer.invoke('connection:save', payload),
  removeConnection: id => ipcRenderer.invoke('connection:remove', id),
  testConnection: payload => ipcRenderer.invoke('connection:test', payload),
  chooseCertificate: kind => ipcRenderer.invoke('connection:certificate', kind),
  getUsage: () => ipcRenderer.invoke('usage:state'),
  onUsage: callback => {
    const listener = (_, state) => callback(state); ipcRenderer.on('usage:state', listener);
    return () => ipcRenderer.removeListener('usage:state', listener);
  },
  chooseDirectory: () => ipcRenderer.invoke('room:directory'),
  openSource: () => ipcRenderer.invoke('room:open-source'),
  windowAction: action => ipcRenderer.send('window:action', action),
  onState: callback => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('room:state', listener);
    return () => ipcRenderer.removeListener('room:state', listener);
  },
});
