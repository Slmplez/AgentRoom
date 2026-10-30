const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.setPath('userData', path.resolve(__dirname, '../artifacts/persistence-ui-profile'));
let host, directory, windows = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(port = 0) {
  const child = fork(path.resolve(__dirname, '../server.cjs'), ['--persistent', '--data-dir', directory, '--port', String(port)], { execPath: process.env.AGENTROOM_NODE || 'node', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let errors = ''; child.stderr.on('data', value => { errors += value; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Host startup timed out: ' + errors)); }, 15000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Host exited: ' + errors)); });
  });
  assert.equal(ready.type, 'ready'); assert.equal(ready.token, undefined);
  return { child, origin: ready.origin };
}
async function stop() {
  if (!host) return;
  const child = host.child; host = undefined;
  if (child.exitCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'shutdown' }); await done;
}
async function until(win, code) {
  const end = Date.now() + 15000;
  while (!await win.webContents.executeJavaScript(code)) { if (Date.now() > end) throw new Error('UI timed out: ' + code); await delay(30); }
}
async function send(win, text) {
  await win.webContents.executeJavaScript('document.querySelector("#message-input").focus()');
  await win.webContents.insertText(text);
  await win.webContents.executeJavaScript('document.querySelector("#send-button").click()');
  await until(win, 'document.querySelector("#message-input").value === ""');
}
app.whenReady().then(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-persistence-ui-'));
  host = await start(); const origin = host.origin;
  for (const desktop of [true, false]) {
    const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(desktop ? { preload: path.resolve(__dirname, '../preload.cjs'), additionalArguments: ['--persistent-ui'] } : {}) } });
    windows.push(win); await win.loadURL(origin);
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); });
    await until(win, 'document.querySelector("#connection-text")?.textContent === "已连接"');
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".dev-controls, [aria-label=消息类型], .sidebar-create")'), false);
    assert.equal(await win.webContents.executeJavaScript('document.cookie'), '');
  }
  const [desktop, browser] = windows;
  console.log('Connected desktop and browser');
  await send(desktop, '桌面持久消息 @不启动Agent');
  await until(browser, 'document.querySelector("#messages").textContent.includes("桌面持久消息")');
  const messageId = await desktop.webContents.executeJavaScript('document.querySelector(".message").dataset.messageId');
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".message").dataset.messageId'), messageId);
  console.log('Initial delivery synchronized');
  let dropResponse = true;
  desktop.webContents.session.webRequest.onHeadersReceived({ urls: [origin + '/api/v1/rooms/*/messages'] }, (details, callback) => {
    if (dropResponse) { dropResponse = false; callback({ cancel: true }); } else callback({});
  });
  await desktop.webContents.executeJavaScript('document.querySelector("#message-input").focus()');
  await desktop.webContents.insertText('响应丢失仍只记录一次');
  await desktop.webContents.executeJavaScript('document.querySelector("#send-button").click()');
  await until(desktop, 'document.querySelector("#message-input").value === ""');
  assert.equal(dropResponse, false, 'The actual committed response must be interrupted');
  desktop.webContents.session.webRequest.onHeadersReceived(null);
  await until(browser, 'document.querySelector("#messages").textContent.includes("响应丢失仍只记录一次")');
  await until(desktop, '!document.querySelector("[data-check-operation]")');
  assert.equal(await desktop.webContents.executeJavaScript('document.querySelectorAll(".message").length'), 2);
  console.log('Lost response recovered by original receipt');
  let releaseRequest;
  desktop.webContents.session.webRequest.onBeforeRequest({ urls: [origin + '/api/v1/rooms/*/messages'] }, (_details, callback) => { releaseRequest = callback; });
  await desktop.webContents.executeJavaScript('document.querySelector("#message-input").focus()');
  await desktop.webContents.insertText('原始待重试内容');
  await desktop.webContents.executeJavaScript('document.querySelector("#send-button").click()');
  const requestDeadline = Date.now() + 5000;
  while (!releaseRequest) { if (Date.now() > requestDeadline) throw new Error('Request was not intercepted'); await delay(10); }
  await desktop.webContents.executeJavaScript('document.querySelector("#message-input").focus()');
  await desktop.webContents.insertText('，这里是用户新写的草稿');
  releaseRequest({ cancel: true }); desktop.webContents.session.webRequest.onBeforeRequest(null);
  await until(desktop, 'document.querySelector("[data-check-operation]")?.disabled === false');
  await desktop.webContents.executeJavaScript('document.querySelector("[data-check-operation]").click()');
  await until(desktop, 'document.querySelector("[data-retry-operation]")?.disabled === false');
  await desktop.webContents.executeJavaScript('document.querySelector("[data-retry-operation]").click()');
  await until(browser, 'document.querySelector("#messages").textContent.includes("原始待重试内容")');
  assert.equal(await desktop.webContents.executeJavaScript('document.querySelector("#message-input").value'), '原始待重试内容，这里是用户新写的草稿');
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#messages").textContent.includes("这里是用户新写的草稿")'), false);
  console.log('Retry used journaled command and preserved edited draft');
  await browser.webContents.executeJavaScript('document.querySelector("#message-input").focus()');
  await browser.webContents.insertText('跨重启保留草稿');
  const sessionResponse = await fetch(origin + '/api/persistence/session');
  const session = await sessionResponse.json(); const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(origin + '/api/v1/bootstrap', { headers: { Cookie: cookie } })).json();
  for (let i = 0; i < 105; i++) {
    const response = await fetch(origin + '/api/v1/rooms/' + session.roomId + '/messages', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ workspaceId: boot.workspace.id, text: '历史页 ' + i }) });
    assert.equal(response.status, 200);
  }
  const reloaded = once(browser.webContents, 'did-finish-load'); browser.reload(); await reloaded;
  await until(browser, 'document.querySelector("#connection-text")?.textContent === "已连接"');
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#message-input").value'), '跨重启保留草稿');
  console.log('Reloaded with draft');
  await browser.webContents.executeJavaScript('document.querySelector("[data-load-history]").click()');
  await until(browser, 'document.querySelector("#messages").textContent.includes("桌面持久消息")');
  assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll(".message").length'), 108);
  desktop.destroy(); windows = [browser];
  assert.equal((await fetch(origin + '/api/v1/bootstrap', { headers: { Cookie: cookie } })).status, 200, 'Closing the desktop window must not stop the shared backend');
  const port = Number(new URL(origin).port); await stop();
  await until(browser, 'document.querySelector("#connection-text")?.textContent !== "已连接"');
  host = await start(port);
  await until(browser, 'document.querySelector("#connection-text")?.textContent === "已连接"');
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#message-input").value'), '跨重启保留草稿');
  await browser.webContents.executeJavaScript('document.querySelector("#send-button").click()');
  await until(browser, 'document.querySelector("#message-input").value === ""');
  await until(browser, 'document.querySelector("#messages").textContent.includes("跨重启保留草稿")');
  await browser.webContents.executeJavaScript('document.querySelector("[aria-label=设置]").click()');
  await until(browser, 'document.querySelector("dialog[open]")?.textContent.includes("持久讨论")');
  await delay(350); // Let the compositor paint the modal before capturing the hidden test window.
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../artifacts/persistence-ui.png'), (await browser.webContents.capturePage()).toPNG());
  for (const win of windows) win.destroy(); windows = []; await stop();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('ar-persistence-ui-'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  console.log('Passed: real Node/SQLite backend, desktop preload + browser, same message identity, history paging, retained drafts, restart recovery, one window closing leaves service alive; no CLI/model fixture.');
  app.quit();
}).catch(async error => { console.error(error); for (const win of windows) win.destroy(); await stop(); app.exit(1); });
