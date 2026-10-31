// Production launcher, authenticated host, public Client, real Pi CLI and SQLite.
// The inference endpoint is loopback-only: no paid/external model requests.
const { app, BrowserWindow } = require('electron');
const { startPersistentHost } = require('../lib/persistence-host.cjs');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
app.disableHardwareAcceleration(); app.on('window-all-closed',()=>{});
app.setPath('userData',path.resolve(__dirname,'../artifacts/curation-production-profile'));
let host,provider,windows=[],calls=0,providerError;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=(win,code)=>win.webContents.executeJavaScript(code);
async function until(win,code) {const end=Date.now()+45000;while(!await js(win,code)){if(Date.now()>end)throw Error('UI timed out: '+code);await delay(50);}}
async function click(win,text,root='document') {const button=`[...${root}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`;await until(win,`Boolean(${button})&&!${button}.disabled`);await js(win,`${button}.click()`);}
async function input(win,label,text) {await until(win,`Boolean(document.querySelector('textarea[aria-label="${label}"]'))`);await js(win,`(()=>{const el=document.querySelector('textarea[aria-label="${label}"]');el.focus();el.select();})()`);await win.webContents.insertText(text);}
const section='document.querySelector(".memory-curation-section")';
async function open(win) {await js(win,'document.querySelector("[aria-label=设置]").click()');await click(win,'记忆');await until(win,`Boolean(${section})`);await js(win,'(()=>{const select=document.querySelector("[aria-label=记忆归属]");select.value="local-pi";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await until(win,`${section}?.getAttribute('aria-label')==='local-pi的自动记忆整理'`);}
app.whenReady().then(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-curator-production-'));
  provider=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer LOOPBACK-ONLY');
      let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);calls++;
      assert.equal((data.tools||[]).length,0);
      const texts=data.messages.flatMap(m=>typeof m.content==='string'?[m.content]:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text));
      assert.ok(texts.every(text=>!text.includes('独立个性不能被整理')));
      const prompt=texts.find(text=>text.includes('你是记忆整理员。'));assert.ok(prompt);
      const {inputs}=JSON.parse(prompt.split('\n').at(-1));assert.deepEqual(new Set(inputs.map(i=>i.text)),new Set(['先给结论','再说明依据']));
      const content=JSON.stringify({summaries:[{inputs:inputs.map(i=>i.key),text:'先给结论，再说明依据。',reason:'两条互补的表达偏好'}],archives:[]});
      const base={id:'curation-production',model:'memory-fixture',created:1,object:'chat.completion.chunk'};
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\n');
      res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n');
    } catch(e) {providerError=e;res.writeHead(500);res.end('Fixture rejected request');}
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  process.env.AGENTROOM_CURATOR_FIXTURE_TOKEN='LOOPBACK-ONLY';
  const memoryCuratorConfig=path.join(directory,'curator.json');
  await fs.writeFile(memoryCuratorConfig,JSON.stringify({version:1,agentId:'memory-curator',displayName:'后台整理员',model:'memory-fixture',connection:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,protocol:'chat',authMode:'bearer',credentialEnv:'AGENTROOM_CURATOR_FIXTURE_TOKEN'}}));
  const start=port=>startPersistentHost({directory,agentWorkspace:directory,memoryCuratorConfig,port,nodeExecutable:process.env.AGENTROOM_NODE||'node',rendererRoot:path.resolve(__dirname,'../renderer')});
  host=await start(0);const errors=[];
  for(const desktop of [true,false]) {
    const win=new BrowserWindow({width:1280,height:960,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:desktop?'curator-desktop':'curator-web',...(desktop?{preload:path.resolve(__dirname,'../preload.cjs'),additionalArguments:['--persistent-ui']}:{})}});
    windows.push(win);win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});await win.loadURL(host.origin);await until(win,'document.querySelector("#connection-text")?.textContent==="已连接"');await open(win);
  }
  const [a,b]=windows;
  await click(a,'暂停自动整理');await until(a,`${section}.textContent.includes('自动整理已暂停')`);
  await input(a,'个性','独立个性不能被整理');await click(a,'保存 Soul');
  for(const text of ['先给结论','再说明依据']) {await input(a,'新记忆',text);await click(a,'保存明确记忆');await until(a,`[...document.querySelectorAll('[data-memory-id] p')].some(p=>p.textContent===${JSON.stringify(text)})`);}
  assert.equal(calls,0);await click(a,'启用自动整理');
  const end=Date.now()+45000;
  while(!await js(a,`${section}.textContent.includes('先给结论，再说明依据。')`)) {if(Date.now()>end)throw Error('Background summary did not reach Settings');await click(a,'刷新整理状态');await delay(150);}
  if(providerError)throw providerError;assert.equal(calls,1);
  await click(a,'暂停自动整理');await until(a,`${section}.textContent.includes('自动整理已暂停')`);
  await click(b,'刷新整理状态');await until(b,`${section}.textContent.includes('先给结论，再说明依据。')`);
  await js(b,'document.querySelector(".memory-curation-history").open=true');await until(b,'document.querySelector(".memory-curation-history").textContent.includes("memory-curator · memory-fixture")');
  await js(b,'document.querySelector(".memory-curation-summaries details").open=true');
  await js(b,'document.querySelector(".memory-curation-summaries button").click()');await until(b,'document.body.textContent.includes("所选记忆的历史")');
  await fs.mkdir(path.resolve(__dirname,'../artifacts'),{recursive:true});
  await fs.writeFile(path.resolve(__dirname,'../artifacts/memory-curation-production.png'),(await b.webContents.capturePage()).toPNG());
  await js(b,'document.documentElement.dataset.theme="dark"');b.setContentSize(420,860);await delay(120);
  assert.ok(await js(b,'document.documentElement.scrollWidth<=innerWidth && document.querySelector(".settings-dialog").scrollWidth<=document.querySelector(".settings-dialog").clientWidth'));
  await fs.writeFile(path.resolve(__dirname,'../artifacts/memory-curation-production-dark.png'),(await b.webContents.capturePage()).toPNG());
  await click(a,'更正记忆',`[...document.querySelectorAll('[data-memory-id]')].find(el=>el.querySelector('p').textContent==='先给结论')`);
  await input(a,'更正内容','先说明风险，再给结论');await click(a,'保存更正');
  await until(a,`[...document.querySelectorAll('[data-memory-id] p')].some(p=>p.textContent==='先说明风险，再给结论')`);
  await click(a,'刷新整理状态');await until(a,`${section}.textContent.includes('0 条有效摘要') && ${section}.textContent.includes('1 条旧摘要')`);
  assert.equal(await js(a,'document.querySelector("textarea[aria-label=个性]").value'),'独立个性不能被整理');
  const port=Number(new URL(host.origin).port);await host.close();host=await start(port);
  for(const win of windows) {await win.loadURL(host.origin);await until(win,'document.querySelector("#connection-text")?.textContent==="已连接"');await open(win);await until(win,`${section}.textContent.includes('自动整理已暂停') && ${section}.textContent.includes('1 条旧摘要')`);}
  assert.equal(calls,1);assert.deepEqual(errors,[]);
  console.log('PASS: production --memory-curator-config launcher → authenticated Web/desktop Settings → real no-tools Pi → SQLite summary/history; pause, sources, correction invalidation, restart, independent Soul and dark narrow UI; 1 loopback call, 0 paid calls.');
  windows.forEach(w=>w.destroy());windows=[];await host.close();host=null;await new Promise(r=>provider.close(r));provider=null;app.quit();
}).catch(async error=>{console.error(error);if(windows[0]&&!windows[0].isDestroyed())console.error(await js(windows[0],'document.body.innerText').catch(()=>''));windows.forEach(w=>w.destroy());await host?.close();provider?.close();app.exit(1);});
