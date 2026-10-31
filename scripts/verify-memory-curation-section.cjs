// Isolated presentation fixture: no production Client, API, data or model.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ar-curation-view-')));
let win, server;
app.whenReady().then(async () => {
  const result = await build({ stdin: { sourcefile: 'curation-fixture.tsx', resolveDir: resolve(__dirname, '..'), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryCurationSection} from './renderer/chat/memory-curation-section';
    import {MemoryCurationController} from './renderer/chat/memory-curation-controller';
    const root=createRoot(document.getElementById('root')); window.actions=[];
    const run={id:'run-1',status:'unknown',note:'结果待核查',leaseHeld:1,startedAt:1800000000000,finishedAt:null};
    const initial={configured:true,enabled:true,revision:3,summaries:[{id:'summary-1',runId:'run-0',text:'先给结论，再解释依据。',reason:'合并两条互补偏好',refs:[{id:'source-1',revision:2}]}],pending:1,stale:0,latestRun:run};
    const history={before:null,runs:[{id:'run-0',status:'applied',note:'整理已应用',startedAt:1800000000000,finishedAt:1800000001000,position:1,input:{scope:{kind:'agent',agentId:'iris'},executor:{agentId:'memory-curator',model:'fixture'},inputs:[{key:'input-1',kind:'record',text:'旧的临时安排',refs:[{id:'source-2',revision:1}]}],selected:[{id:'source-2',revision:1}],prompt:'隔离界面夹具'},output:{summaries:[],archives:[{inputs:['input-1'],reason:'已被明确取消'}]}}]};
    let props={scopeLabel:'Iris',status:initial,history:null,busy:false,modelLabel:'fixture'};
    function render(){root.render(<MemoryCurationSection key={props.scopeLabel} {...props}
      onRefresh={()=>window.actions.push(['refresh'])}
      onConfigure={(enabled,revision)=>window.actions.push(['configure',enabled,revision])}
      onInspect={id=>window.actions.push(['inspect',id])}
      onSource={(id,revision)=>window.actions.push(['source',id,revision])}
      onHistory={before=>{window.actions.push(['history',before??null]);props={...props,history};render();}}/>);}
    window.setFixture=patch=>{props={...props,...patch};render();};window.initialStatus=initial;render();
    const listeners=new Set();let pending=[];
    const notify=()=>listeners.forEach(fn=>fn());
    const bridge={
      status:async()=>initial,history:async()=>history,
      pending:()=>{if(window.breakJournal)throw Error('unreadable journal');return pending;},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
      async configure(command){window.actions.push(['controller-configure',command.key]);pending=[{key:command.key,outcome:'unknown'}];notify();throw Object.assign(Error('Response unknown'),{outcome:'unknown'});},
      async inspect(){throw Error('unexpected inspect');},
      async check(key){window.actions.push(['controller-check',key]);pending=[];notify();return{accepted:true};},
      async retry(key){window.actions.push(['controller-retry',key]);throw Error('unexpected retry');}
    };
    window.mountController=key=>root.render(<MemoryCurationController key={key} bridge={bridge} workspaceId="workspace" scope={{kind:'agent',agentId:'iris'}} scopeLabel="Iris" live={true} onSource={()=>{}}/>);
  ` }, bundle: true, write: false, outdir: 'fixture', format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  const js = result.outputFiles.find(f => f.path.endsWith('.js')).text, css = result.outputFiles.find(f => f.path.endsWith('.css')).text;
  server = http.createServer((req, res) => {
    if (req.url === '/view.js') { res.setHeader('content-type', 'text/javascript'); return res.end(js); }
    if (req.url === '/view.css') { res.setHeader('content-type', 'text/css'); return res.end(css); }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/view.css"><style>:root{--line-strong:#ccc;color:#222;background:#fff;font:14px system-ui}body{margin:16px}.button{padding:8px;border:1px solid #aaa;border-radius:6px;background:transparent;color:inherit}button:disabled{opacity:.45}h3{margin:0}small{color:#555}body.dark{background:#222;color:#eee;--line-strong:#666}</style><div id="root"></div><script src="/view.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [];
  win = new BrowserWindow({ show: false, width: 800, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith(origin) }));
  const run = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(code + " :: " + error.message + " :: " + errors.join(" | ")); });
  const until = async code => { const end = Date.now() + 5000; while (!await run(code)) { if (Date.now() > end) throw Error(code + '\n' + errors.join('\n')); await new Promise(r => setTimeout(r, 20)); } };
  const click = text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await win.loadURL(origin); await until('Boolean(document.querySelector(".memory-curation-section"))');
  assert.deepEqual(await run('window.actions'), []);
  await run('document.querySelector(".memory-curation-summaries details").open=true');
  await click('来源 source-1 · v2'); assert.deepEqual(await run('window.actions.at(-1)'), ['source', 'source-1', 2]);
  assert.equal(await run('document.body.textContent.includes("允许重新整理当前记录")'), false);
  await click('核查原整理进程'); assert.deepEqual(await run('window.actions.at(-1)'), ['inspect', 'run-1']);
  await run('setFixture({status:{...initialStatus,latestRun:{...initialStatus.latestRun,leaseHeld:0}}})');
  await until('document.body.textContent.includes("允许重新整理当前记录")');
  await click('允许重新整理当前记录'); assert.deepEqual(await run('window.actions.at(-1)'), ['configure', true, 3]);
  await click('暂停自动整理'); assert.deepEqual(await run('window.actions.at(-1)'), ['configure', false, 3]);
  await run('setFixture({busy:true})'); await until('document.querySelector("button").disabled');
  const before = await run('window.actions.length'); await click('暂停自动整理'); assert.equal(await run('window.actions.length'), before);
  await run('setFixture({busy:false})'); await until('!document.querySelector("button").disabled');
  await run('document.querySelector(".memory-curation-history").open=true'); await until('document.body.textContent.includes("已被明确取消")');
  assert.equal(await run('window.actions.filter(a=>a[0]==="history").length'), 1);
  await run('setFixture({scopeLabel:"Room B",status:{...initialStatus,summaries:[],pending:0,configured:false},history:null})');
  await until("document.querySelector('.memory-curation-section')?.getAttribute('aria-label')==='Room B的自动记忆整理'");
  assert.equal(await run('document.body.textContent.includes("旧的临时安排")'), false);
  assert.equal(await run('document.body.textContent.includes("启用自动整理")'), false);
  assert.equal(await run('document.body.textContent.includes("尚未配置后台整理 Agent")'), true);
  await run('document.body.className="dark"'); win.setSize(360, 900);
  await until('window.innerWidth<=360');
  assert.equal(await run('document.documentElement.scrollWidth<=window.innerWidth'), true);
  await run('mountController("first")'); await until('document.body.textContent.includes("自动整理已启用")');
  await click('暂停自动整理'); await until('document.body.textContent.includes("核查原整理请求")');
  const submittedKey = await run('window.actions.find(a=>a[0]==="controller-configure")[1]');
  assert.equal(await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="暂停自动整理").disabled'), true);
  await run('mountController("remount")'); await until('document.body.textContent.includes("核查原整理请求")');
  assert.equal(await run('window.actions.filter(a=>a[0]==="controller-configure").length'), 1, 'Remount must not resubmit');
  await click('核查原整理请求'); await until('!document.body.textContent.includes("核查原整理请求")');
  assert.deepEqual(await run('window.actions.filter(a=>a[0]==="controller-check").at(-1)'), ['controller-check', submittedKey]);
  assert.equal(await run('window.actions.filter(a=>a[0]==="controller-configure").length'), 1);
  await run('window.breakJournal=true;mountController("broken-journal")'); await until('document.body.textContent.includes("原请求日志不可读取")');
  assert.equal(await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="刷新整理状态").disabled'), false);
  await run('window.breakJournal=false'); await click('刷新整理状态'); await until('!document.body.textContent.includes("原请求日志不可读取")');
  assert.deepEqual(errors, []);
  console.log('PASS: isolated settings presentation/controller verifies lease/busy controls, provenance, scope remount, unconfigured/narrow states, unknown request reconciliation without resubmission, recoverable journal errors; 0 backend/model calls.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { win?.destroy(); if (server) await new Promise(r => server.close(r)); app.exit(process.exitCode || 0); });
