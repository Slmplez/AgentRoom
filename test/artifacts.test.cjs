const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const report={root:'r',elements:{r:{type:'Section',props:{title:'Report',description:'Actual task report'},children:['t']},t:{type:'Table',props:{columns:['Result'],rows:[['verified']]},children:[]}}};
const command=()=>({key:'publish',expectedVersion:0,title:'Task report',catalogVersion:1,spec:structuredClone(report)});
async function setup(t,options={}) {
  const directory=options.directory||await fs.mkdtemp(path.join(os.tmpdir(),'ar-artifacts-'));
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');
  let publish,finish;
  const runtime=await createApplicationRuntime({directory,execution:{agentId:'report-agent',artifacts:options.artifacts??true,createEngine:async context=>{
    publish=context.publishArtifact;return {onQuestion(){},async start(){},prompt(){return new Promise(resolve=>{finish=()=>resolve({text:'done',outcome:'complete'});});},isStopped:()=>true,async close(){finish?.();}};
  }},...options});
  t.after(()=>runtime.close());
  const actor=runtime.owner,boot=runtime.query({type:'bootstrap'},actor),workspaceId=boot.workspace.id;
  const roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Reports'},actor).roomId;
  const {taskId}=runtime.execute({type:'createLocalTask',workspaceId,roomId,key:'task',ownerAgentId:'report-agent',goal:'report'},actor);
  for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,5));assert.ok(finish);
  return {directory,runtime,actor,roomId,workspaceId,taskId,publish,finish,get currentPublish(){return publish;},query:(type,fields={})=>runtime.query({type,roomId,...fields},actor)};
}
test('report schema rejects cycles, shared nodes, actions, mismatched rows and oversized text',async()=>{
  const {reportSchema}=await import('../contracts/artifacts.mjs');
  assert.equal(reportSchema.safeParse(report).success,true);
  for(const change of [s=>s.elements.r.children.push('r'),s=>s.elements.r.children.push('t'),s=>s.elements.t.action='exec',s=>s.elements.t.props.rows[0].push('extra'),s=>s.elements.r.props.title='x'.repeat(201),s=>s.elements.t.type='Field']) {const spec=structuredClone(report);change(spec);assert.equal(reportSchema.safeParse(spec).success,false);}
  const {parseReportJson}=await import('../lib/report-json.mjs');
  assert.throws(()=>parseReportJson('{"a":1,"a":2}'));assert.throws(()=>parseReportJson('{"__proto__":{}}'));assert.deepEqual(parseReportJson(JSON.stringify(report)),report);
});
test('live Agent publication is atomic, versioned, scoped and queryable through authenticated HTTP',async t=>{
  const s=await setup(t),first=s.publish(command());
  assert.deepEqual(s.publish(command()),first);
  assert.throws(()=>s.publish({...command(),title:'changed'}),{code:'idempotency_conflict'});
  const next=s.publish({...command(),key:'second',artifactId:first.artifactId,expectedVersion:1,title:'Second'});
  assert.equal(next.artifactVersion,2);
  assert.throws(()=>s.publish({...command(),key:'competing',artifactId:first.artifactId,expectedVersion:1}),{code:'conflict'});
  const rows=s.query('snapshot').messages;assert.equal(rows.length,2);assert.equal(rows[0].authorKind,'agent');assert.equal(rows[0].role,'assistant');assert.equal(rows[0].artifactRefs[0].version,1);assert.equal(rows[1].artifactRefs[0].version,2);
  assert.doesNotMatch(JSON.stringify(s.query('events')),/Actual task report/);
  const q={artifactId:first.artifactId,version:1};assert.equal(s.query('artifact',q).title,'Task report');
  const {artifactVersionSchema,artifactVersionsSchema}=await import('../contracts/artifacts.mjs');
  assert.equal(artifactVersionSchema.safeParse(s.query('artifact',q)).success,true);
  assert.equal(artifactVersionsSchema.safeParse(s.query('artifactVersions',{artifactId:first.artifactId})).success,true);
  assert.deepEqual(s.query('artifactVersions',{artifactId:first.artifactId,limit:1}).versions.map(v=>v.version),[2]);
  assert.deepEqual(s.query('artifactVersions',{artifactId:first.artifactId,beforeVersion:2,limit:1}).versions.map(v=>v.version),[1]);
  const {startPersistenceHttp}=await import('../lib/application-http/index.mjs');const http=await startPersistenceHttp({runtime:s.runtime});t.after(()=>http.close());
  const url=`${http.origin}/api/v1/rooms/${s.roomId}/artifacts/${first.artifactId}/versions/1`;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{authorization:`Bearer ${http.token}`}});assert.equal(response.status,200);assert.deepEqual((await response.json()).spec,report);
  const other=s.runtime.execute({type:'createRoom',workspaceId:s.workspaceId,key:'other',title:'Other'},s.actor).roomId;
  assert.throws(()=>s.runtime.query({type:'artifact',roomId:other,...q},s.actor),{code:'not_found'});
  assert.throws(()=>s.runtime.query({type:'artifact',roomId:s.roomId,...q},{principalId:'report-agent'}),{code:'forbidden'});
  assert.throws(()=>s.runtime.execute({...command(),type:'publishArtifact',workspaceId:s.workspaceId,roomId:s.roomId},s.actor),{code:'unsupported'});
  s.finish();await new Promise(r=>setImmediate(r));assert.throws(()=>s.publish({...command(),key:'late'}),{code:'expired'});
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(s.directory,'application.sqlite'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);db.prepare('UPDATE artifact_versions SET content_json=? WHERE artifact_id=? AND version=1').run('{}',first.artifactId);db.close();
  assert.throws(()=>s.query('artifact',q),{code:'artifact_unavailable'});
  const changed=new DatabaseSync(path.join(s.directory,'application.sqlite'));changed.prepare('UPDATE artifact_versions SET catalog_version=2 WHERE artifact_id=? AND version=1').run(first.artifactId);changed.close();
  assert.throws(()=>s.query('artifact',q),{code:'unsupported_catalog'});
});
for(const point of ['after_entity','after_event','after_receipt','after_commit']) test(`publication fault at ${point} leaves no partial report or duplicated message`,async t=>{
  let enabled=false;
  const s=await setup(t,{fault:p=>{if(enabled&&p===point)throw Error('injected');}});enabled=true;
  assert.throws(()=>s.publish(command()),{code:'storage_error'});enabled=false;
  assert.equal(s.query('snapshot').messages.length,point==='after_commit'?1:0);
  const receipt=s.publish(command());assert.equal(s.query('snapshot').messages.length,1);
  s.runtime.close();
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');const reloaded=await createApplicationRuntime({directory:s.directory});t.after(()=>reloaded.close());
  assert.equal(reloaded.query({type:'artifact',roomId:s.roomId,artifactId:receipt.artifactId,version:1},reloaded.owner).title,'Task report');
  assert.equal(reloaded.query({type:'localTask',roomId:s.roomId,taskId:s.taskId},reloaded.owner).phase,'unknown');
});
test('publishing capability is absent from default read-only execution',async t=>{
  const s=await setup(t,{artifacts:false});assert.equal(s.publish,undefined);s.finish();
  const boot=s.runtime.query({type:'bootstrap'},s.actor);assert.equal(boot.capabilities.artifactPublishing,false);assert.equal(boot.capabilities.readOnlyArtifacts,true);
});

