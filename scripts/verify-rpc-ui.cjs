// Isolated hidden Electron fixture: exercises the real renderer and IPC bridge.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', path.resolve(__dirname, '../artifacts/rpc-ui-profile'));
app.disableHardwareAcceleration();
let window;
app.whenReady().then(async () => {
  const answers = [], errors = [];
  const rpc = { alive: true, status: 'blocked', queueLength: 1, current: { id: 1, thread: 'test-room' }, partial: '流式回复显示在聊天中。', error: '', approvals: [{ id: 'approval-1', kind: 'permission', data: { tool_name: 'Bash', command: 'echo <user-confirmation>' } }] };
  ipcMain.handle('fixture:state', () => ({ connection: 'connected', runtimeMode: 'native', agents: [{ id: 'alpha', name: 'alpha', baseName: 'alpha', tool: 'pi', label: 'Pi', displayName: 'Pi · Alpha', mode: 'rpc', status: 'blocked', directory: 'C:\\Projects\\agent-room', workspaceId: 'workspace', rpc }], rooms: [{ id: 'test-room', title: 'RPC 协作验证', thread: 'test-room', workspaceId: 'workspace', allMembers: true, type: 'group' }], workspaces: [{ id: 'workspace', title: 'Agent Room', directory: 'C:\\Projects\\agent-room' }], messages: [{ id: '1', sender: 'user', senderName: '你', human: true, tool: 'human', text: '@alpha 检查工作区', timestamp: new Date().toISOString(), thread: 'test-room', recipients: ['alpha'], deliveredTo: ['alpha'] }], engines: [], connections: [] }));
  ipcMain.handle('fixture:inspect', () => rpc);
  ipcMain.handle('fixture:respond', (_, id, requestId, answer) => { answers.push({ id, requestId, answer }); rpc.approvals = []; return { accepted: true }; });
  ipcMain.handle('fixture:cancel', () => ({ accepted: true })); ipcMain.handle('fixture:stop', () => ({ accepted: true }));
  window = new BrowserWindow({ width: 1400, height: 940, show: false, webPreferences: { offscreen: true, preload: path.resolve(__dirname, '../test/fixtures/rpc-ui-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  const run = source => window.webContents.executeJavaScript(source);
  const until = async script => { const deadline = Date.now() + 8000; while (!await run(script)) { if (Date.now() > deadline) throw new Error('Renderer timed out: ' + script); await new Promise(r => setTimeout(r, 50)); } };
  await until('Boolean(document.querySelector(".rpc-progress"))');
  assert.match(await run('document.querySelector(".rpc-progress").textContent'), /流式回复/);
  await fs.writeFile(path.resolve(__dirname, '../artifacts/rpc-ui-chat.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-terminal=alpha]").click()');
  await until('Boolean(document.querySelector("[data-rpc-decision=deny]"))');
  assert.equal(await run('Boolean(document.querySelector(".xterm, #native-terminal"))'), false);
  assert.equal(answers.length, 0, 'permissions cannot auto-approve');
  assert.match(await run('document.querySelector(".rpc-request-detail").textContent'), /<user-confirmation>/);
  assert.equal(await run('document.querySelector(".rpc-request-detail").children.length'), 0, 'untrusted content is escaped');
  await new Promise(r => setTimeout(r, 200)); // Allow the modal's 150 ms transition to paint.
  await fs.writeFile(path.resolve(__dirname, '../artifacts/rpc-ui-approval.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-rpc-decision=deny]").click()');
  await until('document.querySelectorAll("[data-rpc-decision]").length === 0');
  assert.equal(answers.length, 1); assert.equal(answers[0].answer.allow, false); assert.equal(answers[0].requestId, 'approval-1'); assert.deepEqual(errors, []);
  const evidence = { passed: true, checks: ['real Electron renderer', 'streamed reply visible', 'RPC session panel without xterm', 'permission waits for human action', 'escaped operation details', 'deny returns correct request ID'], time: new Date().toISOString() };
  await fs.writeFile(path.resolve(__dirname, '../artifacts/rpc-ui-check.json'), JSON.stringify(evidence, null, 2)); console.log(evidence); window.destroy(); app.quit();
}).catch(e => { console.error(e); window?.destroy(); app.exit(1); });
