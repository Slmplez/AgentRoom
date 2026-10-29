const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage, Tray, nativeImage } = require('electron');
const path = require('node:path');
const { HcomService } = require('./lib/hcom-service.cjs');

app.setName('Agent Room');
// An isolated UI preview keeps the running app and its model gateways alive.
if (process.argv.includes('--ui-preview')) app.setPath('userData', path.join(__dirname, 'artifacts', 'ui-preview-profile'));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window;
let service;
let tray;
let quitting = false;

function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
function keepGatewayInTray() {
  if (!tray) {
    const zlib = require('node:zlib');
    function chunk(type, data) {
      const name = Buffer.from(type), body = Buffer.concat([name, data]);
      let crc = 0xffffffff;
      for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, body, checksum]);
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
    const pixels = Buffer.alloc(32 * (1 + 32 * 4));
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const at = y * 129 + 1 + x * 4, dot = ((x - 10) ** 2 + (y - 14) ** 2 < 6) || ((x - 22) ** 2 + (y - 14) ** 2 < 6);
      pixels.set(dot ? [255, 255, 255, 255] : [80, 156, 220, 255], at);
    }
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
    tray = new Tray(nativeImage.createFromBuffer(png));
    tray.setToolTip('Agent Room · 模型网关运行中');
    tray.on('double-click', showWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Agent Room', click: showWindow },
      { label: '退出并停止模型转发', click: () => { quitting = true; app.quit(); } },
    ]));
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1460, height: 990, minWidth: 1030, minHeight: 720, show: false,
    title: 'Agent Room', backgroundColor: '#fcfcfb', titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (!quitting && service?.gateways.size) { event.preventDefault(); keepGatewayInTray(); window.hide(); }
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
if (single) app.whenReady().then(async () => {
  service = new HcomService({ secretStorage: safeStorage });
  ipcMain.handle('room:state', () => service.snapshot());
  ipcMain.handle('room:refresh', () => service.rescan());
  ipcMain.handle('room:send', (_, payload) => service.send(payload));
  ipcMain.handle('room:create', (_, payload) => service.createRoom(payload));
  ipcMain.handle('room:terminal', (_, id) => service.terminal(id));
  ipcMain.handle('room:launch', (_, payload) => service.launch(payload));
  ipcMain.handle('room:workspace', (_, payload) => service.createWorkspace(payload));
  ipcMain.handle('connection:save', (_, payload) => service.saveConnection(payload));
  ipcMain.handle('connection:remove', (_, id) => service.removeConnection(id));
  ipcMain.handle('connection:test', (_, payload) => service.testConnection(payload));
  ipcMain.handle('usage:state', () => service.usage.snapshot());
  service.on('usage', stats => { if (window && !window.isDestroyed()) window.webContents.send('usage:state', stats); });
  ipcMain.handle('connection:certificate', async (_, kind) => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: kind === 'key' ? '选择客户端私钥（PEM）' : '选择证书（PEM）',
      filters: [{ name: 'PEM 证书与私钥', extensions: ['pem', 'crt', 'cer', 'key'] }, { name: '所有文件', extensions: ['*'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('room:directory', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择 agent 工作目录' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('window:action', (_, action) => {
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
  });
  ipcMain.handle('room:open-source', () => shell.openExternal('https://github.com/aannoo/hcom'));
  service.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('room:state', state); });
  createWindow();
  await service.start();
});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  quitting = true; service?.close(); tray?.destroy(); tray = null;
  if (service && !service.usageFlushed) {
    event.preventDefault(); service.usageFlushed = true;
    service.usage.pending.finally(() => app.quit());
  }
});