test('a later task cannot update an earlier task report and the old callback expires',async t=>{
  const s=await setup(t),receipt=s.publish(command());s.finish();await new Promise(r=>setImmediate(r));
  s.runtime.execute({type:'createLocalTask',workspaceId:s.workspaceId,roomId:s.roomId,key:'next-task',ownerAgentId:'report-agent',goal:'New report'},s.actor);
  for(let i=0;i<100&&s.currentPublish===s.publish;i++)await new Promise(r=>setTimeout(r,5));
  assert.notEqual(s.currentPublish,s.publish);
  assert.throws(()=>s.currentPublish({...command(),artifactId:receipt.artifactId,expectedVersion:1}),{code:'not_found'});
  assert.throws(()=>s.publish({...command(),key:'late-old-run'}),{code:'expired'});
  assert.deepEqual(s.publish(command()),receipt,'Committed retries may only read their original receipt');
  assert.equal(s.query('snapshot').messages.length,1);
});

test('expired events and paged history retain exact immutable report references',async t=>{
  let now=Date.now();const s=await setup(t,{clock:()=>now,maintenanceIntervalMs:10});
  const first=s.publish(command()),second=s.publish({...command(),key:'v2',artifactId:first.artifactId,expectedVersion:1,title:'V2'});
  const page=s.query('messages',{limit:1});assert.equal(page.messages[0].artifactRefs[0].version,2);
  const older=s.query('messages',{limit:1,beforeSequence:page.beforeSequence,upperBound:page.roomSequenceUpperBound});
  assert.equal(older.messages[0].artifactRefs[0].version,1);
  now+=8*24*60*60*1000;await new Promise(r=>setTimeout(r,40));
  assert.throws(()=>s.query('events',{after:first.cursor}),{code:'resync_required'});
  assert.deepEqual(s.query('snapshot').messages.map(m=>m.artifactRefs[0].version),[1,2]);
  assert.equal(s.query('artifact',{artifactId:second.artifactId,version:1}).title,'Task report');
});

