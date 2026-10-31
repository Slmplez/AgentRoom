const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const scope = { kind: 'agent', agentId: 'iris' };
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k), key: i => [...map.keys()][i] ?? null, get length() { return map.size; } }; };
async function until(fn) { for (let i=0;i<300;i++) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,10)); } throw Error('Timed out'); }
async function setup(t, options={}) {
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');
  const {startPersistenceHttp}=await import('../lib/application-http/index.mjs');
  const {createPersistentTransport}=await import('../renderer/client/persistent.mjs');
  const {createAgentRoomClient}=await import('../renderer/client/client.mjs');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-curator-runtime-'));
  const clients=[]; let runtime,http,starts=0,now=1800000000000,drop='',posts=0;
  const engine={agentId:'curator',model:'fixture',inspectStopped:async()=>true,createEngine(){ starts++; return {async start(){},async close(){},isStopped:()=>!options.unknown, async prompt(prompt){
    if(options.unknown) return {outcome:'unknown'};
    const {inputs}=JSON.parse(prompt.split('\n').at(-1));
    return {outcome:'complete',text:JSON.stringify({summaries:[{inputs:inputs.map(i=>i.key),text:'Consolidated evidence',reason:'Combined source records'}],archives:[]})};
  }};}};
  async function start() { runtime=await createApplicationRuntime({directory,knownAgents:['iris','ember'],memoryCurator:options.unconfigured?null:engine,maintenanceIntervalMs:20,clock:()=>now, execution:options.execution, fault:options.fault}); http=await startPersistenceHttp({runtime}); }
  await start(); const workspaceId=runtime.query({type:'bootstrap'},runtime.owner).workspace.id;
  const roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Room'},runtime.owner).roomId;
  async function make(store=storage()) {
    const transport=createPersistentTransport({backendId:'curator-test',localUserId:'owner',storage:store,session:async()=>({origin:http.origin,token:http.token}),fetch:async(url,init)=>{
      if(url.endsWith('/memory-curation/commands')) {posts++;if(drop==='before'){drop='';throw Error('lost before');}}
      const res=await fetch(url,init);
      if(url.endsWith('/memory-curation/commands') && drop==='after'){drop='';throw Error('lost reply');}return res;
    }});
    const client=createAgentRoomClient(transport);clients.push(client);await client.open({roomId});return client;
  }
  t.after(async()=>{clients.forEach(c=>c.close());await http.close();runtime.close();});
  return {directory,workspaceId,roomId,make,starts:()=>starts,posts:()=>posts,drop:value=>{drop=value;},advance:()=>{now+=600001;},
    status:c=>c.query({type:'memoryCurationStatus',workspaceId,scope}),
    save:(c,text='Source record',target=scope)=>c.dispatch({type:'saveExplicitMemory',workspaceId,scope:target,key:crypto.randomUUID(),text,source:{kind:'owner-note'}}),
    config:(enabled,expectedRevision,key=crypto.randomUUID())=>({type:'configureMemoryCuration',workspaceId,scope,enabled,expectedRevision,key}),
    restart:async()=>{clients.forEach(c=>c.close());await http.close();runtime.close();await start();},
    raw:()=>({runtime,http}),
  };
}

