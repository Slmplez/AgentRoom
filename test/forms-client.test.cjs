const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const until=async read=>{for(let i=0;i<200;i++){if(await read())return;await new Promise(r=>setTimeout(r,10));}throw Error('State did not arrive');};
function storage(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),key:i=>[...data.keys()][i]??null,get length(){return data.size;}};}
test('public form Client scopes queries, preserves response revisions and recovers lost save/continue responses without repeated delivery',async t=>{
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs'),{startPersistenceHttp}=await import('../lib/application-http/index.mjs'),{createAgentRoomClient}=await import('../renderer/client/client.mjs'),{createPersistentTransport}=await import('../renderer/client/persistent.mjs');
  let engineOptions,finish,delivered=0;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-form-client-')),runtime=await createApplicationRuntime({directory,execution:{agentId:'local-pi',artifacts:true,forms:true,createEngine(options){engineOptions=options;return {onQuestion(){},async start(){},prompt:()=>new Promise(r=>{finish=()=>r({outcome:'complete',text:'done'});}),async close(){finish?.();},isStopped:()=>true};}}}),server=await startPersistenceHttp({runtime});
  const workspaceId=runtime.query({type:'bootstrap'},runtime.owner).workspace.id,roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Forms'},runtime.owner).roomId;
  const otherRoom=runtime.execute({type:'createRoom',workspaceId,key:'other-room',title:'Other'},runtime.owner).roomId,clients=[];t.after(async()=>{clients.forEach(c=>c.close());runtime.close();await server.close();});
  let lose=false,drop=false,writes=0,corrupt=false;
  async function make(journal=storage()){
    const client=createAgentRoomClient(createPersistentTransport({backendId:'forms',localUserId:'owner',storage:journal,session:async()=>({origin:server.origin,token:server.token}),fetch:async(url,options)=>{
      const command=url.endsWith('/forms/commands');if(command){writes++;if(drop)throw Error('offline');}
      const response=await fetch(url,options);if(command&&lose)throw Error('lost response');
      if(url.endsWith('/forms/query')&&corrupt){const body=await response.json();body.artifactId='wrong';return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});}return response;
    }}));clients.push(client);await client.open({roomId});return client;
  }
  const a=await make(),b=await make();assert.equal(a.read().capabilities.forms,true);
  await a.dispatch({type:'createLocalTask',key:'task',workspaceId,roomId,ownerAgentId:'local-pi',goal:'Form'});await until(()=>finish);
  const waiting=engineOptions.requestForm({key:'ask',expectedVersion:0,title:'Question',spec:{groups:[{id:'g',title:'Details',fields:[{id:'text',label:'Text',type:'text',required:true}]}]}});waiting.then(()=>delivered++,()=>{});
  await until(()=>a.read().messages.some(m=>m.artifactRefs.length));const artifactId=a.read().messages[0].artifactRefs[0].artifactId;
  const q={type:'formState',roomId,artifactId,version:1},save={type:'submitForm',key:'save',workspaceId,roomId,artifactId,version:1,expectedResponseRevision:0,values:{text:'first'}};
  await assert.rejects(a.query({...q,roomId:otherRoom}),{code:'invalid_scope'});
  const unauthorized=await fetch(server.origin+'/api/v1/forms/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q)});assert.equal(unauthorized.status,401);
  corrupt=true;await assert.rejects(a.query(q),{code:'invalid_response'});corrupt=false;
  lose=true;await assert.rejects(a.dispatch(save),{outcome:'unknown'});lose=false;assert.equal(writes,1);assert.equal(delivered,0);
  assert.equal((await a.checkOperation('save','submitForm')).form.responseRevision,1);assert.equal(writes,1);
  await assert.rejects(b.dispatch({...save,key:'other',values:{text:'stale'}}),{code:'conflict'});
  await a.dispatch({...save,key:'correction',expectedResponseRevision:1,values:{text:'corrected'}});
  const history=await b.query({type:'formResponses',roomId,artifactId,version:1,limit:1});assert.equal(history.responses[0].values.text,'corrected');assert.equal(history.beforeRevision,2);
  const earlier=await b.query({type:'formResponses',roomId,artifactId,version:1,limit:1,beforeRevision:history.beforeRevision});assert.equal(earlier.responses[0].values.text,'first');assert.equal(earlier.beforeRevision,null);
  const state=await a.query(q),resume={type:'continueForm',key:'resume',workspaceId,roomId,artifactId,version:1,responseRevision:2,expectedWaitRevision:state.waitRevision};
  drop=true;await assert.rejects(a.dispatch(resume),{outcome:'unknown'});drop=false;assert.equal(await a.checkOperation('resume','continueForm'),null);assert.equal(delivered,0);
  lose=true;await assert.rejects(a.retryOperation('resume'),{outcome:'unknown'});lose=false;const payload=await waiting;assert.equal(payload.result.values.text,'corrected');assert.equal(delivered,1);
  const count=writes;assert.equal((await a.checkOperation('resume','continueForm')).form.status,'pending');assert.equal(writes,count);assert.equal((await b.query(q)).status,'attempting');
  assert.throws(()=>engineOptions.acknowledgeForm('forged'),{code:'expired'});engineOptions.acknowledgeForm(payload.acknowledgment);assert.equal((await b.query(q)).status,'submitted');assert.equal(delivered,1);finish();
});
