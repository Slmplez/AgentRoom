const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startPersistentHost } = require('../lib/persistence-host.cjs');
const real = true;
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.setPath('userData', path.resolve(__dirname, `../artifacts/agent-memory-ui-profile`));
let host, provider, windows = [], requests = 0, receivedTexts = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (win, code) => { const end = Date.now() + 30000; while (!await win.webContents.executeJavaScript(code)) { if (Date.now() > end) throw Error('UI timed out: ' + code); await delay(30); } };
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-ui-'));
  if (real) {
    provider = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-ONLY');
        let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body); requests++;
        receivedTexts = data.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content || []).filter(p => p.type === 'text').map(p => p.text));
        assert.ok((data.tools || []).every(t => ['read', 'grep', 'find', 'ls'].includes(t.function.name)));
        const base = { id: 'local-ui', object: 'chat.completion.chunk', created: 1, model: 'local-ui-model', choices: [], usage: undefined };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '真实界面问答已继续' }, finish_reason: null }] }) + '\n\n');
        res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    const { validateProfile } = require('../lib/connection-profiles.cjs'); const { engineConnection } = require('../lib/engine-connections.cjs');
    const profile = validateProfile({ name: 'Local UI only', baseUrl: `http://127.0.0.1:${provider.address().port}`, protocol: 'chat', authMode: 'bearer', model: 'local-ui-model', contextWindow: 128000, maxTokens: 8192 });
    const config = await engineConnection('pi', profile, { baseUrl: profile.baseUrl, token: 'LOCAL-ONLY' }, directory);
    const extension = path.join(directory, 'ask-ui.mjs');
    await fs.writeFile(extension, `export default function(pi){pi.on('before_agent_start',async(_,ctx)=>{const answer=await ctx.ui.input('旧接口兼容期限？','请输入期限');return {message:{customType:'local-ui-answer',content:'真人答复：'+answer,display:false}};});}`);
    await fs.writeFile(path.join(directory, 'test-pi-config.json'), JSON.stringify({ args: [...config.args, '--extension', extension], env: config.env }));
  }
  const startHost = port => startPersistentHost({ directory, rendererRoot: path.resolve(__dirname, '../renderer'), port, agentWorkspace: directory, nodeExecutable: process.env.AGENTROOM_NODE || 'node', fork(_file, args, options) {
    return fork(path.resolve(__dirname, '../test/fixtures/local-execution-process.cjs'), [directory, '--memory-fixture', '--real-pi'], options);
  } });
  host = await startHost(0);
  const errors = [];
  for (const desktop of [true, false]) {
    const win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: desktop ? 'memory-desktop' : 'memory-web', ...(desktop ? { preload: path.resolve(__dirname, '../preload.cjs'), additionalArguments: ['--persistent-ui'] } : {}) } });
    windows.push(win); win.webContents.on('console-message', e => { if (e.level === 'error' && !e.message.includes('net::ERR_BLOCKED_BY_CLIENT')) errors.push(e.message); });
    await win.loadURL(host.origin); await until(win, 'document.querySelector("#connection-text")?.textContent==="已连接"');
  }
  const [a, b] = windows;
  const initialRoom = await a.webContents.executeJavaScript("fetch('/api/persistence/session').then(r=>r.json()).then(s=>s.roomId)");
  const reload = async win => { const loaded = new Promise(r => win.webContents.once('did-finish-load', r)); win.reload(); await loaded; };
  const js = (win, code) => win.webContents.executeJavaScript(code).catch(e => { throw Error(code + ": " + e.message); });
  const click = async (win, text, root = 'document') => { const code = `[...${root}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`; await until(win, `Boolean(${code}) && !${code}.disabled`); await js(win, `(()=>{const el=${code};el.focus();el.click();})()`); };
  const input = async (win, label, value) => { await until(win, `Boolean(document.querySelector('textarea[aria-label="${label}"]'))`); await js(win, `document.querySelector('textarea[aria-label="${label}"]').focus();document.querySelector('textarea[aria-label="${label}"]').select()`); await win.webContents.insertText(value); };
  const select = async (win, label, value) => { await js(win, `(()=>{const el=document.querySelector('select[aria-label="${label}"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); };
  const open = async win => { await js(win, 'document.querySelector("[aria-label=设置]").focus();document.querySelector("[aria-label=设置]").click()'); await click(win, '记忆'); await until(win, 'Boolean(document.querySelector(".memory-editor"))'); };
  const close = win => js(win, 'document.querySelector("[aria-label=关闭设置]").click()');
  const chooseAgent = async (win, id) => { await select(win, '记忆归属', id); await until(win, `Boolean(document.querySelector('textarea[aria-label="个性"]'))`); };
  const card = text => `[...document.querySelectorAll('[data-memory-id]')].find(el=>el.querySelector('p').textContent===${JSON.stringify(text)})`;
  const waitCard = (win, text) => until(win, `Boolean(${card(text)})`);
  const saveNote = async (win, text) => { await input(win, '新记忆', text); await click(win, '保存明确记忆'); await waitCard(win, text); };
  // Existing Agent management entry opens only backend registered identities.
  assert.equal(await js(a, `document.querySelector('.conversation-header').textContent.includes('Room 记忆')`), false);
  await open(a); await chooseAgent(a, 'local-pi');
  await until(a, 'Boolean(document.querySelector("textarea[aria-label=个性]"))');
  assert.deepEqual(await js(a, `[...document.querySelector('[aria-label=记忆归属]').options].map(o=>o.value)`), ['room', 'local-pi', 'ember']);
  await input(a, '个性', '审慎、先核对证据'); await input(a, '表达方式', '直接、简洁'); await input(a, '工作方式', '保留来源');
  await click(a, '保存 Soul'); await until(a, 'document.querySelector(".memory-scope h3").textContent.includes("v1")');
  // Seed the other Agent through the real authenticated API, then paginate via
  // the public Client/UI. The currently executing Agent/Room remain independent.
  await js(a, `(async()=>{const boot=await (await fetch('/api/v1/bootstrap')).json();for(let i=0;i<21;i++){const response=await fetch('/api/v1/agent-memory/commands',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'pagination-'+i},body:JSON.stringify({type:'saveExplicitMemory',workspaceId:boot.workspace.id,scope:{kind:'agent',agentId:'ember'},text:i===0?'😀'.repeat(2048):'分页记录 '+i,source:{kind:'owner-note'}})});if(!response.ok)throw Error('pagination fixture failed');}})()`);
  await chooseAgent(a, 'ember'); await click(a, '刷新当前状态');
  await until(a, 'document.querySelectorAll("[data-memory-id]").length===20');
  await input(a, '新记忆', '分页期间保留的草稿');
  await js(a, '[...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("加载更多记录")).click()');
  await until(a, 'document.querySelectorAll("[data-memory-id]").length===21');
  assert.equal(await js(a, 'new Set([...document.querySelectorAll("[data-memory-id]")].map(e=>e.dataset.memoryId)).size'), 21);
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), '分页期间保留的草稿');
  await chooseAgent(a, 'local-pi');
  await saveNote(a, '优先验证边界条件');
  await chooseAgent(a, 'ember'); assert.equal(await js(a, 'document.querySelector("textarea[aria-label=个性]").value'), '');
  await input(a, '个性', '活泼的独立草稿'); await chooseAgent(a, 'local-pi');
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=个性]").value'), '审慎、先核对证据');
  await chooseAgent(a, 'ember'); assert.equal(await js(a, 'document.querySelector("textarea[aria-label=个性]").value'), '活泼的独立草稿');
  await click(a, '保存 Soul'); await until(a, 'document.querySelector(".memory-scope h3").textContent.includes("v1")');
  await select(a, '记忆归属', 'room'); await until(a, '!document.querySelector("textarea[aria-label=个性]") && Boolean(document.querySelector("textarea[aria-label=新记忆]"))');
  await input(a, '新记忆', '😀'.repeat(2049)); assert.ok(await js(a, `[...document.querySelectorAll('button')].find(b=>b.textContent==='保存明确记忆').disabled`));
  await input(a, '新记忆', '😀'.repeat(2048)); assert.ok(await js(a, `![...document.querySelectorAll('button')].find(b=>b.textContent==='保存明确记忆').disabled`));
  await input(a, '新记忆', '房间草稿');
  await js(a, `const input=document.querySelector('textarea[aria-label=新记忆]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'稿'}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'稿'}));`);
  assert.equal(await js(a, 'document.querySelectorAll("[data-memory-id]").length'), 0);
  await click(a, '通用'); assert.equal(await js(a, 'Boolean(document.querySelector(".memory-settings"))'), false);
  await click(a, '记忆'); await until(a, 'Boolean(document.querySelector(".memory-editor"))');
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), '房间草稿');
  assert.equal(await js(a, 'document.querySelectorAll("dialog[open]").length'), 1);
  await close(a); await open(a); assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), '房间草稿');
  await click(a, '保存明确记忆'); await waitCard(a, '房间草稿');
  await close(a); await input(a, '消息内容', '会议仍待确定，原始消息不可被摘要替代。'); await js(a, 'document.querySelector("#send-button").click()');
  await until(a, 'document.querySelector("#message-input").value===""'); await open(a);
  const messageId = await js(a, 'document.querySelector("[aria-label=记忆来源]").options[1].value');
  await select(a, '记忆来源', messageId); await saveNote(a, '会议日期待定');
  await click(a, '查看来源与历史', card('会议日期待定'));
  await js(a, '[...document.querySelectorAll(".memory-history")].at(-1).open=true');
  await until(a, 'document.querySelector(".memory-history").textContent.includes("会议仍待确定，原始消息不可被摘要替代。")');
  // Two windows race on one revision. Refresh preserves the old draft until explicit rebase.
  await open(b); await click(a, '更正记忆', card('会议日期待定')); await input(a, '更正内容', 'A 的更正草稿');
  await click(b, '更正记忆', card('会议日期待定')); await input(b, '更正内容', 'B 已核对日期'); await click(b, '保存更正'); await waitCard(b, 'B 已核对日期');
  await click(a, '保存更正'); await until(a, 'document.querySelector(".memory-editor [role=alert]")?.textContent.includes("修改")');
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=更正内容]").value'), 'A 的更正草稿');
  await click(a, '刷新当前状态'); await waitCard(a, 'B 已核对日期'); await click(a, '以当前版本继续编辑这份草稿'); await click(a, '保存更正'); await waitCard(a, 'A 的更正草稿');
  await select(a, '记忆来源', '');
  // Lose the response after commit, then delete in another window before checking the old receipt.
  let dropped = false;
  a.webContents.session.webRequest.onHeadersReceived({ urls: [host.origin + '/api/v1/agent-memory/commands'] }, (details, callback) => { if (!dropped) { dropped = true; callback({ cancel: true }); } else callback({}); });
  await input(a, '新记忆', '响应丢失的记忆'); await click(a, '保存明确记忆'); await until(a, 'document.querySelector(".memory-editor [role=alert]")?.textContent.includes("连接中断")'); assert.equal(dropped, true);
  a.webContents.session.webRequest.onHeadersReceived(null);
  await click(b, '刷新当前状态'); await waitCard(b, '响应丢失的记忆'); await click(b, '停用记忆', card('响应丢失的记忆')); await click(b, '确认停用'); await until(b, `!${card('响应丢失的记忆')}`);
  await click(a, '核查原记忆请求'); await until(a, '!document.querySelector("textarea[aria-label=新记忆]").disabled');
  assert.equal(await js(a, `Boolean(${card('响应丢失的记忆')})`), false);
  await reload(a); await until(a, 'document.querySelector("#connection-text")?.textContent==="已连接"'); await open(a); assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), '');
  // Test-only bootstrap selection exercises two real Rooms without adding a production Room manager.
  await input(a, '新记忆', 'Room 一未提交草稿');
  const otherRoom = await js(a, `(async()=>{const boot=await (await fetch('/api/v1/bootstrap')).json();const res=await fetch('/api/v1/rooms',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'memory-ui-other-room'},body:JSON.stringify({workspaceId:boot.workspace.id,title:'第二测试房间'})});if(!res.ok)throw Error('fixture room failed');return (await res.json()).roomId;})()`);
  a.webContents.debugger.attach('1.3'); await a.webContents.debugger.sendCommand('Page.enable');
  const bootstrapOverride = await a.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch=window.fetch;window.fetch=async(...args)=>{const res=await originalFetch(...args);if(args[0]==='/api/persistence/session'){const data=await res.json();data.roomId=${JSON.stringify(otherRoom)};return new Response(JSON.stringify(data),{status:res.status,headers:res.headers});}return res;};` });
  await reload(a); await until(a, 'document.querySelector("#connection-text")?.textContent==="已连接"'); await open(a);
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), ''); assert.equal(await js(a, 'document.querySelectorAll("[data-memory-id]").length'), 0);
  await saveNote(a, '只属于第二房间'); await input(a, '新记忆', 'Room 二未提交草稿');
  await a.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootstrapOverride.identifier }); a.webContents.debugger.detach();
  await reload(a); await until(a, 'document.querySelector("#connection-text")?.textContent==="已连接"'); await open(a);
  assert.equal(await js(a, 'document.querySelector("textarea[aria-label=新记忆]").value'), 'Room 一未提交草稿'); assert.equal(await js(a, `Boolean(${card('只属于第二房间')})`), false); await input(a, '新记忆', '');
  // Persisted history selection survives reload even though disabled records leave the active list.
  await reload(b); await until(b, 'document.querySelector("#connection-text")?.textContent==="已连接"'); await open(b);
  await js(b, 'document.querySelector(".memory-history").open=true'); await until(b, 'document.querySelector(".memory-history").textContent.includes("已停用")');
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../artifacts/agent-memory-ui-light.png'), (await b.webContents.capturePage()).toPNG());
  await js(b, 'document.documentElement.dataset.theme="dark"'); b.setContentSize(420, 860); await delay(150);
  assert.ok(await js(b, 'document.documentElement.scrollWidth<=innerWidth && document.querySelector(".settings-dialog").scrollWidth<=document.querySelector(".settings-dialog").clientWidth'));
  await fs.writeFile(path.resolve(__dirname, '../artifacts/agent-memory-ui-dark-narrow.png'), (await b.webContents.capturePage()).toPNG());
  // A real installed Pi task receives the immutable snapshot, even if memory changes while native input waits.
  await close(a); await input(a, '本机任务目标', '检查这次任务加载的明确配置'); await js(a, 'document.querySelector("[data-create-local-task]").click()');
  await until(a, 'Boolean(document.querySelector("[data-local-phase=awaiting_input]"))');
  await js(a, 'document.querySelector(".memory-context").open=true'); await until(a, 'Boolean(document.querySelector("[data-task-context-prompt]"))');
  const expectedPrompt = await js(a, 'document.querySelector("[data-task-context-prompt]").textContent');
  assert.ok(expectedPrompt.includes('审慎、先核对证据') && expectedPrompt.includes('优先验证边界条件') && expectedPrompt.includes('A 的更正草稿'));
  assert.ok(!expectedPrompt.includes('活泼的独立草稿') && !expectedPrompt.includes('响应丢失的记忆'));
  await open(a); await chooseAgent(a, 'local-pi'); await input(a, '个性', '任务启动后的新版个性'); await click(a, '保存 Soul'); await until(a, 'document.querySelector(".memory-scope h3").textContent.includes("v2")');
  await click(a, '停用记忆', card('优先验证边界条件')); await click(a, '确认停用'); await until(a, `!${card('优先验证边界条件')}`); await close(a);
  await input(a, '真实问题答复', '保留两周'); await js(a, 'document.querySelector("[data-answer-local-question]").click()'); await until(a, 'Boolean(document.querySelector("[data-local-phase=reviewing]"))');
  assert.ok(receivedTexts.includes(expectedPrompt), 'Exact snapshot prompt reached installed Pi loopback model'); assert.equal(requests, 1);
  await click(a, '重新读取任务快照'); await until(a, 'Boolean(document.querySelector("[data-task-context-prompt]"))'); assert.equal(await js(a, 'document.querySelector("[data-task-context-prompt]").textContent'), expectedPrompt);
  const origin = host.origin; await host.close(); host = await startHost(Number(new URL(origin).port));
  a.webContents.debugger.attach('1.3'); await a.webContents.debugger.sendCommand('Page.enable');
  await a.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch=window.fetch;window.fetch=async(...args)=>{const res=await originalFetch(...args);if(args[0]==='/api/persistence/session'){const data=await res.json();data.roomId=${JSON.stringify(initialRoom)};return new Response(JSON.stringify(data),{status:res.status,headers:res.headers});}return res;};` });
  await reload(a); await until(a, 'document.querySelector("#connection-text")?.textContent==="已连接"');
  await js(a, 'document.querySelector(".memory-context").open=true'); await until(a, 'Boolean(document.querySelector("[data-task-context-prompt]"))'); assert.equal(await js(a, 'document.querySelector("[data-task-context-prompt]").textContent'), expectedPrompt);
  await open(a); await chooseAgent(a, 'local-pi'); assert.equal(await js(a, 'document.querySelector("textarea[aria-label=个性]").value'), '任务启动后的新版个性');
  assert.equal(await js(a, 'document.querySelectorAll("[data-memory-id]").length'), 0);
  await js(a, 'document.querySelector("[aria-label=关闭设置]").focus()'); a.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); a.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await until(a, '!document.querySelector(".settings-dialog")');
  assert.equal(await js(a, 'document.activeElement.getAttribute("aria-label")'), '设置');
  assert.deepEqual(errors, []);
  console.log('Passed: real SQLite + authenticated cookie host + public Client; independent Souls/drafts, explicit sources, corrections/conflict, lost response and tombstone, reload/restart, Unicode/IME/focus, light/dark narrow; installed Pi CLI exact frozen prompt, 1 loopback inference, 0 paid calls.');
  windows.forEach(w => w.destroy()); windows = []; await host.close(); host = null; await new Promise(r => provider.close(r)); provider = null; app.quit();
}).catch(async e => { console.error(e); if (windows[0] && !windows[0].isDestroyed()) { console.error(await windows[0].webContents.executeJavaScript('document.body.innerText').catch(() => '')); } windows.forEach(w => w.destroy()); await host?.close(); provider?.close(); app.exit(1); });
