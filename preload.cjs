const { contextBridge, ipcRenderer } = require('electron');
const terminalListeners = new Map();
contextBridge.exposeInMainWorld('agentRoomChat', {
  request: input => ipcRenderer.invoke('chat:request', input),
  subscribe: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
});
contextBridge.exposeInMainWorld('agentRoom', {
  desktop: true,
  openWorkbench: section => ipcRenderer.invoke('room:workbench', section),
  getState: () => ipcRenderer.invoke('room:state'),
  refresh: () => ipcRenderer.invoke('room:refresh'),
  send: payload => ipcRenderer.invoke('room:send', payload),
  createRoom: payload => ipcRenderer.invoke('room:create', payload),
  terminal: id => ipcRenderer.invoke('room:terminal', id),
  terminalInput: (id, data) => ipcRenderer.invoke('terminal:input', id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  stopSession: id => ipcRenderer.invoke('terminal:stop', id),
  inspectSession: id => ipcRenderer.invoke('session:inspect', id),
  respondSession: (id, requestId, answer) => ipcRenderer.invoke('session:respond', id, requestId, answer),
  cancelSession: id => ipcRenderer.invoke('session:cancel', id),
  onTerminal: (id, callback) => {
    const listener = (_, event) => { if (event.id === id) callback(event); }; ipcRenderer.on('terminal:event', listener);
    const count = terminalListeners.get(id) || 0; terminalListeners.set(id, count + 1);
    if (!count) ipcRenderer.send('terminal:subscribe', id);
    let disposed = false;
    return () => {
      if (disposed) return; disposed = true;
      ipcRenderer.removeListener('terminal:event', listener);
      const remaining = terminalListeners.get(id) - 1;
      if (remaining) terminalListeners.set(id, remaining);
      else { terminalListeners.delete(id); ipcRenderer.send('terminal:unsubscribe', id); }
    };
  },
  launch: payload => ipcRenderer.invoke('room:launch', payload),
  createWorkspace: payload => ipcRenderer.invoke('room:workspace', payload),
  saveConnection: payload => ipcRenderer.invoke('connection:save', payload),
  removeConnection: id => ipcRenderer.invoke('connection:remove', id),
  testConnection: payload => ipcRenderer.invoke('connection:test', payload),
  chooseCertificate: kind => ipcRenderer.invoke('connection:certificate', kind),
  getUsage: () => ipcRenderer.invoke('usage:state'),
  saveCapabilityServer: payload => ipcRenderer.invoke('capability:server-save', payload),
  importCapabilitySkill: payload => ipcRenderer.invoke('capability:skill-import', payload),
  removeCapability: payload => ipcRenderer.invoke('capability:remove', payload),
  bindCapabilities: payload => ipcRenderer.invoke('capability:bind', payload),
  testCapabilityServer: payload => ipcRenderer.invoke('capability:test', payload),
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
