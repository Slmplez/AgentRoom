// Isolated real Git/HTTP panel verification; production host acceptance follows shared-entry handoff.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{build}=require('esbuild'),{createPreviewServer}=require('./dev-ui.cjs');
app.on('window-all-closed',()=>{});app.disableHardwareAcceleration();app.setPath('userData',path.resolve(__dirname,'../artifacts/workspace-changes-ui-profile'));
let win,server,service,temp;
app.whenReady().then(async()=>{
 const {createFileReviewService}=await import('../lib/file-review/service.mjs'),{createFileReviewHandler}=await import('../lib/file-review/http.mjs');
 temp=await fs.mkdtemp(path.join(os.tmpdir(),'agentroom-changes-ui-'));const root=path.join(temp,'workspace');await fs.mkdir(root);
 const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
 git('init');git('config','user.name','Review UI');git('config','user.email','review@example.invalid');git('config','core.autocrlf','false');
 await fs.writeFile(path.join(root,'example.ts'),'export const title = "old";\n');await fs.writeFile(path.join(root,'deleted.txt'),'removed line\n');git('add','.');git('commit','-m','baseline');
 await fs.writeFile(path.join(root,'example.ts'),'export const title = "new";\n');await fs.unlink(path.join(root,'deleted.txt'));await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([0,255]));await fs.writeFile(path.join(root,'large.txt'),Buffer.alloc(262145,65));
 service=createFileReviewService({directory:path.join(temp,'data'),resolveScope:(input,caller)=>caller==='tester'&&input.workspaceId==='w'&&input.roomId==='r'?{workspaceId:'w',roomId:'r',root,authorId:'tester',authorName:'你',canWrite:true}:null});
 let origin;const handler=createFileReviewHandler({service,authenticate:req=>req.headers.cookie==='review-test=yes'&&req.headers.origin===origin?'tester':null});
 const staticServer=createPreviewServer();server=http.createServer(async(req,res)=>{if(await handler(req,res))return;if(req.url==='/')res.setHeader('Set-Cookie','review-test=yes; HttpOnly; SameSite=Strict; Path=/');staticServer.emit('request',req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 win=new BrowserWindow({show:false,width:1200,height:860,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=s=>win.webContents.executeJavaScript(s),until=async s=>{const end=Date.now()+15000;while(!await run(s)){if(Date.now()>end)throw Error(s+'\n'+errors+'\n'+await run('document.body.textContent.slice(-1800)'));await new Promise(r=>setTimeout(r,25));}};
 const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`),capture=async name=>{await new Promise(r=>setTimeout(r,200));await fs.writeFile(path.resolve(__dirname,`../artifacts/${name}.png`),(await win.webContents.capturePage()).toPNG());};
 const harness=await build({stdin:{resolveDir:path.resolve(__dirname,'..'),loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceChanges} from './renderer/chat/workspace-changes';import {createFileReviewClient} from './renderer/client/file-review.mjs';import {createFileReviewTransport} from './renderer/client/file-review-transport.mjs';
 const state={connection:'live',currentUserId:'tester',databaseId:'workspace-ui-test',rooms:[{id:'r',workspaceId:'w'}]};const client={read:()=>state,review:createFileReviewTransport()};const review=createFileReviewClient(client,{workspaceId:'w',roomId:'r',userId:'tester'});
 document.querySelector('#chat-root').remove();const host=document.createElement('div');host.className='chat-app';document.body.append(host);createRoot(host).render(<div className="app-layout" data-result-layout="overlay"><WorkspaceChanges theme="light" review={review} close={()=>{}}/></div>);
 `},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
 await win.loadURL(origin);await until('document.querySelector("#connection-text")?.textContent==="演示模式"');await run(harness.outputFiles[0].text);
 await until('document.querySelectorAll("[data-diff-file]").length===4&&document.querySelectorAll("diffs-container").length===2');
 const example='[aria-label="example.ts"]',deleted='[aria-label="deleted.txt"]';
 assert.equal(await run('document.querySelectorAll(".review-file-toolbar > button").length'),1);
 assert.equal(await run(`document.querySelector(${JSON.stringify(deleted)}).textContent.includes('只读')`),true);
 for(const name of ['binary.bin','large.txt'])assert.ok(await run(`document.querySelector('[aria-label="${name}"] .review-file-reason').textContent.length>0`));
 await capture('workspace-changes-real-files');
 await click(example+' .review-file-toolbar summary');await click(example+' .review-file-toolbar form button');await until('Boolean(document.querySelector(".review-comment-draft textarea"))');
 await run('document.querySelector(".review-comment-draft textarea").focus()');await win.webContents.insertText('此评论只属于原始补丁');await click('.review-comment-draft button[type=submit]');await until('Boolean(document.querySelector(".review-comment-thread article"))');
 await click(example+' .review-file-toolbar > button');await until('document.querySelector(".review-editor textarea")?.readOnly===false');await run('document.querySelector(".review-editor textarea").focus();document.querySelector(".review-editor textarea").select()');await win.webContents.insertText('export const title = "saved from workspace panel";\n');
 await until('document.querySelector(".review-editor [role=status]")?.textContent==="已自动保存"');assert.match(await fs.readFile(path.join(root,'example.ts'),'utf8'),/saved from workspace panel/);
 await click('.review-editor-toolbar button');await click('[aria-label="刷新工作区变更"]');await until('!document.querySelector("[aria-label=刷新工作区变更]").disabled&&Boolean(document.querySelector("diffs-container"))');
 await until('!document.querySelector(".review-comment-thread article")');
 // The state list stays visible when Git becomes unavailable; it is clearly marked stale.
 await fs.rename(path.join(root,'.git'),path.join(temp,'git-state'));await click('[aria-label="刷新工作区变更"]');await until('Boolean(document.querySelector(".workspace-changes-error"))');assert.match(await run('document.querySelector(".workspace-changes-error").textContent'),/上次读取/);
 await fs.rename(path.join(temp,'git-state'),path.join(root,'.git'));git('add','-A');git('commit','-m','accept isolated fixture changes');await click('[aria-label="刷新工作区变更"]');await until('Boolean(document.querySelector(".workspace-changes-empty"))');assert.equal(await run('document.querySelectorAll("[data-diff-file]").length'),0);await capture('workspace-changes-empty');
 await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([0,255,3]));await click('[aria-label="刷新工作区变更"]');await until('document.querySelectorAll("[data-diff-file]").length===1&&!document.querySelector("[aria-label=刷新工作区变更]").disabled');
 win.setContentSize(390,800);await run('document.documentElement.dataset.theme="dark"');await click('[aria-label="文件列表"]');await until('!document.querySelector(".diff-file-list")');assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));assert.equal(await run('document.querySelectorAll(".review-file-toolbar > button").length'),0);await capture('workspace-changes-readonly-dark-narrow');
 assert.deepEqual(errors.filter(x=>!x.includes('400')),[]);console.log('Passed: real Git status list, read-only reasons, comment version isolation, autosave to disk, refresh error/stale state, empty and read-only-only narrow views.');
}).catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{win?.destroy();server?.close();service?.close();if(temp)await fs.rm(temp,{recursive:true,force:true});app.exit(process.exitCode||0)});