for (const point of ['after_receipt','after_commit']) test(`process kill at ${point} preserves a complete publication or none, without replay`, async t => {
  const {fork}=require('node:child_process'), {once}=require('node:events');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-artifact-kill-'));
  const child=fork(path.join(__dirname,'fixtures/artifact-process.cjs'),[directory],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.resume();
  const kill=async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}};
  t.after(kill);
  const wait=type=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error(`Timed out: ${type}`)),8000);
    const message=m=>{if(m.type===type)finish(null,m);},exit=()=>finish(Error('Unexpected exit'));
    function finish(e,m){clearTimeout(timer);child.off('message',message);child.off('exit',exit);e?reject(e):resolve(m);}
    child.on('message',message);child.on('exit',exit);
  });
  const ids=await wait('ready'),fault=wait('fault');child.send({point,command:command()});await fault;await kill();
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');let starts=0;
  const runtime=await createApplicationRuntime({directory,execution:{agentId:'crash-agent',artifacts:true,createEngine(){starts++;throw Error('Must not replay');}}});t.after(()=>runtime.close());
  const q=(type,extra={})=>runtime.query({type,roomId:ids.roomId,...extra},runtime.owner);
  assert.equal(q('localTask',{taskId:ids.taskId}).phase,'unknown');
  const committed=point==='after_commit',messages=q('snapshot').messages;
  assert.equal(messages.length,committed?1:0);
  const lookup=()=>runtime.query({type:'receipt',workspaceId:ids.workspaceId,commandType:'publishArtifact',key:`${ids.runId}:publish`},runtime.owner);
  if(committed){const receipt=lookup();assert.equal(messages[0].artifactRefs[0].artifactId,receipt.artifactId);assert.deepEqual(q('artifact',{artifactId:receipt.artifactId,version:1}).spec,report);}
  else assert.throws(lookup,{code:'not_found'});
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'application.sqlite'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_versions').get().n,committed?1:0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE type='message.created'").get().n,committed?1:0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);db.close();
  await new Promise(r=>setTimeout(r,30));assert.equal(starts,0);assert.equal(await fs.readFile(path.join(directory,'starts.log'),'utf8'),'start\n');
});

