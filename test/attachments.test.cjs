const {test}=require('node:test');
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path'), {createHash,randomUUID}=require('node:crypto');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function setup(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-attachments-'));
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');
  const runtime=await createApplicationRuntime({directory,...options});t.after(()=>runtime.close());
  const actor=runtime.owner, workspaceId=runtime.query({type:'bootstrap'},actor).workspace.id;
  const roomId=runtime.execute({type:'createRoom',workspaceId,key:'room',title:'Attachments'},actor).roomId;
  const command=(bytes,name='报告.txt',key=randomUUID())=>({type:'uploadAttachment',workspaceId,roomId,key,name,size:bytes.length,sha256:digest(bytes)});
  return {runtime,actor,workspaceId,roomId,directory,command,upload:(bytes,name,key)=>runtime.uploadAttachment(command(bytes,name,key),bytes,actor),query:(type,extra={})=>runtime.query({type,roomId,...extra},actor),send:(ids,key=randomUUID())=>runtime.execute({type:'sendDiscussion',workspaceId,roomId,key,text:'',attachmentIds:ids},actor)};
}
test('attachments persist actual bytes, immutable references and receipts across reload; scope, hashes and pending removal are enforced',async t=>{
  const s=await setup(t), bytes=Buffer.from('真实文件\nhello');
  const first=s.upload(bytes,'报告.txt','upload'); assert.deepEqual(s.upload(bytes,'报告.txt','upload'),first);
  assert.throws(()=>s.upload(Buffer.from('changed'),'报告.txt','upload'),{code:'idempotency_conflict'});
  assert.equal(s.query('pendingAttachments').attachments.length,1);
  { const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(s.directory,'application.sqlite'));db.prepare('INSERT INTO principals VALUES(?,?,?)').run('other-reader','human','Other');db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(s.roomId,'other-reader','reader');db.close(); }
  const otherActor={principalId:'other-reader'};
  assert.equal(s.runtime.query({type:'pendingAttachments',roomId:s.roomId},otherActor).attachments.length,0);
  assert.throws(()=>s.runtime.downloadAttachment({roomId:s.roomId,attachmentId:first.attachment.id},otherActor),{code:'not_found'});
  assert.equal(s.runtime.query({type:'events',roomId:s.roomId},otherActor).events.some(event=>event.type==='attachment.updated'),false);

  const sent=s.send([first.attachment.id],'send'); assert.deepEqual(s.send([first.attachment.id],'send'),sent);
  assert.equal(s.query('snapshot').messages[0].attachmentRefs[0].status,'linked');
  assert.equal(s.query('pendingAttachments').attachments.length,0);
  assert.throws(()=>s.runtime.execute({type:'removeAttachment',workspaceId:s.workspaceId,roomId:s.roomId,key:'remove',attachmentId:first.attachment.id},s.actor),{code:'conflict'});
  assert.deepEqual(s.runtime.downloadAttachment({roomId:s.roomId,attachmentId:first.attachment.id},s.actor).bytes,bytes);
  assert.throws(()=>s.send([first.attachment.id,first.attachment.id]),{code:'invalid_request'});
  const other=s.runtime.execute({type:'createRoom',workspaceId:s.workspaceId,key:'other',title:'Other'},s.actor).roomId;
  assert.throws(()=>s.runtime.downloadAttachment({roomId:other,attachmentId:first.attachment.id},s.actor),{code:'not_found'});
  assert.throws(()=>s.runtime.downloadAttachment({roomId:s.roomId,attachmentId:first.attachment.id},{principalId:'invalid'}),{code:'forbidden'});
  const staged=s.upload(Buffer.from('pending')), remove={type:'removeAttachment',workspaceId:s.workspaceId,roomId:s.roomId,key:'delete',attachmentId:staged.attachment.id};
  const removed=s.runtime.execute(remove,s.actor);assert.equal(removed.attachment.status,'deleted');assert.deepEqual(s.runtime.execute(remove,s.actor),removed);
  assert.throws(()=>s.runtime.downloadAttachment({roomId:s.roomId,attachmentId:staged.attachment.id},s.actor),{code:'not_found'});
  const events=s.query('events').events;const {persistenceEventSchema}=await import('../contracts/persistence.mjs');events.forEach(e=>persistenceEventSchema.parse(e));
  assert.doesNotMatch(JSON.stringify(events),/真实文件|base64|"content"|"bytes"/);
  s.runtime.close();const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');const reopened=await createApplicationRuntime({directory:s.directory});t.after(()=>reopened.close());
  assert.deepEqual(reopened.downloadAttachment({roomId:s.roomId,attachmentId:first.attachment.id},reopened.owner).bytes,bytes);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(s.directory,'application.sqlite'));db.prepare('UPDATE attachments SET content=? WHERE id=?').run(Buffer.from('bad'),first.attachment.id);db.close();
  assert.throws(()=>reopened.downloadAttachment({roomId:s.roomId,attachmentId:first.attachment.id},reopened.owner),{code:'attachment_unavailable'});
});
test('all supported formats, invalid names, UTF-8, magic, sizes and aggregate bounds use the same runtime interface',async t=>{
  const s=await setup(t);
  const positives={txt:Buffer.from('hello'),md:Buffer.from('# 报告'),csv:Buffer.from('a,b\n1,2'),json:Buffer.from('{"a":1}'),log:Buffer.from('info'),pdf:Buffer.from('%PDF-1.7\n'),png:Buffer.from([137,80,78,71,13,10,26,10]),jpg:Buffer.from([255,216,255]),jpeg:Buffer.from([255,216,255]),webp:Buffer.from('RIFF0000WEBP')};
  for(const [ext,bytes] of Object.entries(positives)) assert.equal(s.upload(bytes,'file.'+ext).attachment.size,bytes.length);
  for(const name of ['../a.txt','C:a.txt','a/b.txt','a\\b.txt','a\r\n.txt','CON.txt','LPT1.txt','a.txt ','a.svg','a.html','a.exe','a.zip','a.docx','a\u202e.txt','a'.repeat(161)+'.txt','e\u0301.txt']) assert.throws(()=>s.upload(Buffer.from('ok'),name),{code:'invalid_request'},name);
  for(const [bytes,name] of [[Buffer.from([255]),'bad.txt'],[Buffer.from([0]),'nul.txt'],[Buffer.from('nope'),'bad.png'],[Buffer.alloc(0),'empty.txt'],[Buffer.alloc(8*1024*1024+1,65),'large.txt']]) assert.throws(()=>s.upload(bytes,name));
  const large=Buffer.alloc(7*1024*1024,65),ids=[1,2,3].map(()=>s.upload(large).attachment.id);
  assert.throws(()=>s.send(ids),{code:'attachment_limit'});assert.equal(s.query('snapshot').messages.length,0);
  assert.throws(()=>s.send(Array.from({length:6},()=>randomUUID())),{code:'invalid_request'});
  assert.throws(()=>s.send([]),{code:'invalid_request'});
});
test('pending expires at 24 hours; cleanup never deletes published bytes and quota includes pending',async t=>{
  let now=Date.now();const s=await setup(t,{clock:()=>now,maintenanceIntervalMs:10});
  const linked=s.upload(Buffer.from('linked')),pending=s.upload(Buffer.from('pending'));s.send([linked.attachment.id]);
  now+=24*60*60*1000;
  assert.throws(()=>s.send([pending.attachment.id]),{code:'attachment_expired'});
  await new Promise(r=>setTimeout(r,30));assert.equal(s.query('pendingAttachments').attachments.length,0);
  assert.equal(s.runtime.downloadAttachment({roomId:s.roomId,attachmentId:linked.attachment.id},s.actor).bytes.toString(),'linked');
  // Seed quota with valid large uploads, not a fake count that skips byte persistence.
  const bytes=Buffer.alloc(8*1024*1024,65);for(let i=0;i<31;i++)s.upload(bytes,'quota.txt');
  assert.throws(()=>s.upload(bytes,'full.txt'),{code:'attachment_quota'});
});
for(const point of ['after_entity','after_event','after_receipt','after_commit']) test(`attachment upload and bind at ${point} are all-or-nothing`,async t=>{
  let armed=false;const s=await setup(t,{fault:p=>{if(armed && p===point)throw Error('fault');}}),bytes=Buffer.from('atomic');
  armed=true;assert.throws(()=>s.upload(bytes,'atomic.txt','upload'),{code:'storage_error'});armed=false;
  assert.equal(s.query('pendingAttachments').attachments.length,point==='after_commit'?1:0);
  const receipt=s.upload(bytes,'atomic.txt','upload');armed=true;assert.throws(()=>s.send([receipt.attachment.id],'send'),{code:'storage_error'});armed=false;
  assert.equal(s.query('snapshot').messages.length,point==='after_commit'?1:0);
  s.send([receipt.attachment.id],'send');assert.equal(s.query('snapshot').messages.length,1);
});
test('authenticated binary HTTP checks metadata before body, serves forced downloads, and retains JSON body limits',async t=>{
  const s=await setup(t),{startPersistenceHttp}=await import('../lib/application-http/index.mjs');const server=await startPersistenceHttp({runtime:s.runtime});t.after(()=>server.close());
  const bytes=Buffer.from('binary upload'),command=s.command(bytes),url=`${server.origin}/api/v1/rooms/${s.roomId}/attachments`;
  const headers={Authorization:`Bearer ${server.token}`,'Content-Type':'application/octet-stream','Idempotency-Key':command.key,'X-Workspace-Id':s.workspaceId,'X-Attachment-Name':encodeURIComponent(command.name),'X-Content-Sha256':command.sha256};
  assert.equal((await fetch(url,{method:'POST',body:bytes})).status,401);
  const response=await fetch(url,{method:'POST',headers,body:bytes});assert.equal(response.status,200);const receipt=await response.json();
  const download=await fetch(`${url}/${receipt.attachment.id}/content`,{headers});assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;.*filename\*=UTF-8''/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.equal(download.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await fetch(`${url}/${receipt.attachment.id}/content`,{headers:{...headers,Range:'bytes=0-1'}})).status,416);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-Attachment-Name':'evil.exe'},body:bytes})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-Content-Sha256':'0'.repeat(64)},body:bytes})).status,400);
});
