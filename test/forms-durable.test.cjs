const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process'),{once}=require('node:events');
function message(child,type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(Error(`Missing ${type}`)),15000),receive=data=>{if(data.type===type)done(null,data);},exit=()=>done(Error('Child exited'));function done(error,value){clearTimeout(timer);child.off('message',receive);child.off('exit',exit);error?reject(error):resolve(value);}child.on('message',receive);child.once('exit',exit);});}
async function start(directory){const child=fork(path.join(__dirname,'fixtures/forms-process.cjs'),[directory],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true}),ready=await message(child,'ready');return {...ready,child,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;},async arm(operation,point){const response=message(child,'armed');child.send({type:'arm',operation,point});await response;}};}
for(const [operation,point] of [['publishForm','after_receipt'],['publishForm','after_commit'],['submitForm','after_receipt'],['submitForm','after_commit'],['continueForm','after_receipt'],['continueForm','after_commit'],['delivery','before_form_delivery'],['delivery','after_form_delivery'],['delivery','after_form_ack']])test(`form ${operation} process kill ${point} preserves atomic facts without replay`,async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-form-kill-'));let server=await start(directory);t.after(()=>server.stop());
  const call=async(route,body,key)=>{const res=await fetch(server.origin+'/api/v1'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+server.token,...(body?{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};};
  const workspaceId=(await call('/bootstrap')).data.workspace.id,roomId=(await call('/rooms',{workspaceId,title:'Forms'},'room')).data.roomId;
  if(operation==='publishForm')await server.arm(operation,point);
  const fault=message(server.child,'fault');
  const task=await call(`/rooms/${roomId}/local-tasks`,{workspaceId,ownerAgentId:'local-pi',goal:'Request form'},'task');
  let ref,state,request;
  if(operation!=='publishForm'){
    for(let i=0;i<200&&!ref;i++){ref=(await call(`/rooms/${roomId}/snapshot`)).data.messages[0]?.artifactRefs[0];if(!ref)await new Promise(r=>setTimeout(r,10));}assert.ok(ref);
    const query=()=>call('/forms/query',{type:'formState',roomId,artifactId:ref.artifactId,version:1});
    if(operation==='submitForm'){await server.arm(operation,point);request=call('/forms/commands',{type:'submitForm',workspaceId,roomId,artifactId:ref.artifactId,version:1,expectedResponseRevision:0,values:{answer:'saved'}},'save').catch(()=>null);}
    else {await call('/forms/commands',{type:'submitForm',workspaceId,roomId,artifactId:ref.artifactId,version:1,expectedResponseRevision:0,values:{answer:'saved'}},'save');state=(await query()).data;await server.arm(operation,point);request=call('/forms/commands',{type:'continueForm',workspaceId,roomId,artifactId:ref.artifactId,version:1,responseRevision:1,expectedWaitRevision:state.waitRevision},'continue').catch(()=>null);}
  }
  await fault;await server.stop();await request;server=await start(directory);
  const snapshot=(await call(`/rooms/${roomId}/snapshot`)).data;ref ||=snapshot.messages[0]?.artifactRefs[0];
  if(operation==='publishForm' && point==='after_receipt'){assert.equal(snapshot.messages.length,0);return;}
  assert.ok(ref);state=(await call('/forms/query',{type:'formState',roomId,artifactId:ref.artifactId,version:1})).data;
  assert.equal(state.canSubmit,false);assert.equal(state.status,point==='after_form_ack'?'submitted':operation==='delivery'||operation==='continueForm'&&point==='after_commit'?'unknown':'expired');
  const saved=operation==='submitForm'?point==='after_commit':operation!=='publishForm';assert.equal(state.responseRevision,saved?1:0);if(saved)assert.equal(state.response.values.answer,'saved');
  assert.equal(snapshot.localTasks.length,1);assert.equal(snapshot.localTasks[0].id,task.data.taskId);assert.equal(snapshot.localTasks[0].phase,'unknown');
  const again=await call('/forms/commands',{type:'continueForm',workspaceId,roomId,artifactId:ref.artifactId,version:1,responseRevision:1,expectedWaitRevision:state.waitRevision},'new-continue');assert.equal(again.status,409);
});
