const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs/promises');
const { build } = require('esbuild');
const { createPreviewServer } = require('./dev-ui.cjs');
app.disableHardwareAcceleration(); app.setPath('userData',path.resolve(__dirname,'../artifacts/member-panel-profile'));
let server,win;
app.whenReady().then(async()=>{
 server=createPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
 const run=s=>win.webContents.executeJavaScript(s), key=k=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:k});win.webContents.sendInputEvent({type:'keyUp',keyCode:k});};
 const until=async s=>{const end=Date.now()+8000;while(!await run(s)){if(Date.now()>end)throw Error(s);await new Promise(r=>setTimeout(r,25));}};
 const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`);
 const contrast=async()=>{const minimum=await run(`(()=>{const rgb=s=>s.match(/[\\d.]+/g).map(Number);const lum=c=>c.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);return Math.min(...Array.from(document.querySelectorAll('.member-menu[open] button,.member-menu[open] small')).map(el=>{let p=el,bg;do{bg=rgb(getComputedStyle(p).backgroundColor);p=p.parentElement;}while(bg[3]===0&&p);const a=lum(rgb(getComputedStyle(el).color)),b=lum(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}))})()`);assert.ok(minimum>=4.5,`Member menu text contrast ${minimum}`);};
 const capture=async name=>{await new Promise(r=>setTimeout(r,200));await fs.writeFile(path.resolve(__dirname,`../artifacts/${name}.png`),(await win.webContents.capturePage()).toPNG());};
 await win.loadURL(`http://127.0.0.1:${server.address().port}`);await until('Boolean(document.querySelector("[aria-label=房间成员]"))');
 await click('[aria-label=房间成员]');await until('Boolean(document.querySelector(".member-entry"))');
 assert.equal(await run('document.querySelectorAll(".member-confirm").length'),0);
 await capture('member-panel-light');
 await run('document.querySelector(".member-menu summary").focus()');key('Space');await until('document.querySelector(".member-menu").open');await contrast();await capture('member-menu-light');
 key('Tab');await until('document.activeElement.textContent.includes("停止会话")');key('Escape');
 assert.equal(await run('document.querySelector(".member-menu").open'),false);
 assert.equal(await run('document.activeElement.tagName'),'SUMMARY');
 await click('.member-menu summary');await click('.member-menu .member-danger');await until('Boolean(document.querySelector(".member-confirm"))');
 assert.equal(await run('document.activeElement.textContent'),'取消');await capture('member-confirm-light');key('Escape');
 await until('!document.querySelector(".member-confirm")');assert.ok(await run('Boolean(document.querySelector(".details-panel"))'));
 await click('.member-menu summary');await run("document.querySelector('.details-title').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");assert.equal(await run('document.querySelector(".member-menu").open'),false);
 win.setContentSize(390,800);await run('document.querySelector("[aria-label=切换侧栏]").click();document.documentElement.dataset.theme="dark"');await click('.member-menu summary');await new Promise(r=>setTimeout(r,350));await contrast();await capture('member-menu-dark-narrow');
 assert.ok(await run('(()=>{const r=document.querySelector(".member-menu-content").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'));
 // Isolate command behavior: no real Agent is stopped or removed.
 const harness=await build({stdin:{resolveDir:path.resolve(__dirname,'..'),loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemberActions} from './renderer/chat/members';
 window.memberTest={calls:[],fail:false,pause:false};const t=window.memberTest;
 function Harness(){const[live,setLive]=useState(true);t.setLive=setLive;return <MemberActions agent={{id:'test',displayName:'测试成员',status:'listening'}} live={live} client={{dispatch:async c=>{t.calls.push(c);if(t.fail)throw Error('模拟失败，请重试');if(t.pause)await new Promise(r=>t.resume=r);return {accepted:true};}}}><button>测试成员</button></MemberActions>}
 document.querySelector('#chat-root').style.display='none';const host=document.createElement('div');host.className='chat-app';host.style.cssText='padding:24px;width:280px';document.body.append(host);createRoot(host).render(<Harness/>);
 `},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
 await run(harness.outputFiles[0].text);const base='body > .chat-app';await until(`Boolean(document.querySelector('${base} .member-menu'))`);
 const menu=`${base} .member-menu`,confirm=`${base} .member-confirm`;
 await click(`${menu} summary`);await click(`${menu} .member-danger`);await click(`${confirm} button`);assert.equal(await run('memberTest.calls.length'),0);
 await run('memberTest.setLive(false)');await click(`${menu} summary`);assert.ok(await run(`Array.from(document.querySelectorAll('${menu} button')).every(b=>b.disabled)`));
 await run('memberTest.setLive(true);memberTest.fail=true');await until(`!document.querySelector('${menu} button').disabled`);await click(`${menu} button`);await until(`document.querySelector('${base} [role=alert]')?.textContent.includes('模拟失败')`);
 await run('memberTest.fail=false;memberTest.pause=true');await click(`${menu} button`);await until(`document.querySelector('${menu} button').disabled`);await click(`${menu} button`);assert.equal(await run('memberTest.calls.length'),2);
 await run('memberTest.resume()');await until(`!document.querySelector('${menu}').open`);assert.equal(await run('memberTest.calls[1].type'),'stopAgent');
 await run('memberTest.pause=false');await click(`${menu} summary`);await click(`${menu} .member-danger`);await until(`Boolean(document.querySelector('${confirm}'))`);
 await run('memberTest.setLive(false)');await until(`document.querySelector('${confirm} .member-danger').disabled`);
 await click(`${confirm} .member-danger`);assert.equal(await run('memberTest.calls.length'),2);
 await run('memberTest.setLive(true)');await until(`!document.querySelector('${confirm} .member-danger').disabled`);await click(`${confirm} .member-danger`);
 await until(`!document.querySelector('${confirm}')`);assert.deepEqual(await run('memberTest.calls.map(c=>[c.type,c.agentId])'),[['stopAgent','test'],['stopAgent','test'],['removeAgent','test']]);
 console.log('Passed: member disclosure, keyboard/Escape/focus, cancel, outside dismiss, offline/busy, error/retry, exact commands and light/dark narrow layout.');
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0);});
