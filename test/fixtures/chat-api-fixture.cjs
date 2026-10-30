const { EventEmitter } = require('node:events');

// Fixtures cross the production DTO boundary; the preload never normalizes raw state.
async function installChatFixture(ipcMain, getWindow, { snapshot, send, respondSession }) {
  const { createChatApi } = await import('../../lib/chat-api.mjs');
  const service = Object.assign(new EventEmitter(), { snapshot, send, respondSession });
  const api = createChatApi(service);
  ipcMain.handle('chat:request', (_, input) => api.request(input));
  api.subscribe(event => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('chat:event', event); });
  return { publish: () => service.emit('state', snapshot()), close: () => { api.close(); ipcMain.removeHandler('chat:request'); } };
}
module.exports = { installChatFixture };
