// Real installed Pi + two real UI clients. Inference is an isolated loopback fixture.
const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { startPersistentHost } = require('../lib/persistence-host.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.setPath('userData', path.resolve(__dirname, '../artifacts/report-ui-profile'));
let host, provider, child, windows = [], calls = 0, releaseVersion;
const versionGate = new Promise(r => { releaseVersion = r; });
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (win, expression) => { const end = Date.now() + 30000; while (!await win.webContents.executeJavaScript(expression).catch(e => { throw Error(`${expression}: ${e.message}`); })) { if (Date.now() > end) throw Error('UI timed out: ' + expression); await delay(30); } };
const run = (win, code) => win.webContents.executeJavaScript(code).catch(error => { throw Error(`${code}: ${error.message}`); });
const openFirst = win => run(win, 'Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="1").focus();Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="1").click()');
const report = version => ({ root: 'root', elements: {
  root: { type: 'Section', props: { title: `发布结果 ${version}`, description: `真实任务正文 V${version} · <script>window.reportInjected=true</script>` }, children: ['metrics', 'bars', 'table'] },
  metrics: { type: 'Metrics', props: { items: [{ label: '检查项', value: String(version), detail: '真实 Pi 发布' }] }, children: [] },
  bars: { type: 'Bars', props: { title: '覆盖情况', items: [{ label: '检查进度', value: version * 40 }] }, children: [] },
  table: { type: 'Table', props: { columns: ['检查点', '结果', '长中文说明'], rows: [['消息引用', '已验证', '这是用于检查窄屏阅读和表格溢出的详细中文说明。'.repeat(5)]] }, children: [] },
} });
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-report-ui-'));
  provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-ONLY');
      let text = ''; for await (const chunk of req) text += chunk; const data = JSON.parse(text); calls++;
      assert.ok(data.tools.some(t => t.function.name === 'publish_report'));
      assert.ok(data.tools.every(t => ['read', 'grep', 'find', 'ls', 'publish_report'].includes(t.function.name)));
      let receipt;
      if (calls > 1) { const tool = data.messages.filter(m => m.role === 'tool').at(-1); receipt = JSON.parse(typeof tool.content === 'string' ? tool.content : tool.content[0].text); assert.equal(receipt.accepted, true); }
      if (calls === 2) await versionGate;
      const publishing = calls <= 2;
      const input = { key: `ui-report-${calls}`, expectedVersion: calls - 1, ...(calls === 2 ? { artifactId: receipt.artifactId } : {}), title: `真实报告 ${calls}`, catalogVersion: 1, spec: report(calls) };
      const delta = publishing ? { role: 'assistant', tool_calls: [{ index: 0, id: `publish-${calls}`, type: 'function', function: { name: 'publish_report', arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: '报告已发布，等待验收。' };
      const base = { id: 'report-ui', object: 'chat.completion.chunk', created: 1, model: 'report-ui-model' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: publishing ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
    } catch (e) { console.error(e); res.writeHead(500); res.end(e.message); }
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const config = await engineConnection('pi', { name: 'Report UI', protocol: 'chat', model: 'report-ui-model', contextWindow: 128000, maxTokens: 8192, reasoning: false }, { baseUrl: `http://127.0.0.1:${provider.address().port}`, token: 'LOCAL-ONLY' }, directory);
  await fs.writeFile(path.join(directory, 'test-pi-config.json'), JSON.stringify(config));
  const start = port => startPersistentHost({ directory, agentWorkspace: directory, agentReports: true, rendererRoot: path.resolve(__dirname, '../renderer'), port, nodeExecutable: process.env.AGENTROOM_NODE || 'node', fork(_file, args, options) { child = fork(path.resolve(__dirname, '../test/fixtures/artifact-ui-process.cjs'), [directory, ...args], options); return child; } });
  host = await start(0);
  const errors = [];
  for (const desktop of [true, false]) {
    const win = new BrowserWindow({ width: 1320, height: 960, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, ...(desktop ? { preload: path.resolve(__dirname, '../preload.cjs'), additionalArguments: ['--persistent-ui'] } : {}) } });
    windows.push(win); win.webContents.on('console-message', e => { if (e.level === 'error' && !/Failed to load resource/.test(e.message)) errors.push(e.message); });
    await win.loadURL(host.origin); await until(win, 'document.querySelector("#connection-text")?.textContent==="已连接"');
  }
  const [a, b] = windows;
  await until(a, 'Boolean(document.querySelector("[data-create-local-task]"))');
  await run(a, 'document.querySelector("#message-input").focus()'); await a.webContents.insertText('保留聊天草稿');
  await run(a, 'document.querySelector("textarea[aria-label=本机任务目标]").focus()'); await a.webContents.insertText('请发布报告并更新一个版本');
  await run(a, 'document.querySelector("[data-create-local-task]").click()');
  for (const win of windows) await until(win, 'Boolean(Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="1"))');
  await openFirst(a); await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  await delay(400);
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../artifacts/report-ui-light.png'), (await a.webContents.capturePage()).toPNG());
  assert.equal(await run(a, 'Boolean(window.reportInjected)'), false);
  releaseVersion();
  for (const win of windows) await until(win, 'Boolean(Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="2"))');
  await until(a, 'Boolean(document.querySelector(".artifact-new-version"))');
  assert.ok(await run(a, 'document.querySelector(".artifact-panel .result-section").textContent.includes("正文 V1")'));
  await run(a, 'document.querySelector(".artifact-new-version").click()');
  await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V2")');
  assert.equal(await run(a, 'document.querySelector("#message-input").value'), '保留聊天草稿');
  await run(a, 'document.querySelector("[aria-label=报告版本]").value="1";document.querySelector("[aria-label=报告版本]").dispatchEvent(new Event("change",{bubbles:true}))');
  await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  await run(a, 'document.querySelector("[aria-label=返回报告原消息]").click()');
  // Delay an actual old-version HTTP request while the user selects the newer one.
  let delayed;
  a.webContents.session.webRequest.onBeforeRequest({ urls: [host.origin + '/api/v1/rooms/*/artifacts/*/versions/1'] }, (_details, callback) => { if (!delayed) delayed = callback; else callback({}); });
  await openFirst(a);
  const delayDeadline = Date.now() + 5000; while (!delayed) { if (Date.now() > delayDeadline) throw Error('No delayed report request'); await delay(10); }
  await until(a, 'document.querySelectorAll("[aria-label=报告版本] option").length===2');
  await run(a, 'document.querySelector("[aria-label=报告版本]").value="2";document.querySelector("[aria-label=报告版本]").dispatchEvent(new Event("change",{bubbles:true}))');
  await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V2")'); delayed({});
  await delay(100); assert.ok(await run(a, 'document.querySelector(".artifact-panel .result-section").textContent.includes("正文 V2")'));
  a.webContents.session.webRequest.onBeforeRequest(null);
  await run(a, 'document.querySelector("[aria-label=返回报告原消息]").click()');
  let cancelled = false;
  a.webContents.session.webRequest.onBeforeRequest({ urls: [host.origin + '/api/v1/rooms/*/artifacts/*/versions/1'] }, (_details, callback) => { callback({ cancel: !cancelled }); cancelled = true; });
  await openFirst(a); await until(a, 'document.querySelector(".artifact-panel [role=alert]")?.textContent.includes("检查连接")');
  a.webContents.session.webRequest.onBeforeRequest(null);
  await run(a, 'document.querySelector(".artifact-panel [role=alert] button").click()');
  await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  await run(a, 'document.querySelector(".artifact-panel h2").focus()'); a.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(a, '!document.querySelector(".artifact-panel")');
  assert.equal(await run(a, 'document.activeElement?.dataset.artifactVersion'), '1');
  await a.reload(); await until(a, 'Boolean(Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="1"))'); await openFirst(a);
  await until(a, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  await openFirst(b); await until(b, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  await run(b, 'document.documentElement.dataset.theme="dark"'); b.setContentSize(420, 860); await delay(800);
  await fs.writeFile(path.resolve(__dirname, '../artifacts/report-ui-dark-narrow.png'), (await b.webContents.capturePage()).toPNG());
  assert.ok(await run(b, 'document.documentElement.scrollWidth<=innerWidth'), await run(b, 'JSON.stringify([...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+2).slice(-12).map(e=>[e.className,e.getBoundingClientRect().width,e.scrollWidth]))'));
  await run(b, 'document.querySelector("[aria-label=返回报告原消息]").click()');
  await b.webContents.debugger.attach('1.3');
  await b.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await openFirst(b); await until(b, 'Boolean(document.querySelector(".artifact-panel .result-section"))');
  assert.equal(await run(b, 'document.querySelector(".artifact-panel").getAnimations().length'), 0);
  await run(b, 'document.querySelector("[aria-label=返回报告原消息]").click()'); b.webContents.debugger.detach();
  for (const [mode, expected] of [['corrupt', '缺失或损坏'], ['catalog', '尚不受支持'], ['missing', '不存在'], ['forbidden', '无权读取']]) {
    const ready = new Promise(r => child.once('message', r)); child.send({ type: 'test-report-state', mode }); await ready;
    await openFirst(b); await until(b, `document.querySelector('.artifact-panel [role=alert]')?.textContent.includes(${JSON.stringify(expected)})`);
    assert.equal(await run(b, 'Boolean(document.querySelector(".artifact-panel .result-section"))'), false);
    await run(b, 'document.querySelector("[aria-label=返回报告原消息]").click()');
  }
  const restored = new Promise(r => child.once('message', r)); child.send({ type: 'test-report-state', mode: 'restore' }); await restored;
  const origin = host.origin; await host.close(); host = await start(Number(new URL(origin).port));
  await b.reload(); await until(b, 'Boolean(Array.from(document.querySelectorAll("[data-artifact-version]")).find(el=>el.dataset.artifactVersion==="1"))'); await openFirst(b);
  await until(b, 'document.querySelector(".artifact-panel .result-section")?.textContent.includes("正文 V1")');
  assert.equal(calls, 3); assert.deepEqual(errors, []);
  console.log('Passed: real Pi report publication; desktop/Web exact versions, new-version hint, switching with delayed old response, network retry, draft retention, Escape/focus, reload/restart, corrupt/unsupported/missing/forbidden states, literal script text, light/wide + dark/narrow screenshots. 3 loopback inference requests, 0 paid calls.');
  windows.forEach(w => w.destroy()); windows = []; await host.close(); host = null; provider.closeAllConnections(); await new Promise(r => provider.close(r)); app.quit();
}).catch(async e => { console.error(e); releaseVersion(); windows.forEach(w => w.destroy()); await host?.close(); provider?.closeAllConnections(); provider?.close(); app.exit(1); });
