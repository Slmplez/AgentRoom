// Installed Pi CLIs, production host/config loader and two different loopback
// model/credential configurations. No Mock transport and no paid inference.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startPersistentHost } = require('../lib/persistence-host.cjs');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.setPath('userData',path.resolve(__dirname,'../artifacts/consultations-ui-profile'));
const delay = ms => new Promise(r => setTimeout(r,ms));
let host, provider, windows = [], requests = [];
const until = async (win,code) => { const end=Date.now()+45000;while(!await win.webContents.executeJavaScript(code)){if(Date.now()>end)throw Error('UI timed out: '+code);await delay(40);} };
app.whenReady().then(async()=>{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'agentroom-consult-ui-'));
  process.env.CONSULT_A_KEY='LOCAL-A';process.env.CONSULT_B_KEY='LOCAL-B';process.env.PI_CODING_AGENT_DIR=path.join(directory,'pi-home');
  provider=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.url,'/v1/chat/completions');let body='';for await(const chunk of req)body+=chunk;
      const data=JSON.parse(body), name=data.model==='advice-a'?'A':'B';
      assert.ok(['advice-a','advice-b'].includes(data.model));assert.equal(req.headers.authorization,'Bearer LOCAL-'+name);
      const texts=data.messages.flatMap(m=>typeof m.content==='string'?[m.content]:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text));
      assert.ok(texts.some(text=>text.includes('SOUL_'+name)&&text.includes('MEMORY_'+name)));
      assert.ok(texts.every(text=>!text.includes('SOUL_'+(name==='A'?'B':'A'))));
      assert.ok((data.tools||[]).every(t=>['read','grep','find','ls'].includes(t.function.name)));
      requests.push({model:data.model,texts});
      if(texts.some(text=>text.includes('慢咨询')||text.includes('等待重启'))) return;
      const base={id:'consult-'+requests.length,object:'chat.completion.chunk',created:1,model:data.model};
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Pi '+name+' recommendation'},finish_reason:null}]})+'\n\n');
      res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}})+'\n\ndata: [DONE]\n\n');
    }catch(e){res.writeHead(500);res.end(e.message);}
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const config=path.join(directory,'agents.json');
  await fs.writeFile(config,JSON.stringify({version:1,agents:['A','B'].map(name=>({id:'advisor-'+name.toLowerCase(),displayName:'Advisor '+name,directory,provider:'agent_room',model:'advice-'+name.toLowerCase(),connection:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,protocol:'chat',authMode:'bearer',credentialEnv:'CONSULT_'+name+'_KEY'}}))}));
  const start=port=>startPersistentHost({directory:path.join(directory,'database'),consultationConfig:config,rendererRoot:path.resolve(__dirname,'../renderer'),port,nodeExecutable:process.env.AGENTROOM_NODE||'node'});
  host=await start(0);const errors=[];
  for(const desktop of [true,false]){
    const win=new BrowserWindow({width:1380,height:960,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,...(desktop?{preload:path.resolve(__dirname,'../preload.cjs'),additionalArguments:['--persistent-ui']}:{})}});
    windows.push(win);win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});await win.loadURL(host.origin);
    await until(win,`document.querySelector('#connection-text')?.textContent==='已连接'`);
    assert.equal(await win.webContents.executeJavaScript(`Boolean(document.querySelector('.dev-controls'))`),false);
  }
  let [a,b]=windows;const run=(win,code)=>win.webContents.executeJavaScript(code);
  await run(a,`(async()=>{const boot=await fetch('/api/v1/bootstrap').then(r=>r.json());for(const name of ['A','B']){for(const [type,extra]of [['editAgentSoul',{agentId:'advisor-'+name.toLowerCase(),expectedRevision:0,personality:'SOUL_'+name,expression:'',workStyle:''}],['saveExplicitMemory',{scope:{kind:'agent',agentId:'advisor-'+name.toLowerCase()},text:'MEMORY_'+name,source:{kind:'owner-note'}}]]){const r=await fetch('/api/v1/agent-memory/commands',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({type,workspaceId:boot.workspace.id,...extra})});if(!r.ok)throw Error('Could not seed explicit context');}}})()`);
  const open=win=>run(win,`document.querySelector('.consultations').open=true;document.querySelector('.consultation-creator').open=true`);
  const create=async(win,title,agents=['Advisor A','Advisor B'])=>{
    await open(win);await run(win,`document.querySelector('textarea[aria-label=咨询问题]').focus()`);await win.webContents.insertText(title);
    if(!requests.length) { await run(win,`(()=>{const input=document.querySelector('textarea[aria-label=咨询问题]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'案'}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'案'}));})()`); assert.equal(requests.length,0); }
    for(const name of ['Advisor A','Advisor B'])await run(win,`(()=>{const el=document.querySelector('input[aria-label=${JSON.stringify('咨询 '+name)}]');if(el.checked!==${agents.includes(name)})el.click()})()`);
    await run(win,`document.querySelector('input[aria-label="咨询 Advisor B"]').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await until(win,`document.activeElement?.matches('[data-create-consultation]') && !document.activeElement.disabled`);
    await run(win,`document.activeElement.click()`);
  };
  let dropped=false;
  a.webContents.session.webRequest.onHeadersReceived({urls:[host.origin+'/api/v1/consultations/commands']},(_details,callback)=>{if(!dropped){dropped=true;callback({cancel:true});}else callback({});});
  await create(a,'比较两种方案');
  await until(a,`Boolean(document.querySelector('[data-check-consultation-operation]:enabled'))`);
  await run(a,`document.querySelector('[data-check-consultation-operation]').click()`);
  await until(a,`!document.querySelector('[data-check-consultation-operation]')`);
  await open(b);await until(b,`document.querySelectorAll('[data-assignment-status=answered]').length===2`);
  const qid=await run(b,`document.querySelector('[data-consultation-id]').dataset.consultationId`);
  assert.equal(await run(a,`document.querySelector('[data-consultation-id]').dataset.consultationId`),qid);
  assert.equal(await run(b,`document.querySelector('[data-consultation-id]').dataset.consultationState`),'pending');
  await run(a,`document.querySelector('textarea[aria-label^="咨询决定 "]').focus()`);await a.webContents.insertText('刷新后保留的决定草稿');
  await a.reload();await until(a,`Boolean(document.querySelector('textarea[aria-label^="咨询决定 "]'))`);await open(a);
  assert.equal(await run(a,`document.querySelector('textarea[aria-label^="咨询决定 "]').value`),'刷新后保留的决定草稿');
  await run(a,`document.querySelector('.consultation-creator').open=false;document.querySelector('.consultations-body').scrollTop=0`);
  await fs.mkdir(path.resolve(__dirname,'../artifacts'),{recursive:true});
  await fs.writeFile(path.resolve(__dirname,'../artifacts/consultations-real-light.png'),(await a.webContents.capturePage()).toPNG());
  await run(a,`[...document.querySelectorAll('[data-consultation-assignment]')].find(el=>el.textContent.includes('Advisor B')).querySelector('[data-adopt-consultation]').click()`);
  await until(b,`document.querySelector('[data-consultation-id]').dataset.consultationState==='resolved'`);
  assert.ok(await run(b,`document.querySelector('[data-consultation-id]').textContent.includes('Pi B recommendation')`));
  assert.equal(requests.length,2);
  await run(b,`document.querySelector('[data-consultation-assignment] details').open=true;document.querySelector('[data-consultation-assignment] details button').click()`);
  await until(b,`document.querySelector('.consultation-context')?.textContent.includes('SOUL_A')`);
  const snapshot=JSON.parse(await run(b,`document.querySelector('.consultation-context').textContent`));
  assert.ok(requests.find(r=>r.model==='advice-a').texts.includes(snapshot.prompt));
  a.destroy();windows=[b];
  await create(b,'由真人自行决定',['Advisor A']);await until(b,`document.querySelectorAll('[data-assignment-status=answered]').length===3`);
  await run(b,`document.querySelector('textarea[aria-label^="咨询决定 "]').focus()`);await b.webContents.insertText('采用我自己的方案');await run(b,`document.querySelector('[data-decide-consultation]').click()`);
  await until(b,`document.querySelectorAll('[data-consultation-state=resolved]').length===2`);
  await create(b,'慢咨询',['Advisor A']);await until(b,`Boolean(document.querySelector('[data-assignment-status=running]'))`);
  await run(b,`document.querySelector('[data-cancel-consultation]').click()`);await until(b,`Boolean(document.querySelector('[data-assignment-status=cancelled]'))`);
  await create(b,'等待重启',['Advisor A']);await until(b,`Boolean(document.querySelector('[data-assignment-status=running]'))`);
  await create(b,'恢复后回答',['Advisor A']);await until(b,`Boolean(document.querySelector('[data-assignment-status=queued]'))`);
  const origin=host.origin;await host.close();host=await start(Number(new URL(origin).port));
  await b.reload();await until(b,`Boolean(document.querySelector('[data-assignment-status=paused]'))`);await open(b);
  await until(b,`Boolean(document.querySelector('[data-assignment-status=unknown]'))`);
  assert.ok(await run(b,`document.querySelector('[data-abandon-consultation]').disabled`));
  await run(b,`document.querySelector('[data-inspect-consultation]').click()`);
  await until(b,`Boolean(document.querySelector('[data-abandon-consultation]:enabled'))`);
  await run(b,`document.querySelector('[data-abandon-consultation]').click()`);await until(b,`Boolean(document.querySelector('[data-assignment-status=abandoned]'))`);
  await run(b,`document.querySelector('[data-resume-consultation]').click()`);await until(b,`document.querySelectorAll('[data-assignment-status=answered]').length===4`);
  assert.equal(requests.length,6);
  await run(b,`document.documentElement.dataset.theme='dark';document.querySelector('.consultation-creator').open=false;document.querySelector('.consultations-body').scrollTop=0`);
  b.setContentSize(420,860);await delay(150);await run(b,`document.querySelector('[aria-label=切换侧栏]').click()`);await delay(150);
  assert.ok(await run(b,`document.documentElement.scrollWidth<=innerWidth`));
  await fs.writeFile(path.resolve(__dirname,'../artifacts/consultations-real-dark-narrow.png'),(await b.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  console.log('Passed: production trusted config; two installed Pi Agents with distinct models, credentials, Souls/memories; real desktop/Web identity, lost receipt, draft reload, explicit adoption/answer, cancel, restart/inspect/abandon/resume, exact context snapshot, dark narrow UI. Six loopback model calls; zero paid calls.');
  windows.forEach(w=>w.destroy());windows=[];await host.close();host=null;await new Promise(r=>provider.close(r));provider=null;app.quit();
}).catch(async error=>{console.error(error);windows.forEach(w=>w.destroy());await host?.close();provider?.closeAllConnections();provider?.close();app.exit(1);});
