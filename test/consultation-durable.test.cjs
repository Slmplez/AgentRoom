const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {fork}=require('node:child_process');
function message(child,type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('No child message: '+type));},10000);const onMessage=m=>{if(m.type===type){clearTimeout(timer);child.off('message',onMessage);resolve(m);}};child.on('message',onMessage);});}
for(const point of ['after_receipt','after_commit','after_consultation_reservation','before_consultation_start','after_consultation_start','after_consultation_prompt'])test(`hard kill at ${point} preserves consultation intent and never replays a native start`,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-consult-kill-'));
  const child=fork(path.join(__dirname,'fixtures/consultation-process.cjs'),[directory],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let runtime;
  try{
    const boot=await message(child,'ready');
    const request=async(route,input,key)=>{const r=await fetch(boot.origin+'/api/v1'+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+boot.token,...(input?{'content-type':'application/json','idempotency-key':key}:{})},...(input?{body:JSON.stringify(input)}:{})});return r.json();};
    const identity=await request('/bootstrap');const room=await request('/rooms',{workspaceId:identity.workspace.id,title:'Kill boundary'},'room');
    const armed=message(child,'armed');child.send({type:'arm',point});await armed;
    const fault=message(child,'fault');const sending=request('/consultations/commands',{type:'createConsultation',workspaceId:identity.workspace.id,roomId:room.roomId,title:'Durable question',agentIds:['advisor-a']},'create').catch(()=>null);
    await fault;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;await sending;
    const started=async()=>{try{return(await fs.readFile(path.join(directory,'starts.log'),'utf8')).trim().split('\n').filter(Boolean).length;}catch{return 0;}};
    const before=await started();assert.equal(before,['after_consultation_start','after_consultation_prompt'].includes(point)?1:0);
    const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');
    let attempts=0;
    runtime=await createApplicationRuntime({directory,consultationAgents:[{id:'advisor-a',displayName:'A',engine:'pi',model:'fixture',createEngine(){attempts++;throw Error('Recovery must not run');},inspectStopped:async()=>true}]});
    const questions=runtime.query({type:'consultations',roomId:room.roomId},runtime.owner);
    if(point==='after_receipt')assert.equal(questions.length,0);
    else{assert.equal(questions.length,1);assert.equal(questions[0].assignments[0].status,['before_consultation_start','after_consultation_start','after_consultation_prompt'].includes(point)?'unknown':'paused');}
    await new Promise(r=>setTimeout(r,350));assert.equal(attempts,0);assert.equal(await started(),before);
  }finally{runtime?.close();if(child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await done;}}
});
