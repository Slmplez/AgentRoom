const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {build}=require('esbuild'),{createPreviewServer}=require('./dev-ui.cjs');
app.disableHardwareAcceleration();app.setPath('userData',path.resolve(__dirname,'../artifacts/diff-workspace-profile'));
let win,server;
app.whenReady().then(async()=>{
 server=createPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));win=new BrowserWindow({show:false,width:1400,height:960,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=s=>win.webContents.executeJavaScript(s),until=async s=>{const end=Date.now()+9000;while(!await run(s)){if(Date.now()>end)throw Error(s+'\n'+errors);await new Promise(r=>setTimeout(r,25));}};
 const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`),capture=async name=>{await new Promise(r=>setTimeout(r,350));await fs.writeFile(path.resolve(__dirname,`../artifacts/${name}.png`),(await win.webContents.capturePage()).toPNG());};
 await win.loadURL(`http://127.0.0.1:${server.address().port}`);await until('Boolean(document.querySelector("#message-input"))');
 const patch=name=>`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,32 @@\n-old\n`+Array.from({length:32},(_,i)=>`+export const value${i} = ${i};`).join('\n')+'\n';
 const patches=[patch('contracts/attachments.mjs'),patch('lib/application-runtime/attachments.mjs'),patch('lib/attachment-transfer.cjs')];
 const harness=await build({stdin:{resolveDir:path.resolve(__dirname,'..'),loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DiffPreview} from './renderer/chat/diff-preview';
 const patches=${JSON.stringify(patches)};window.diffTest={};
 function Harness(){const[theme,setTheme]=useState('light');window.diffTest.theme=t=>{document.documentElement.dataset.theme=t;setTheme(t)};return <div className="app-layout" data-result-layout="overlay"><DiffPreview patches={patches} theme={theme} close={()=>{window.diffTest.closed=true}}/></div>}
 document.querySelector('#chat-root').remove();const root=document.createElement('div');root.className='chat-app';document.body.append(root);createRoot(root).render(<Harness/>);
 `},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
 await run(harness.outputFiles[0].text);await until('document.querySelectorAll("diffs-container").length===3');await until('Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector("code"))');
 assert.ok(await run('document.querySelector(".diff-overview").textContent.includes("+96")'));assert.ok(await run('document.querySelector(".diff-overview").textContent.includes("−3")'));
 await capture('diff-workspace-light');
 await click('.diff-file-tree details:last-child button');await until('document.activeElement.dataset.diffFile==="2"');assert.ok(await run('document.querySelector(".diff-code-scroll").scrollTop>0'));
 await run('document.querySelector("[aria-label=筛选文件]").focus()');await win.webContents.insertText('transfer');await until('document.querySelectorAll(".diff-file-tree button").length===1');
 await win.webContents.insertText('不存在');await until('document.querySelector(".diff-no-files")?.textContent.includes("没有匹配")');
 await run('document.querySelector("[aria-label=筛选文件]").select()');await win.webContents.insertText('');await until('document.querySelectorAll(".diff-file-tree button").length===3');
 await run('document.querySelectorAll(".diff-view-switch button")[2].click()');await until('Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-diff-type=split]"))');
 await run('document.querySelectorAll(".diff-view-switch button")[0].click()');await until('document.querySelectorAll("diffs-container").length===0');await click('.diff-summary > button:last-child');await until('document.activeElement.dataset.diffFile==="2"');
 await run('diffTest.theme("dark");document.querySelector(".diff-code-scroll").scrollTop=0');await until('Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector("code"))');await capture('diff-workspace-dark');
 await click('[aria-label=收起变更工作区]');assert.equal(await run('document.querySelector(".diff-preview").classList.contains("diff-expanded")'),false);
 await click('[aria-label=展开变更工作区]');win.setContentSize(390,800);await click('[aria-label=文件列表]');await capture('diff-workspace-narrow');
 assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
 await click('[aria-label=文件列表]');await click('.diff-file-tree details:last-child button');await until('!document.querySelector(".diff-file-list")');
 await run('document.querySelector("#diff-title").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await until('diffTest.closed===true');
 assert.deepEqual(errors,[]);console.log('Passed: unified default, per-file/total counts, directory filtering, empty search, file jump, summary jump, split, expand/collapse, narrow drawer, dark theme and Escape.');
}).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0)});
