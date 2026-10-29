const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage, Tray, nativeImage, utilityProcess } = require('electron');
const path = require('node:path');
const { HcomService } = require('./lib/hcom-service.cjs');
const { RpcRuntime } = require('./lib/rpc-runtime.cjs');

app.setName('Agent Room');
if (process.platform === 'win32') app.setAppUserModelId(process.argv.includes('--ui-preview') ? 'com.agentroom.desktop.preview' : 'com.agentroom.desktop');
// An isolated UI preview keeps the running app and its model gateways alive.
if (process.argv.includes('--ui-preview')) app.setPath('userData', path.join(__dirname, 'artifacts', 'ui-preview-profile'));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window;
let service;
let tray;
let quitting = false;
const terminalSubscriptions = new Set();

function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
function keepGatewayInTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'brand', 'tray.png')));
    tray.setToolTip('Agent Room · 会话运行中');
    tray.on('double-click', showWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Agent Room', click: showWindow },
      { label: '退出并停止托管会话与模型转发', click: () => { quitting = true; app.quit(); } },
    ]));
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1460, height: 990, minWidth: 1030, minHeight: 720, show: false,
    title: 'Agent Room', backgroundColor: '#fcfcfb', titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', 'brand', 'app.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-start-loading', () => terminalSubscriptions.clear());
  window.webContents.on('render-process-gone', () => terminalSubscriptions.clear());
  window.webContents.on('destroyed', () => terminalSubscriptions.clear());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (!quitting && (service?.gateways.size || service?.runtime?.activeSessions)) { event.preventDefault(); keepGatewayInTray(); window.hide(); }
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
if (single) app.whenReady().then(async () => {
  const dataDir = app.isPackaged || process.argv.includes('--ui-preview') ? app.getPath('userData') : path.join(__dirname, '.data');
  // Preview isolates UI preferences and data, but keeps the same background session host.
  // Never switch the Add Agent button back to the external terminal launcher.
  const runtime = new RpcRuntime({ dataDir, fork: utilityProcess.fork.bind(utilityProcess), resourcesPath: app.isPackaged ? path.join(process.resourcesPath, 'native') : undefined });
  service = new HcomService({ dataDir, secretStorage: safeStorage, runtime });
  ipcMain.handle('room:state', () => service.snapshot());
  ipcMain.handle('room:refresh', () => service.rescan());
  ipcMain.handle('room:send', (_, payload) => service.send(payload));
  ipcMain.handle('room:create', (_, payload) => service.createRoom(payload));
  ipcMain.handle('room:terminal', (_, id) => service.terminal(id));
  ipcMain.handle('terminal:input', (_, id, data) => service.terminalInput(id, data));
  ipcMain.handle('terminal:resize', (_, id, cols, rows) => service.terminalResize(id, cols, rows));
  ipcMain.handle('terminal:stop', (_, id) => service.stopSession(id));
  ipcMain.handle('session:inspect', (_, id) => service.inspectSession(id));
  ipcMain.handle('session:respond', (_, id, requestId, answer) => service.respondSession(id, requestId, answer));
  ipcMain.handle('session:cancel', (_, id) => service.cancelSession(id));
  ipcMain.on('terminal:subscribe', (event, id) => {
    if (event.sender === window?.webContents && typeof id === 'string') terminalSubscriptions.add(id);
  });
  ipcMain.on('terminal:unsubscribe', (event, id) => {
    if (event.sender === window?.webContents) terminalSubscriptions.delete(id);
  });
  service.on('terminal', event => { if (terminalSubscriptions.has(event.id) && window && !window.isDestroyed()) window.webContents.send('terminal:event', event); });
  ipcMain.handle('room:launch', (_, payload) => service.launch(payload));
  ipcMain.handle('room:workspace', (_, payload) => service.createWorkspace(payload));
  ipcMain.handle('connection:save', (_, payload) => service.saveConnection(payload));
  ipcMain.handle('connection:remove', (_, id) => service.removeConnection(id));
  ipcMain.handle('connection:test', (_, payload) => service.testConnection(payload));
  ipcMain.handle('usage:state', () => service.usage.snapshot());
  ipcMain.handle('capability:server-save', (_, payload) => service.saveCapabilityServer(payload));
  ipcMain.handle('capability:skill-import', (_, payload) => service.importCapabilitySkill(payload));
  ipcMain.handle('capability:remove', (_, payload) => service.removeCapability(payload));
  ipcMain.handle('capability:bind', (_, payload) => service.bindCapabilities(payload));
  ipcMain.handle('capability:test', (_, payload) => service.testCapabilityServer(payload));
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
  quitting = true;
  if (service && !service.closed) {
    event.preventDefault();
    if (!service.closing) {
      service.closing = true;
      service.close().catch(error => console.error('Runtime shutdown:', error.message)).then(() => service.usage.pending).finally(() => { service.closed = true; tray?.destroy(); tray = null; app.quit(); });
    }
  }
});
