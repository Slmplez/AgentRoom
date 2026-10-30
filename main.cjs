const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage, Tray, nativeImage, utilityProcess } = require('electron');
const path = require('node:path');
const { HcomService } = require('./lib/hcom-service.cjs');
const { RpcRuntime } = require('./lib/rpc-runtime.cjs');
const persistent = process.argv.includes('--persistent');
let persistentOrigin;
if (persistent) {
  const index = process.argv.indexOf('--persistent-url');
  const url = new URL(index < 0 ? 'http://127.0.0.1:4319' : process.argv[index + 1]);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Persistent mode requires a plain loopback URL, for example http://127.0.0.1:4319.');
  persistentOrigin = url.origin;
  app.setPath('userData', path.join(app.getPath('appData'), 'AgentRoom-persistent-ui'));
}

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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: persistent ? ['--persistent-ui'] : [] },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (!quitting && (service?.gateways.size || service?.runtime?.activeSessions)) { event.preventDefault(); keepGatewayInTray(); window.hide(); }
  });
  if (persistent) window.loadURL(persistentOrigin).catch(error => console.error('Start the persistent Node service first:', error.message));
  else window.loadFile(path.join(__dirname, 'renderer', process.argv.includes('--chat-ui') ? 'chat.html' : 'index.html'));
}
if (single) app.whenReady().then(async () => {
  if (persistent) {
    ipcMain.on('platform:window', (_, action) => {
      if (action === 'minimize') window.minimize();
      if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      if (action === 'close') window.close();
    });
    ipcMain.handle('platform:open-source', () => shell.openExternal('https://github.com/Slmplez/AgentRoom'));
    createWindow();
    return;
  }
  const dataDir = app.isPackaged || process.argv.includes('--ui-preview') ? app.getPath('userData') : path.join(__dirname, '.data');
  // Preview isolates UI preferences and data, but keeps the same background session host.
  // Never switch the Add Agent button back to the external terminal launcher.
  const runtime = new RpcRuntime({ dataDir, fork: utilityProcess.fork.bind(utilityProcess), resourcesPath: app.isPackaged ? path.join(process.resourcesPath, 'native') : undefined });
  service = new HcomService({ dataDir, secretStorage: safeStorage, runtime });
  const { createChatApi } = await import('./lib/chat-api.mjs');
  const chatApi = createChatApi(service);
  ipcMain.handle('chat:request', (_, input) => chatApi.request(input));
  chatApi.subscribe(event => { if (window && !window.isDestroyed()) window.webContents.send('chat:event', event); });
  app.once('will-quit', () => chatApi.close());
  ipcMain.handle('platform:workbench', (_, section = '') => { if (!['', 'connections', 'capabilities', 'usage', 'launch', 'members', 'permissions'].includes(section)) throw new Error('未知管理入口'); return window.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { section } }); });
  ipcMain.handle('platform:certificate', async (_, kind) => {
    if (!['cert', 'key'].includes(kind)) throw new Error('不支持的证书类型');
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: kind === 'key' ? '选择客户端私钥（PEM）' : '选择证书（PEM）',
      filters: [{ name: 'PEM 证书与私钥', extensions: ['pem', 'crt', 'cer', 'key'] }, { name: '所有文件', extensions: ['*'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('platform:directory', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择 agent 工作目录' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('platform:window', (_, action) => {
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
  });
  ipcMain.handle('platform:open-source', () => shell.openExternal('https://github.com/aannoo/hcom'));
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
