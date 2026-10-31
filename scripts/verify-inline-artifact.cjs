// Focused renderer checks; real publication/transport coverage lives in verify-artifact-ui.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const assert = require('node:assert/strict'), path = require('node:path');
const { createPreviewServer } = require('./dev-ui.cjs');
app.disableHardwareAcceleration(); app.setPath('userData', path.resolve(__dirname, '../artifacts/inline-artifact-profile'));
let server, win;
app.whenReady().then(async () => {
  server = createPreviewServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const run = source => win.webContents.executeJavaScript(source);
  const until = async source => { const end = Date.now() + 8000; while (!await run(source)) { if (Date.now() > end) throw Error(source); await new Promise(r => setTimeout(r, 20)); } };
  const harness = await build({ stdin: { resolveDir: path.resolve(__dirname, '..'), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import InlineArtifact from './renderer/chat/inline-artifact';
    const host=document.createElement('div'); host.className='chat-app'; document.body.replaceChildren(host);const root=createRoot(host);
    window.requests=[];window.pending=[];window.fail=false;
    const report=q=>({artifactId:q.artifactId,version:q.version,roomId:q.roomId,taskId:'task',runId:'run',producerAgentId:'alpha',title:'报告',catalogVersion:1,createdAt:new Date().toISOString(),contentHash:'a'.repeat(64),spec:{root:'root',elements:{
      root:{type:'Section',props:{title:q.artifactId,description:'生成式预览'},children:['group']},
      group:{type:'Section',props:{title:'方案 A 的数据',description:'分组说明必须保留'},children:['table']},
      table:{type:'Table',props:{columns:['A','B','C','D','E'],rows:Array.from({length:10},(_,i)=>['行'+i,'2','3','4','5'])},children:[]}
    }}});
    const client={query:async q=>{window.requests.push(q);if(q.artifactId==='slow')await new Promise(r=>window.pending.push(r));if(window.fail)throw {code:'forbidden'};const value=report(q);if(q.artifactId==='invalid')value.spec.elements.table.type='Field';if(q.artifactId==='wrong-room')value.roomId='other';return value;}};
    window.showInline=(id,offscreen=false)=>root.render(<div className='messages' style={{height:600,overflow:'auto'}}><div style={{height:offscreen?3000:0}}/><InlineArtifact client={client} selection={{roomId:'room',messageId:'message',artifactId:id,version:1,title:'报告'}} mock={false} open={()=>{}}/></div>);
    window.showInline('offscreen',true);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  await run(harness.outputFiles[0].text);
  await until('Boolean(document.querySelector(".inline-artifact"))');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await run('window.requests.length'), 0, 'Offscreen reports must not load eagerly');
  await run('document.querySelector(".inline-artifact").scrollIntoView()');
  await until('Boolean(document.querySelector(".inline-artifact table"))');
  assert.equal(await run('document.querySelectorAll("tbody tr").length'), 5);
  assert.equal(await run('document.querySelectorAll("thead th").length'), 4);
  assert.ok(await run('document.querySelector(".inline-artifact-content").textContent.includes("方案 A 的数据")'), 'Nested section context must survive preview truncation');
  assert.ok(await run('document.querySelector(".inline-artifact").textContent.includes("预览已节选")'));
  await run('window.showInline("slow")'); await until('window.pending.length===1');
  await run('window.showInline("new")'); await until('document.querySelector(".result-section h3")?.textContent==="new"');
  await run('window.pending[0]()'); await new Promise(r => setTimeout(r, 80));
  assert.equal(await run('document.querySelector(".result-section h3").textContent'), 'new', 'Late old response must not replace current content');
  for (const id of ['invalid', 'wrong-room']) {
    await run(`window.showInline(${JSON.stringify(id)})`); await until('document.querySelector(".inline-artifact [role=status]")?.textContent.includes("未通过校验")');
    assert.equal(await run('Boolean(document.querySelector(".result-section"))'), false);
  }
  await run('window.fail=true;window.showInline("retry")');
  await until('document.querySelector(".inline-artifact [role=status]")?.textContent.includes("无权读取")');
  const height = await run('document.querySelector(".inline-artifact").getBoundingClientRect().height');
  await run('window.fail=false;document.querySelector(".inline-artifact [role=status] button").click()');
  await until('Boolean(document.querySelector(".result-section"))');
  assert.equal(await run('document.querySelector(".inline-artifact").getBoundingClientRect().height'), height, 'Loading or retry must not shift the reading layout');
  win.setContentSize(420, 800); await run('document.documentElement.dataset.theme="dark"');
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  console.log('Passed: viewport loading, bounded table preview, stale responses, invalid/cross-room data rejection, retry, stable height and narrow layout.');
}).catch(e=>{ console.error(e); process.exitCode=1; }).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0);});
