const {app,BrowserWindow}=require('electron'),{startPersistentHost}=require('../lib/persistence-host.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.setPath('userData',path.resolve(__dirname,'../artifacts/attachments-ui-profile'));
let host,windows=[],directory;const errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=(win,code)=>win.webContents.executeJavaScript(code).catch(error=>{throw Error(code+'\n'+error.message+'\n'+errors.join('\n'));});
async function until(win,code){const end=Date.now()+15000;while(!await run(win,code)){if(Date.now()>end)throw Error('UI timed out: '+code+'\n'+await run(win,'document.body.innerText'));await delay(30);}}
async function choose(win,file){win.webContents.debugger.attach('1.3');try{const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:file?[file]:[]});}finally{win.webContents.debugger.detach();}}
async function download(win,name,target){
  const saved=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Download timed out')),15000);win.webContents.session.once('will-download',(_event,item)=>{assert.equal(item.getFilename(),name);item.setSavePath(target);item.once('done',(_e,state)=>{clearTimeout(timer);state==='completed'?resolve():reject(Error(state));});});});
  await run(win,`document.querySelector(${JSON.stringify(`[aria-label="下载 ${name}"]`)}).click()`);await saved;return fs.readFile(target);
}
app.whenReady().then(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-attachment-ui-'));await fs.mkdir(path.resolve(__dirname,'../artifacts'),{recursive:true});
  const bytes=Buffer.from('真实附件：上传、关联、下载\nUTF-8'),file=path.join(directory,'报告.txt'),second=path.join(directory,'待发送.md');await fs.writeFile(file,bytes);await fs.writeFile(second,'# 待发送内容');
  host=await startPersistentHost({directory:path.join(directory,'db'),port:0});const origin=host.origin;
  for(const desktop of [true,false]){
    const win=new BrowserWindow({show:false,width:1300,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,...(desktop?{preload:path.resolve(__dirname,'../preload.cjs'),additionalArguments:['--persistent-ui']}:{})}});windows.push(win);
    win.webContents.on('console-message',event=>{if(event.level==='error'&&!/net::ERR|Failed to load resource/.test(event.message))errors.push(event.message);});await win.loadURL(origin);await until(win,'document.querySelector("#connection-text")?.textContent==="已连接" && !!document.querySelector("input[type=file]")');
  }
  const [a,b]=windows;await choose(a,file);await until(a,'document.querySelector(".attachment-list input")?.checked===true');
  assert.equal(await run(a,'document.querySelector("#message-input").value'),'');assert.equal(await run(a,'document.querySelector("#send-button").disabled'),false);
  await run(a,'document.querySelector("#send-button").click()');await until(b,'!!document.querySelector(`[aria-label="下载 报告.txt"]`)');
  assert.deepEqual(await download(b,'报告.txt',path.join(directory,'download.txt')),bytes);
  await choose(a,second);await until(a,'document.querySelector(".attachment-list input")?.checked===true');
  await a.webContents.insertText('');await run(a,'document.querySelector("#message-input").focus()');await a.webContents.insertText('保留输入草稿');await a.reload();await until(a,'document.querySelector("#message-input")?.value==="保留输入草稿" && document.querySelector(".attachment-picker input[type=checkbox]")?.checked===true');
  await choose(a,null);assert.equal(await run(a,'document.querySelector(".attachment-picker input[type=checkbox]").checked'),true);
  let lose=true,uploads=0;
  a.webContents.session.webRequest.onHeadersReceived({urls:[origin+'/api/v1/rooms/*/attachments']},(details,callback)=>{uploads++;if(lose){lose=false;callback({cancel:true});return;}callback({});});
  await choose(a,file);await until(a,'document.querySelector(".attachment-pending")?.textContent.includes("结果待核查") && !!document.querySelector(".attachment-picker [role=alert]")');a.webContents.session.webRequest.onHeadersReceived(null);
  await run(a,'Array.from(document.querySelectorAll(".attachment-pending button")).find(b=>b.textContent==="核查原请求").click()');await until(a,'!document.querySelector(".attachment-pending")');assert.equal(uploads,1);
  assert.equal(await run(a,'document.querySelector("#message-input").value'),'保留输入草稿');
  await run(a,'document.querySelector(`[aria-label="移除暂存附件 待发送.md"]`).click()');await until(a,'!document.querySelector(`[aria-label="移除暂存附件 待发送.md"]`)');
  const bad=path.join(directory,'bad.png');await fs.writeFile(bad,'not png');await choose(a,bad);await until(a,'document.querySelector(".attachment-picker [role=alert]")?.textContent.includes("签名")');
  await fs.writeFile(path.resolve(__dirname,'../artifacts/attachments-light-wide.png'),(await a.webContents.capturePage()).toPNG());
  await run(b,'document.documentElement.dataset.theme="dark"');b.setContentSize(420,860);await run(b,'document.querySelector("[aria-label=收起侧栏]").click()');await delay(500);assert.equal(await run(b,'document.documentElement.scrollWidth<=innerWidth'),true);await fs.writeFile(path.resolve(__dirname,'../artifacts/attachments-dark-narrow.png'),(await b.webContents.capturePage()).toPNG());
  await host.close();host=await startPersistentHost({directory:path.join(directory,'db'),port:Number(new URL(origin).port)});await b.reload();await until(b,'!!document.querySelector(`[aria-label="下载 报告.txt"]`)');
  const after=await download(b,'报告.txt',path.join(directory,'after-restart.txt'));assert.deepEqual(after,bytes);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'passed',sha256:createHash('sha256').update(after).digest('hex'),scenarios:['desktop/Web real file input','attachment-only send','authenticated host download','reload selection/draft','cancel file selection','lost response receipt without replay','pending removal','invalid content','backend restart download','light/wide and dark/narrow'],directory}));
  windows.forEach(w=>w.destroy());windows=[];await host.close();host=null;app.quit();
}).catch(async e=>{console.error(e);windows.forEach(w=>w.destroy());await host?.close();app.exit(1);});