test('report size/depth boundaries and forged publication identity fail before writing',async t=>{
  const s=await setup(t),{reportSchema}=await import('../contracts/artifacts.mjs');
  const tree={root:'0',elements:{}};
  for(let i=0;i<8;i++)tree.elements[i]={type:'Section',props:{title:'',description:''},children:i<7?[String(i+1)]:[]};
  assert.equal(reportSchema.safeParse(tree).success,true);
  tree.elements['7'].children=['8'];tree.elements['8']={type:'Section',props:{title:'',description:''},children:[]};
  assert.equal(reportSchema.safeParse(tree).success,false);
  const huge={root:'t',elements:{t:{type:'Table',props:{columns:['a'],rows:Array.from({length:200},()=>['中'.repeat(2000)])},children:[]}}};
  assert.equal(reportSchema.safeParse(huge).success,false);
  for(const field of ['taskId','runId','roomId','ownerAgentId','incarnation','path','command'])assert.throws(()=>s.publish({...command(),[field]:'forged'}),{code:'invalid_request'});
  assert.throws(()=>s.publish({...command(),artifactId:'invented'}),{code:'not_found'});
  assert.equal(s.query('snapshot').messages.length,0);
});

test('authentic v2 schema migration preserves reply chains, receipts, cursors and tasks',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-artifact-migrate-'));
  const {DatabaseSync}=await import('node:sqlite');let db=new DatabaseSync(path.join(directory,'application.sqlite'));
  db.exec(await fs.readFile(path.join(__dirname,'fixtures/persistence-v2.sql'),'utf8'));
  db.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO principals VALUES('owner','human','Owner');
    INSERT INTO workspaces VALUES('workspace','Workspace');
    INSERT INTO database_meta VALUES(1,'database','owner','workspace',1,0);
    INSERT INTO rooms VALUES('room','workspace','Room',2,3);
    INSERT INTO room_members VALUES('room','owner','owner');
    INSERT INTO messages VALUES('first','room',1,'owner','human','Owner','Original',NULL,1,'2026-10-31');
    INSERT INTO messages VALUES('reply','room',2,'owner','human','Owner','Reply','first',1,'2026-10-31');
  `);
  const receipt={schemaVersion:1,accepted:true,operationId:'operation',roomId:'room',messageId:'first',sequence:1,cursor:Buffer.from(JSON.stringify([1,'database','room',1])).toString('base64url')};
  db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('operation','owner','workspace','sendDiscussion','old-key','hash',1,JSON.stringify(receipt),'room','first',new Date().toISOString());
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1,'event',1,'message.created','workspace','room','first',1,'operation',new Date().toISOString(),'{}');
  const task={id:'task',runId:'run',initiatorId:'owner',roomId:'room',ownerAgentId:'local-pi',goal:'Original task',revision:3,phase:'reviewing',result:'Already delivered',delivery:'none',question:null,history:[],nativeId:null,incarnation:'old-incarnation'};
  db.prepare('INSERT INTO local_tasks VALUES(?,?,?)').run('task','room',JSON.stringify(task));db.close();
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');const runtime=await createApplicationRuntime({directory});t.after(()=>runtime.close());
  const snapshot=runtime.query({type:'snapshot',roomId:'room'},runtime.owner);
  assert.equal(snapshot.localTasks[0].runId,task.runId);
  assert.equal(snapshot.localTasks[0].result,task.result);
  assert.deepEqual(snapshot.messages.map(m=>[m.id,m.replyToId,m.artifactRefs]),[['first',null,[]],['reply','first',[]]]);
  assert.deepEqual(runtime.query({type:'receipt',workspaceId:'workspace',commandType:'sendDiscussion',key:'old-key'},runtime.owner),receipt);
  assert.equal(runtime.query({type:'events',roomId:'room',after:receipt.cursor},runtime.owner).events.length,0);
  db=new DatabaseSync(path.join(directory,'application.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,9);assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
  assert.deepEqual(JSON.parse(db.prepare('SELECT state_json FROM local_tasks').get().state_json),task);db.close();
});