test('production scheduler automatically curates; authenticated settings preserve scopes, sources and frozen task context',async t=>{
  let dispatched;
  const s=await setup(t,{execution:{agentId:'iris',createEngine:()=>({async start(){},async close(){},onQuestion(){},async prompt(prompt){dispatched=prompt;return {outcome:'complete',text:'done'};}})}}),c=await s.make();
  assert.equal(c.read().capabilities.memoryCuration,true);assert.equal((await s.status(c)).configured,true);assert.deepEqual((await s.status(c)).executor,{agentId:'curator',model:'fixture'});
  await new Promise(r=>setTimeout(r,60));assert.equal(s.starts(),0);
  await c.dispatch({type:'editAgentSoul',workspaceId:s.workspaceId,agentId:'iris',key:'soul',expectedRevision:0,personality:'Distinct personality',expression:'',workStyle:''});
  const note=await s.save(c);await until(async()=> (await s.status(c)).latestRun?.status==='applied');assert.equal(s.starts(),1);
  const state=await s.status(c);assert.equal(state.summaries[0].refs[0].id,note.entityId);
  assert.deepEqual((await c.query({type:'memoryCurationStatus',workspaceId:s.workspaceId,scope:{kind:'agent',agentId:'ember'}})).summaries,[]);
  const history=await c.query({type:'memoryCurationHistory',workspaceId:s.workspaceId,scope,limit:1});assert.equal(history.runs[0].input.executor.agentId,'curator');
  const task=await c.dispatch({type:'createLocalTask',roomId:s.roomId,workspaceId:s.workspaceId,ownerAgentId:'iris',goal:'Use memory',key:'task'});
  await until(()=>dispatched);assert.match(dispatched,/Consolidated evidence/);assert.match(dispatched,/Distinct personality/);
  const frozen=await c.query({type:'taskContextSnapshot',roomId:s.roomId,taskId:task.taskId});assert.equal(frozen.snapshot.formatVersion,2);assert.equal(frozen.snapshot.memoryContexts[0].items[0].kind,'summary');
  await c.dispatch({type:'correctExplicitMemory',workspaceId:s.workspaceId,scope,key:'correct',memoryId:note.entityId,expectedRevision:1,text:'Corrected source'});
  assert.equal((await s.status(c)).summaries.length,0);assert.deepEqual(await c.query({type:'taskContextSnapshot',roomId:s.roomId,taskId:task.taskId}),frozen);
  const paused=await c.dispatch(s.config(false,state.revision));s.advance();await new Promise(r=>setTimeout(r,60));assert.equal(s.starts(),1);
  await assert.rejects(c.dispatch(s.config(true,state.revision)),{code:'conflict'});
  await c.dispatch(s.config(true,paused.revision));await until(()=>s.starts()===2);
  const {http}=s.raw();const unauth=await fetch(http.origin+'/api/v1/memory-curation/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'memoryCurationStatus',workspaceId:s.workspaceId,scope})});assert.equal(unauth.status,401);
  await assert.rejects(c.query({type:'memoryCurationStatus',workspaceId:s.workspaceId,scope:{kind:'agent',agentId:'unregistered'}}),{code:'invalid_scope'});
});

test('lost configuration response reopens by original receipt; missing request retries only saved payload',async t=>{
  const s=await setup(t),store=storage(),a=await s.make(store);const first=s.config(false,0,'pause');
  s.drop('after');await assert.rejects(a.dispatch(first),{outcome:'unknown'});assert.equal(a.pendingMemoryOperations({workspaceId:s.workspaceId,scope}).length,1);
  a.close();const b=await s.make(store);assert.equal(s.posts(),1);assert.deepEqual(b.pendingMemoryOperations({workspaceId:s.workspaceId,scope}),[]);assert.equal((await s.status(b)).enabled,false);
  const resume=s.config(true,1,'resume');s.drop('before');await assert.rejects(b.dispatch(resume),{outcome:'unknown'});b.close();const c=await s.make(store);assert.equal(s.posts(),2);
  await assert.rejects(c.dispatch({...resume,enabled:false}),{code:'idempotency_conflict'});await c.retryOperation('resume');assert.equal(s.posts(),3);assert.equal((await s.status(c)).revision,2);
  const historical=await c.dispatch(first);assert.equal(historical.revision,1);assert.equal((await s.status(c)).enabled,true);
});

test('unknown background run survives restart without replay; inspection receipt releases only a confirmed stopped lease',async t=>{
  const s=await setup(t,{unknown:true}),a=await s.make();await s.save(a);await until(async()=> (await s.status(a)).latestRun?.status==='unknown');
  const state=await s.status(a);assert.equal(state.latestRun.leaseHeld,1);await s.restart();const b=await s.make();s.advance();await new Promise(r=>setTimeout(r,60));assert.equal(s.starts(),1);
  await assert.rejects(b.dispatch(s.config(true,state.revision)),{code:'busy'});
  const inspect={type:'inspectMemoryCuration',workspaceId:s.workspaceId,scope,runId:state.latestRun.id,key:'inspect'};
  s.drop('after');await assert.rejects(b.dispatch(inspect),{outcome:'unknown'});assert.equal((await s.status(b)).latestRun.leaseHeld,0);
  const receipt=await b.checkOperation('inspect','inspectMemoryCuration');assert.equal(receipt.runId,inspect.runId);assert.equal(s.starts(),1);
  await s.restart();const c=await s.make();assert.equal((await s.status(c)).latestRun.status,'unknown');assert.equal(s.starts(),1);
});

test('unconfigured runtime reports honest status and never starts an engine',async t=>{
  const s=await setup(t,{unconfigured:true}),c=await s.make();await s.save(c);const status=await s.status(c);assert.equal(status.configured,false);assert.equal(status.enabled,false);assert.equal(status.pending,1);
  await assert.rejects(c.dispatch(s.config(true,0)),{code:'unconfigured'});assert.equal(s.starts(),0);
});
