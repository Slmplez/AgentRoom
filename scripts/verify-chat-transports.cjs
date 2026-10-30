const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HcomService, workspaceId } = require('../lib/hcom-service.cjs');
const { createPreviewServer } = require('./dev-ui.cjs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.setPath('userData', path.resolve(__dirname, '../artifacts/chat-transports-profile'));
let win, service, server;
app.whenReady().then(async () => {
  // Real application service and real transports; deterministic external runtime, no model call.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-chat-transport-'));
  const rpc = { alive: true, current: null, partial: '', tools: [], approvals: [] }, events = [], sent = [], decisions = [];
  const runtime = new EventEmitter(); runtime.close = async () => {};
  runtime.snapshot = async () => ({ agents: ['alpha', 'beta'].map(name => ({ name, base_name: name, tool: 'pi', directory, status: 'listening', mode: 'rpc', rpc: name === 'alpha' ? rpc : { alive: true, approvals: [] } })), events });
  runtime.send = async payload => {
    sent.push(payload); const id = events.length + 1;
    events.push({ id, type: 'message', ts: new Date().toISOString(), data: { sender_kind: 'external', from: 'user', thread: payload.thread, text: payload.text } });
    rpc.current = { id, thread: payload.thread }; rpc.partial = '正在检查';
    return { event_id: id };
  };
  runtime.respond = async (id, requestId, answer) => { decisions.push({ id, requestId, answer }); rpc.approvals = rpc.approvals.filter(r => r.id !== requestId); await service.refresh(); return { accepted: true, delivery: 'confirmed' }; };
  service = new HcomService({ dataDir: directory, runtime });
  await service.connections.load(); await service.usage.load(); await service.refresh();
  const roomId = `lobby:${workspaceId(directory)}`;
  const { createChatApi } = await import('../lib/chat-api.mjs');
  const { createChatHttpHandler } = await import('../lib/chat-http.mjs');
  const chatApi = createChatApi(service);
  const chatHandler = createChatHttpHandler(chatApi);
  ipcMain.handle('chat:request', (_, input) => chatApi.request(input));
  chatApi.subscribe(event => { if (win && !win.isDestroyed()) win.webContents.send('chat:event', event); });
  const staticServer = createPreviewServer({ mode: 'live' });
  server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/chat/')) return await chatHandler(req, res);
      if (req.url === '/workbench.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await fs.readFile(path.resolve(__dirname, '../renderer/index.html'))); return; }
      if (req.url.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      staticServer.emit('request', req, res);
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const [mode, view] of [['http', 'react'], ['ipc', 'react'], ['http', 'workbench'], ['ipc', 'workbench']]) {
    const errors = [];
    win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, ...(mode === 'ipc' ? { preload: path.resolve(__dirname, '../preload.cjs') } : {}) } });
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    if (mode === 'http') await win.loadURL(`http://127.0.0.1:${server.address().port}/${view === 'workbench' ? 'workbench.html' : ''}`); else await win.loadFile(path.resolve(__dirname, view === 'workbench' ? '../renderer/index.html' : '../renderer/chat.html'));
    const run = code => win.webContents.executeJavaScript(code);
    const until = async code => { const end = Date.now() + 6000; while (!await run(code)) { if (Date.now() > end) throw new Error(`${mode}: ${code}\n${errors}`); await new Promise(resolve => setTimeout(resolve, 25)); } };
    await until('document.querySelector("#connection-text")?.textContent.includes("已连接")');
    await until(`Boolean(document.querySelector('[data-room="${roomId}"]'))`);
    assert.equal(await run('Boolean(document.querySelector(".dev-controls"))'), false);
    assert.equal(await run('Boolean(document.querySelector("[aria-label=消息类型]"))'), false, 'Old runtime must not advertise task ownership');
    await run(`document.querySelector('[data-room="${roomId}"]').click(); document.querySelector('#message-input').focus()`);
    await win.webContents.insertText('@al');
    await until('Boolean(document.querySelector(".mention-option"))');
    await run('document.querySelector(".mention-option").click()');
    await win.webContents.insertText('检查');
    await run('document.querySelector("#send-button").click()');
    await until('document.querySelector("#message-input").value === ""');
    assert.deepEqual(sent.at(-1).targets, ['alpha']);
    const current = { ...rpc.current }, replyId = `reply:alpha:${current.id}`;
    await until(`Array.from(document.querySelectorAll('.message')).some(el => el.dataset.messageId === '${replyId}')`);
    rpc.approvals = [{ id: `approval-${view}-${mode}`, kind: 'permission', grantScope: 'turn', data: { command: ['npm', 'run', 'check'], method: 'item/permissions/requestApproval' } }];
    await service.refresh();
    await until('Boolean(document.querySelector(".permission-dialog[open]"))');
    assert.ok(await run('document.querySelector(".permission-dialog").textContent.includes("当前任务轮次")'));
    await run('Array.from(document.querySelectorAll(".permission-dialog button")).find(b=>b.textContent === "允许本轮").click()');
    await until('!document.querySelector(".permission-dialog[open]")');
    assert.equal(decisions.at(-1).requestId, `approval-${view}-${mode}`);
    events.push({ id: events.length + 1, type: 'message', ts: new Date().toISOString(), data: { sender_kind: 'agent', from: 'alpha', text: `检查完成 ${mode}`, thread: current.thread, reply_to: String(current.id) } });
    rpc.current = null; rpc.partial = ''; await service.refresh();
    await until(`document.querySelector('#messages').textContent.includes('检查完成 ${mode}')`);
    assert.equal(await run(`Array.from(document.querySelectorAll('.message')).filter(el=>el.dataset.messageId === '${replyId}').length`), 1);
    if (view === 'workbench') {
      await run('document.querySelector(\'[data-room="dm:alpha"]\').click()');
      await win.reload();
      await until('Boolean(document.querySelector(\'[data-room="dm:alpha"]\'))');
      assert.equal(await run('document.querySelector(".conversation-item.selected")?.dataset.room'), 'dm:alpha', 'Reload preserves the selected private room');
    }
    assert.deepEqual(errors, []);
    win.destroy();
  }
  chatApi.close(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // mkdtemp returned this exact owned directory; it contains only this test's fixture data.
  const target = path.resolve(directory), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(parent) || !path.basename(target).startsWith('ar-chat-transport-')) throw new Error('Unsafe fixture cleanup target');
  await fs.rm(target, { recursive: true, force: true });
  console.log('Passed: workbench and React client over HTTP/SSE and Electron IPC, real HcomService validation, explicit recipients, approval normalization and stable completion. External runtime is a fixture.');
  app.quit();
}).catch(error => { console.error(error); win?.destroy(); server?.close(); void service?.close(); app.exit(1); });
