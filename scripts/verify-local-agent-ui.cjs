const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startPersistentHost } = require('../lib/persistence-host.cjs');
const real = process.argv.includes('--real-pi');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.setPath('userData', path.resolve(__dirname, `../artifacts/local-agent-ui-${real ? 'real' : 'pipe'}-profile`));
let host, provider, windows = [], requests = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (win, code) => { const end = Date.now() + 30000; while (!await win.webContents.executeJavaScript(code)) { if (Date.now() > end) throw Error('UI timed out: ' + code); await delay(30); } };
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-ui-'));
  if (real) {
    provider = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-ONLY');
        let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body); requests++;
        assert.ok(JSON.stringify(data.messages).includes('保留两周'));
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
    return fork(path.resolve(__dirname, '../test/fixtures/local-execution-process.cjs'), [directory, ...(real ? ['--real-pi'] : [])], options);
  } });
  host = await startHost(0);
  const errors = [];
  for (const desktop of [true, false]) {
    const win = new BrowserWindow({ width: 1300, height: 960, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, ...(desktop ? { preload: path.resolve(__dirname, '../preload.cjs'), additionalArguments: ['--persistent-ui'] } : {}) } });
    windows.push(win); win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
    await win.loadURL(host.origin); await until(win, 'document.querySelector("#connection-text")?.textContent==="已连接"');
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".dev-controls"))'), false);
  }
  const [a, b] = windows;
  await until(a, 'Boolean(document.querySelector("[data-create-local-task]"))');
  await a.webContents.executeJavaScript('document.querySelector(".local-tasks > summary").click();document.querySelector("textarea[aria-label=本机任务目标]").focus()'); await a.webContents.insertText('检查接口兼容，请先询问期限');
  await a.webContents.executeJavaScript('document.querySelector("[data-create-local-task]").click()');
  await until(a, 'Boolean(document.querySelector("[data-local-phase=awaiting_input]"))');
  await until(b, 'Boolean(document.querySelector("[data-local-phase=awaiting_input]"))');
  const id = await a.webContents.executeJavaScript('document.querySelector("[data-local-task]").dataset.localTask');
  assert.equal(await b.webContents.executeJavaScript('document.querySelector("[data-local-task]").dataset.localTask'), id);
  await a.webContents.executeJavaScript('document.querySelector("textarea[aria-label=真实问题答复]").focus()'); await a.webContents.insertText('保留两周');
  await a.reload(); await until(a, 'Boolean(document.querySelector("textarea[aria-label=真实问题答复]"))');
  assert.equal(await a.webContents.executeJavaScript('document.querySelector("textarea[aria-label=真实问题答复]").value'), '保留两周');
  await a.webContents.executeJavaScript(`const input=document.querySelector('textarea[aria-label=真实问题答复]');input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'周'}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'周'}));`);
  assert.ok(await a.webContents.executeJavaScript('Boolean(document.querySelector("[data-local-phase=awaiting_input]")) && !document.querySelector("[data-check-local-operation]")'));
  a.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); a.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await until(a, 'document.activeElement?.matches("[data-answer-local-question]")');
  await a.webContents.executeJavaScript('document.querySelector(".local-tasks-body").scrollTop=10000'); await delay(100);
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, `../artifacts/local-agent-ui-${real ? 'real' : 'pipe'}.png`), (await a.webContents.capturePage()).toPNG());
  let dropped = false;
  a.webContents.session.webRequest.onHeadersReceived({ urls: [host.origin + '/api/v1/rooms/*/local-tasks/*/answers'] }, (details, callback) => { if (!dropped) { dropped = true; callback({ cancel: true }); } else callback({}); });
  await a.webContents.executeJavaScript('document.querySelector("[data-answer-local-question]").click()');
  await until(a, 'Boolean(document.querySelector("[data-check-local-operation]"))');
  await until(a, '!document.querySelector("[data-check-local-operation]").disabled');
  await a.webContents.executeJavaScript('document.querySelector("[data-check-local-operation]").click()');
  await until(a, '!document.querySelector("[data-check-local-operation]")');
  await until(b, 'Boolean(document.querySelector("[data-local-phase=reviewing]"))');
  assert.ok(await b.webContents.executeJavaScript(`document.querySelector('.local-task-result').textContent.includes(${JSON.stringify(real ? '真实界面问答已继续' : '保留两周')})`));
  await a.reload(); await until(a, 'Boolean(document.querySelector("[data-local-phase=reviewing]"))');
  a.destroy(); windows = [b]; assert.equal(await b.webContents.executeJavaScript('document.querySelector("#connection-text").textContent'), '已连接');
  await b.webContents.executeJavaScript('document.documentElement.dataset.theme="dark"'); b.setContentSize(420,860);
  await b.webContents.executeJavaScript('document.querySelector("[aria-label=切换侧栏]").click()'); await delay(120);
  assert.ok(await b.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'));
  await fs.writeFile(path.resolve(__dirname, `../artifacts/local-agent-ui-${real ? 'real' : 'pipe'}-narrow.png`), (await b.webContents.capturePage()).toPNG());
  if (!real) {
    await b.webContents.executeJavaScript('document.querySelector(".local-new-task").open=true;document.querySelector("textarea[aria-label=本机任务目标]").focus()'); await b.webContents.insertText('select a compatibility option');
    await b.webContents.executeJavaScript('document.querySelector("[data-create-local-task]").click()');
    await until(b, 'Boolean(document.querySelector("[data-local-phase=awaiting_input]"))');
    await b.webContents.executeJavaScript('document.querySelector(".local-native-question input[value=choice-0]").click();document.querySelector("[data-answer-local-question]").click()');
    await until(b, 'document.querySelectorAll("[data-local-phase=reviewing]").length===2');
    await b.webContents.executeJavaScript('document.querySelector(".local-new-task").open=true;document.querySelector("textarea[aria-label=本机任务目标]").focus()'); await b.webContents.insertText('restart while waiting');
    await b.webContents.executeJavaScript('document.querySelector("[data-create-local-task]").click()');
    await until(b, 'Boolean(document.querySelector("[data-local-phase=awaiting_input]"))');
    await b.webContents.executeJavaScript('document.querySelector("textarea[aria-label=真实问题答复]").focus()'); await b.webContents.insertText('重启后保留草稿');
    await delay(100); const origin = host.origin; await host.close(); host = await startHost(Number(new URL(origin).port));
    await b.reload(); await until(b, 'Boolean(document.querySelector("[data-local-phase=unknown]"))');
    assert.equal(await b.webContents.executeJavaScript('document.querySelector("textarea[aria-label=真实问题答复]").value'), '重启后保留草稿');
    assert.ok(await b.webContents.executeJavaScript('document.querySelector("textarea[aria-label=真实问题答复]").matches(":disabled")'));
    assert.equal(await b.webContents.executeJavaScript('document.querySelectorAll("[data-local-phase=awaiting_input]").length'), 0);
  }
  assert.deepEqual(errors, []); if (real) assert.equal(requests, 1);
  console.log(`Passed: ${real ? 'installed Pi CLI + 1 loopback inference, 0 paid calls' : 'controlled native pipe'}; real SQLite/HTTP/SSE, desktop/Web task identity, reload draft, lost answer receipt check, result persistence and narrow dark UI.`);
  windows.forEach(w => w.destroy()); windows = []; await host.close(); host = null; if (provider) await new Promise(r => provider.close(r)); app.quit();
}).catch(async e => { console.error(e); windows.forEach(w => w.destroy()); await host?.close(); provider?.close(); app.exit(1); });
