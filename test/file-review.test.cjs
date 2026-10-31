const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const modules=Promise.all([import('../lib/file-review/service.mjs'),import('../renderer/client/file-autosave.mjs')]);
async function fixture(t,options={}){
 const [{createFileReviewService,contentHash},{createAutosaveDocument}]=await modules;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-review-')),root=path.join(dir,'workspace');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'file.txt'),'\ufeffold\r\n','utf8');
 const config={directory:path.join(dir,'data'),resolveScope:(input,caller)=>caller==='human'&&input.workspaceId==='w'&&input.roomId==='r'?{workspaceId:'w',roomId:'r',root,authorId:'human',authorName:'你',canWrite:true}:null,...options};
 let service=createFileReviewService(config);t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=input=>service.request({workspaceId:'w',roomId:'r',file:'file.txt',...input},'human');
 return {dir,root,request,contentHash,createAutosaveDocument,restart:()=>{service.close();service=createFileReviewService(config);},client:{draftPrefix:'test',request:async input=>request(input)}};
}
test('real UTF-8 read/save preserves BOM/CRLF, persists comments and idempotent receipts',async t=>{
 const f=await fixture(t),read=f.request({type:'readFile'});assert.equal(read.text,'\ufeffold\r\n');
 const save={type:'saveFile',key:'save-1',rootId:read.rootId,expectedRevision:read.revision,text:'\ufeffnew\r\n'};const receipt=f.request(save);assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),save.text);
 assert.deepEqual(f.request(save),receipt);assert.throws(()=>f.request({...save,text:'other'}),{code:'idempotency_conflict'});
 const comment={type:'addComment',key:'comment-1',version:f.contentHash('patch'),side:'additions',line:2,quote:'new',text:'请解释此行'};
 f.request(comment);f.restart();assert.equal(f.request({type:'comments',version:comment.version}).comments.length,1);f.request(comment);assert.equal(f.request({type:'comments',version:comment.version}).comments.length,1);
 assert.deepEqual(f.request(save),receipt);assert.equal(f.request({type:'comments',version:f.contentHash('other')}).comments.length,0);
});
test('rejects traversal, ADS, invalid scope, binary, oversize and hardlinks',async t=>{
 const f=await fixture(t);
 for(const file of ['../outside','/outside','C:/outside','dir\\file','file.txt:ads','.git/config','dir/../file.txt','file.txt.','CON'])assert.throws(()=>f.request({type:'readFile',file}),{code:'invalid_request'});
 assert.throws(()=>f.request({type:'readFile',roomId:'other'}),{code:'forbidden'});
 fs.writeFileSync(path.join(f.root,'binary'),Buffer.from([255,0,1]));assert.throws(()=>f.request({type:'readFile',file:'binary'}),{code:'unsupported_file'});
 fs.writeFileSync(path.join(f.root,'large'),Buffer.alloc(262145,65));assert.throws(()=>f.request({type:'readFile',file:'large'}),{code:'file_too_large'});
 fs.linkSync(path.join(f.root,'file.txt'),path.join(f.root,'hardlink'));assert.throws(()=>f.request({type:'readFile'}),{code:'unsupported_file'});
});
test('rejects symlink/junction escape',async t=>{
 const f=await fixture(t),outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret'),'outside');
 fs.symlinkSync(outside,path.join(f.root,'link'),'junction');assert.throws(()=>f.request({type:'readFile',file:'link/secret'}),{code:'invalid_path'});
});
test('external modifications conflict without overwriting disk',async t=>{
 const f=await fixture(t),read=f.request({type:'readFile'});fs.writeFileSync(path.join(f.root,'file.txt'),'external');
 assert.throws(()=>f.request({type:'saveFile',key:'k',rootId:read.rootId,expectedRevision:read.revision,text:'draft'}),{code:'file_conflict'});assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'external');
});
test('rechecks before replace and recovers crash after replace with same request',async t=>{
 let mode='external',root;const f=await fixture(t,{fault:point=>{if(point==='before_replace'&&mode==='external'){fs.writeFileSync(path.join(root,'file.txt'),'external');mode='';}if(point==='replaced'&&mode==='crash'){mode='';throw Error('crash');}}});root=f.root;
 let read=f.request({type:'readFile'}),save={type:'saveFile',key:'k',rootId:read.rootId,expectedRevision:read.revision,text:'draft'};
 assert.throws(()=>f.request(save),{code:'file_conflict'});assert.equal(fs.readFileSync(path.join(root,'file.txt'),'utf8'),'external');
 read=f.request({type:'readFile'});save={...save,key:'k2',expectedRevision:read.revision};mode='crash';assert.throws(()=>f.request(save),{code:'review_io_error'});f.restart();assert.equal(f.request(save).revision,f.contentHash('draft'));assert.equal(fs.readFileSync(path.join(root,'file.txt'),'utf8'),'draft');assert.equal(fs.readdirSync(root).filter(p=>p.endsWith('.tmp')).length,0);
});
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('autosave debounces, preserves composition, serializes edits and drains on close',async t=>{
 const f=await fixture(t),drafts=storage(),calls=[];let release;
 const client={...f.client,request:async input=>{if(input.type==='saveFile'){calls.push(input);if(calls.length===1)await new Promise(r=>release=r);}return f.client.request(input);}};
 const model=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:15});await model.open();model.composition(true);model.update('draft');await wait(40);assert.equal(calls.length,0);model.composition(false);await wait(30);assert.equal(calls.length,1);
 model.update('newest');model.close();release();await wait(40);assert.equal(calls.length,2);assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'newest');assert.equal(model.read().status,'saved');
});
test('autosave restart restores unsaved drafts and pauses for external changes',async t=>{
 const f=await fixture(t),drafts=storage();let model=f.createAutosaveDocument({client:f.client,file:'file.txt',storage:drafts,delay:10000});await model.open();model.composition(true);model.update('my draft');model.close();fs.writeFileSync(path.join(f.root,'file.txt'),'outside edit');
 model=f.createAutosaveDocument({client:f.client,file:'file.txt',storage:{...drafts},delay:10});await model.open();assert.equal(model.read().text,'my draft');assert.equal(model.read().status,'conflict');await wait(30);assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'outside edit');await model.useDisk();assert.equal(model.read().text,'outside edit');assert.match(drafts.getItem('test:draft:file.txt:recovery'),/my draft/);model.close();
});
test('lost receipt retry retains original key and does not lose later draft',async t=>{
 const f=await fixture(t),drafts=storage(),keys=[];let fail=true;
 const client={...f.client,request:async input=>{const result=await f.client.request(input);if(input.type==='saveFile'){keys.push(input.key);if(fail){fail=false;throw Object.assign(Error('lost'),{code:'offline'});}}return result;}};
 const model=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:10});await model.open();model.update('first');await wait(40);assert.equal(model.read().status,'error');model.update('second');await model.retry();await wait(40);assert.equal(keys[0],keys[1]);assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'second');model.close();
});
test('directory replacement before rename cannot redirect write or cleanup outside workspace',async t=>{
 let root,outside;const f=await fixture(t,{fault:point=>{if(point==='before_replace'){fs.renameSync(path.join(root,'nested'),path.join(root,'moved'));fs.symlinkSync(outside,path.join(root,'nested'),'junction');}}});root=f.root;outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'nested','file.txt'),'original');fs.writeFileSync(path.join(outside,'file.txt'),'outside');
 const read=f.request({type:'readFile',file:'nested/file.txt'});assert.throws(()=>f.request({type:'saveFile',key:'path-race',file:'nested/file.txt',rootId:read.rootId,expectedRevision:read.revision,text:'draft'}),{code:'invalid_path'});assert.equal(fs.readFileSync(path.join(outside,'file.txt'),'utf8'),'outside');assert.equal(fs.readFileSync(path.join(root,'moved','file.txt'),'utf8'),'original');
});
test('lost receipt plus subsequent external edit never replays over external edit',async t=>{
 let crash=true;const f=await fixture(t,{fault:point=>{if(point==='replaced'&&crash){crash=false;throw Error('crash');}}});const read=f.request({type:'readFile'}),save={type:'saveFile',key:'crashed',rootId:read.rootId,expectedRevision:read.revision,text:'draft'};
 assert.throws(()=>f.request(save),{code:'review_io_error'});fs.writeFileSync(path.join(f.root,'file.txt'),'new outside');f.restart();assert.throws(()=>f.request(save),{code:'file_conflict'});assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'new outside');
});
test('close and reopen share one autosave queue; late responses cannot overwrite newer draft',async t=>{
 const f=await fixture(t),drafts=storage(),sent=[];let release;
 const client={...f.client,request:async input=>{const result=await f.client.request(input);if(input.type==='saveFile'){sent.push(input.text);if(sent.length===1)await new Promise(r=>release=r);}return result;}};
 const a=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:10});await a.open();a.update('a');await wait(30);a.update('b');a.close();
 const b=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:10});await b.open();b.update('c');release();await wait(60);
 assert.deepEqual(sent,['a','c']);assert.equal(b.read().text,'c');assert.equal(b.read().status,'saved');assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'c');assert.equal(JSON.parse(drafts.getItem('test:draft:file.txt')).text,'c');b.close();
});
test('reopen clean saved editor adopts external changes, not a false draft conflict',async t=>{
 const f=await fixture(t),drafts=storage();let model=f.createAutosaveDocument({client:f.client,file:'file.txt',storage:drafts});await model.open();model.close();fs.writeFileSync(path.join(f.root,'file.txt'),'outside');model=f.createAutosaveDocument({client:f.client,file:'file.txt',storage:drafts});await model.open();assert.equal(model.read().status,'saved');assert.equal(model.read().text,'outside');model.close();
});
test('initial read is single-flight across close/reopen and cannot overwrite new edits',async t=>{
 const f=await fixture(t),drafts=storage();let release,reads=0;
 const client={...f.client,request:async input=>{const result=await f.client.request(input);if(input.type==='readFile'){reads++;if(reads===1)await new Promise(r=>release=r);}return result;}};
 const a=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:10000});const openingA=a.open();await wait(5);a.close();const b=f.createAutosaveDocument({client,file:'file.txt',storage:drafts,delay:10000});const openingB=b.open();await wait(5);assert.equal(reads,1);assert.equal(b.read().ready,false);
 release();await Promise.all([openingA,openingB]);b.update('new draft');await wait(10);assert.equal(b.read().text,'new draft');assert.equal(JSON.parse(drafts.getItem('test:draft:file.txt')).text,'new draft');await b.flush();b.close();
});
test('two service instances reject a stale writer instead of overwriting the first save',async t=>{
 const f=await fixture(t),{createFileReviewService}=await import('../lib/file-review/service.mjs');
 const second=createFileReviewService({directory:path.join(f.dir,'data'),resolveScope:()=>({workspaceId:'w',roomId:'r',root:f.root,authorId:'human',authorName:'你',canWrite:true})});try{
 const old=f.request({type:'readFile'});f.request({type:'saveFile',key:'writer-a',rootId:old.rootId,expectedRevision:old.revision,text:'first writer'});
 assert.throws(()=>second.request({type:'saveFile',workspaceId:'w',roomId:'r',file:'file.txt',key:'writer-b',rootId:old.rootId,expectedRevision:old.revision,text:'stale writer'},'human'),{code:'file_conflict'});assert.equal(fs.readFileSync(path.join(f.root,'file.txt'),'utf8'),'first writer');
 }finally{second.close();}
});
test('runtime adapter authorizes room identity and keeps edit root separate from read-only execution',async t=>{
 const f=await fixture(t),{createApplicationRuntime}=await import('../lib/application-runtime/index.mjs'),{createRuntimeFileReview}=await import('../lib/file-review/runtime-adapter.mjs');
 const directory=path.join(f.dir,'application'),runtime=await createApplicationRuntime({directory});let review;
 try{
  const boot=runtime.query({type:'bootstrap'},runtime.owner),created=runtime.execute({type:'createRoom',workspaceId:boot.workspace.id,key:'review-room',title:'Review'},runtime.owner),input={type:'readFile',workspaceId:boot.workspace.id,roomId:created.roomId,file:'file.txt'};
  review=createRuntimeFileReview(runtime,{directory});assert.throws(()=>review.request(input,runtime.owner),{code:'editing_unavailable'});review.close();
  review=createRuntimeFileReview(runtime,{directory,editorWorkspace:f.root});const file=review.request(input,runtime.owner);assert.equal(file.text,'\ufeffold\r\n');assert.throws(()=>review.request(input,{principalId:'other'}),{code:'forbidden'});
  assert.throws(()=>review.request({...input,roomId:'other'},runtime.owner),{code:'not_found'});review.close();
  const busyRuntime={query(q,actor){const result=runtime.query(q,actor);return q.type==='snapshot'?{...result,localTasks:[{phase:'unknown',leaseHeld:true}]}:result;}};
  review=createRuntimeFileReview(busyRuntime,{directory,editorWorkspace:f.root});assert.throws(()=>review.request({...input,type:'saveFile',key:'busy',rootId:file.rootId,expectedRevision:file.revision,text:'must not save'},runtime.owner),{code:'workspace_busy'});
 }finally{review?.close();runtime.close();}
});
