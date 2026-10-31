const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const spec={groups:[{id:'details',title:'Details',fields:[{id:'name',type:'text',label:'Name',required:true},{id:'note',type:'textarea',label:'Note'},{id:'count',type:'number',label:'Count',integer:true,min:1,max:10},{id:'choice',type:'select',label:'Choice',options:[{id:'a',label:'A'},{id:'b',label:'B'}]},{id:'many',type:'multiselect',label:'Many',options:[{id:'a',label:'A'},{id:'b',label:'B'}],maxSelections:1},{id:'agreed',type:'checkbox',label:'Agree',required:true},{id:'date',type:'date',label:'Date',min:'2026-01-01',max:'2026-12-31'},{id:'files',type:'attachments',label:'Files'}]}]};
const values={name:'  保留原文  ',note:'中文说明',count:2,choice:'a',many:['b'],agreed:true,date:'2026-10-31'};
const pause=()=>new Promise(r=>setTimeout(r,5));
async function setup(t,options={}){
  const directory=options.directory||await fs.mkdtemp(path.join(os.tmpdir(),'ar-forms-')),{createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');let engineOptions,finish,question;
  const runtime=await createApplicationRuntime({directory,execution:{agentId:'forms-agent',artifacts:true,forms:true,createEngine:async context=>{engineOptions=context;return {onQuestion(fn){question=fn;},async start(){},prompt(){return new Promise(resolve=>{finish=()=>resolve({text:'done',outcome:'complete'});});},isStopped:()=>true,async close(){finish?.();}};}},...options});t.after(()=>runtime.close());
  const actor=runtime.owner,workspaceId=runtime.query({type:'bootstrap'},actor).workspace.id,roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Forms'},actor).roomId,taskId=runtime.execute({type:'createLocalTask',workspaceId,roomId,key:'task',ownerAgentId:'forms-agent',goal:'Ask a form'},actor).taskId;
  for(let i=0;i<200&&!finish;i++)await pause();assert.ok(finish);
  let delivered;
  const request=(input={})=>{const promise=engineOptions.requestForm({key:'form',expectedVersion:0,title:'请补充信息',spec:structuredClone(spec),...input});promise.then(payload=>{if(!payload.publicationOnly)delivered=payload;},()=>{});return promise;};
  const reference=()=>runtime.query({type:'snapshot',roomId},actor).messages.find(m=>m.artifactRefs.length).artifactRefs[0];
  const query=()=>runtime.query({type:'formState',roomId,artifactId:reference().artifactId,version:reference().version},actor);
  const command=(type,input={})=>runtime.execute({type,key:type,workspaceId,roomId,artifactId:reference().artifactId,version:reference().version,...input},actor);
  return {runtime,actor,directory,workspaceId,roomId,taskId,request,query,command,reference,finish,get options(){return engineOptions;},get delivered(){return delivered;},native:q=>question(q)};
}
test('form grammar validates bounded fixed fields/defaults and rejects executable or invalid structures',async()=>{
  const {formSchema,validateFormValues}=await import('../contracts/forms.mjs'),parsed=formSchema.parse(spec);assert.equal(validateFormValues(parsed,values).ok,true);
  for(const changed of [{...values,extra:'x'},{...values,name:'   '},{...values,count:'2'},{...values,count:1.5},{...values,many:['a','a']},{...values,many:['a','b']},{...values,date:'2026-02-29'},{...values,date:'2026-2-01'},{...values,agreed:false},{...values,files:['../file']}])assert.equal(validateFormValues(parsed,changed).ok,false);
  for(const mutate of [s=>s.action='eval',s=>s.groups[0].fields[0].default=12,s=>s.groups[0].fields[1].id='name',s=>s.groups[0].fields[0].id='constructor',s=>s.groups[0].fields[2].min=20,s=>s.groups[0].fields[3].options.push({id:'a',label:'duplicate'}),s=>s.groups[0].fields[0].pattern='.*',s=>s.groups[0].fields[0].type='script']){const changed=structuredClone(spec);mutate(changed);assert.equal(formSchema.safeParse(changed).success,false);}
  const large={groups:[{id:'g',title:'G',fields:Array.from({length:20},(_,i)=>({id:'field'+i,type:'textarea',label:'Text'}))}]};
  assert.equal(validateFormValues(formSchema.parse(large),Object.fromEntries(large.groups[0].fields.map(f=>[f.id,'中'.repeat(4000)]))).ok,false);
  large.groups[0].fields.forEach(f=>{f.description='中'.repeat(2000);});assert.equal(formSchema.safeParse(large).success,false);
});
test('form publication and saving do not resume; explicit continuation delivers one frozen revision to the original live tool',async t=>{
  const s=await setup(t),pending=s.request();const ref=s.reference();assert.equal(ref.kind,'form');assert.equal(s.query().canSubmit,true);assert.equal(s.delivered,undefined);
  const duplicate=await s.request();assert.equal(duplicate.publicationOnly,true);assert.equal(duplicate.receipt.artifactId,ref.artifactId);assert.equal(s.query().status,'waiting');
  assert.throws(()=>s.request({key:'parallel'}),{code:'expired'});
  const bytes=Buffer.from('evidence'),attachment=s.runtime.uploadAttachment({type:'uploadAttachment',workspaceId:s.workspaceId,roomId:s.roomId,key:'upload',name:'proof.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},bytes,s.actor).attachment;
  const otherRoom=s.runtime.execute({type:'createRoom',workspaceId:s.workspaceId,key:'other-room',title:'Other'},s.actor).roomId;
  const foreign=s.runtime.uploadAttachment({type:'uploadAttachment',workspaceId:s.workspaceId,roomId:otherRoom,key:'other-upload',name:'other.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},bytes,s.actor).attachment;
  assert.throws(()=>s.command('submitForm',{key:'cross-room',expectedResponseRevision:0,values:{...values,files:[foreign.id]}}),{code:'not_found'});assert.equal(s.query().responseRevision,0);
  const submitted={...values,files:[attachment.id]};const saved=s.command('submitForm',{expectedResponseRevision:0,values:submitted});assert.equal(saved.form.responseRevision,1);assert.deepEqual(s.command('submitForm',{expectedResponseRevision:0,values:submitted}),saved);
  await pause();assert.equal(s.delivered,undefined);assert.equal(s.runtime.query({type:'localTask',roomId:s.roomId,taskId:s.taskId},s.actor).phase,'awaiting_input');
  assert.throws(()=>s.command('submitForm',{key:'conflicting',expectedResponseRevision:0,values}),{code:'conflict'});
  assert.throws(()=>s.command('submitForm',{expectedResponseRevision:0,values}),{code:'idempotency_conflict'});
  const corrected=s.command('submitForm',{key:'corrected',expectedResponseRevision:1,values:{...submitted,count:3}});assert.equal(corrected.form.responseRevision,2);
  const continuation={responseRevision:2,expectedWaitRevision:s.query().waitRevision};const receipt=s.command('continueForm',continuation);assert.deepEqual(s.command('continueForm',continuation),receipt);
  const delivery=await pending;assert.equal(delivery.result.values.count,3);assert.equal(delivery.result.values.name,values.name);assert.equal(delivery.result.attachments[0].id,attachment.id);assert.equal(s.query().status,'attempting');
  assert.throws(()=>s.native({id:'unexpected',title:'Cannot overlap form delivery',options:['yes']}),{code:'invalid_transition'});
  assert.equal(s.query().status,'attempting');assert.equal(s.runtime.query({type:'localTask',roomId:s.roomId,taskId:s.taskId},s.actor).formWait.artifactId,ref.artifactId);
  assert.throws(()=>s.command('continueForm',{...continuation,key:'duplicate-new-key'}),{code:'expired'});
  s.options.acknowledgeForm(delivery.acknowledgment);assert.equal(s.query().status,'submitted');assert.equal(s.runtime.query({type:'localTask',roomId:s.roomId,taskId:s.taskId},s.actor).phase,'running');
  const {persistenceEventSchema}=await import('../contracts/persistence.mjs');const events=s.runtime.query({type:'events',roomId:s.roomId},s.actor).events;events.forEach(event=>persistenceEventSchema.parse(event));assert.doesNotMatch(JSON.stringify(events),/acknowledgment|deliveryToken|incarnation/);
  const second=s.request({key:'v2',artifactId:ref.artifactId,expectedVersion:1});second.catch(()=>{});assert.equal(s.query().latestVersion,2);assert.throws(()=>s.command('submitForm',{key:'old',expectedResponseRevision:2,values}),{code:'conflict'});
  s.finish();await pause();assert.equal(s.runtime.query({type:'formState',roomId:s.roomId,artifactId:ref.artifactId,version:2},s.actor).status,'expired');
});
test('restart expires original waiting form, preserves saved response and refuses replay',async t=>{
  const s=await setup(t),pending=s.request();pending.catch(()=>{});s.command('submitForm',{expectedResponseRevision:0,values});const ref=s.reference();s.runtime.close();
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');let starts=0;const runtime=await createApplicationRuntime({directory:s.directory,execution:{agentId:'forms-agent',artifacts:true,forms:true,createEngine(){starts++;throw Error();}}});t.after(()=>runtime.close());
  const state=runtime.query({type:'formState',roomId:s.roomId,artifactId:ref.artifactId,version:1},runtime.owner);assert.equal(state.status,'expired');assert.deepEqual(state.response.values,values);assert.equal(state.canSubmit,false);assert.equal(starts,0);
  assert.throws(()=>runtime.execute({type:'continueForm',key:'continue',workspaceId:s.workspaceId,roomId:s.roomId,artifactId:ref.artifactId,version:1,responseRevision:1,expectedWaitRevision:state.waitRevision},runtime.owner),{code:'expired'});
});

test('native input cannot replace an unacknowledged form; restart marks that exact delivery unknown',async t=>{
  const s=await setup(t),waiting=s.request();s.command('submitForm',{expectedResponseRevision:0,values});
  s.command('continueForm',{responseRevision:1,expectedWaitRevision:s.query().waitRevision});const payload=await waiting,ref=s.reference();
  assert.throws(()=>s.native({id:'parallel-native',title:'Another question',options:[]}),{code:'invalid_transition'});
  s.runtime.close();
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');const runtime=await createApplicationRuntime({directory:s.directory});t.after(()=>runtime.close());
  const state=runtime.query({type:'formState',roomId:s.roomId,artifactId:ref.artifactId,version:1},runtime.owner);
  assert.equal(state.status,'unknown');assert.equal(state.responseRevision,1);assert.equal(state.canSubmit,false);
  assert.throws(()=>s.options.acknowledgeForm(payload.acknowledgment),{code:'expired'});
  assert.equal(runtime.query({type:'bootstrap'},runtime.owner).capabilities.forms,false);
});

test('schema 7 migration preserves linked attachment bytes, messages, cursors and original receipts',async t=>{
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs'),{DatabaseSync}=await import('node:sqlite');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-form-migration-'));let runtime=await createApplicationRuntime({directory});t.after(()=>runtime.close());
  const actor=runtime.owner,workspaceId=runtime.query({type:'bootstrap'},actor).workspace.id,roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Before forms'},actor).roomId;
  const bytes=Buffer.from('preserve attachment'),upload=runtime.uploadAttachment({type:'uploadAttachment',key:'upload',workspaceId,roomId,name:'preserved.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},bytes,actor);
  const sent=runtime.execute({type:'sendDiscussion',key:'send',workspaceId,roomId,text:'Keep this',attachmentIds:[upload.attachment.id]},actor),before=runtime.query({type:'snapshot',roomId},actor);runtime.close();
  let db=new DatabaseSync(path.join(directory,'application.sqlite'));db.exec('DROP TABLE form_responses; DROP TABLE form_waits; ALTER TABLE artifact_versions DROP COLUMN kind; PRAGMA user_version=7;');db.close();
  runtime=await createApplicationRuntime({directory});const after=runtime.query({type:'snapshot',roomId},actor);assert.deepEqual(after.messages,before.messages);assert.equal(after.cursor,before.cursor);
  assert.deepEqual(runtime.query({type:'operation',operationId:upload.operationId},actor),upload);assert.deepEqual(runtime.query({type:'operation',operationId:sent.operationId},actor),sent);
  assert.deepEqual(runtime.downloadAttachment({roomId,attachmentId:upload.attachment.id},actor).bytes,bytes);
  db=new DatabaseSync(path.join(directory,'application.sqlite'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);db.close();
});
