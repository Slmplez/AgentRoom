const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),key:i=>[...map.keys()][i]??null,get length(){return map.size;}};};
async function fixture(t,{enabled=true}={}){
 const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs'),{startPersistenceHttp}=await import('../lib/application-http/index.mjs'),{createPersistentTransport}=await import('../renderer/client/persistent.mjs'),{createAgentRoomClient}=await import('../renderer/client/client.mjs');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ar-review-client-')),root=path.join(temp,'workspace');await fs.mkdir(root);await fs.writeFile(path.join(root,'file.txt'),'original\n');
 const runtime=await createApplicationRuntime({directory:path.join(temp,'data'),...(enabled?{editorWorkspace:root}:{})}),http=await startPersistenceHttp({runtime}),workspaceId=runtime.query({type:'bootstrap'},runtime.owner).workspace.id;
 const roomId=runtime.execute({type:'createRoom',workspaceId,key:'one',title:'One'},runtime.owner).roomId,other=runtime.execute({type:'createRoom',workspaceId,key:'two',title:'Two'},runtime.owner).roomId;
 let mutate,drop=false,gate,started;const clients=[];
 const make=async()=>{const client=createAgentRoomClient(createPersistentTransport({backendId:'review-test',localUserId:'owner',storage:storage(),session:async()=>({origin:http.origin,token:http.token}),fetch:async(url,options)=>{
  const response=await fetch(url,options);if(!url.endsWith('/file-review'))return response;
  if(drop){drop=false;throw Error('lost receipt');}
  if(gate){const hold=gate;gate=null;started?.();await hold;}
  if(mutate){const data=await response.json();mutate(data);return new Response(JSON.stringify(data),{status:response.status});}return response;
 }}));clients.push(client);await client.open({roomId});return client;};
 t.after(async()=>{clients.forEach(c=>c.close());await http.close();runtime.close();await fs.rm(temp,{recursive:true,force:true});});
 return {make,root,scope:{workspaceId,roomId},other,drop:()=>drop=true,mutate:value=>mutate=value,delay:()=>{let release;gate=new Promise(r=>release=r);const arrived=new Promise(r=>started=r);return {release,arrived};}};
}
test('public review capability and room scope fail closed',async t=>{
 const f=await fixture(t,{enabled:false}),client=await f.make();assert.equal(client.read().capabilities.fileReview,false);await assert.rejects(client.review({type:'readFile',...f.scope,file:'file.txt'}),{code:'editing_unavailable'});
 const g=await fixture(t),enabled=await g.make();assert.equal(enabled.read().capabilities.fileReview,true);await assert.rejects(enabled.review({type:'readFile',...g.scope,roomId:g.other,file:'file.txt'}),{code:'invalid_scope'});
});
test('public review preserves original save key after lost response and rejects corrupt hashes',async t=>{
 const f=await fixture(t),client=await f.make(),input={type:'readFile',...f.scope,file:'file.txt'},read=await client.review(input);
 const save={type:'saveFile',...f.scope,file:'file.txt',key:'same-key',rootId:read.rootId,expectedRevision:read.revision,text:'saved\n'};f.drop();await assert.rejects(client.review(save),{outcome:'unknown'});assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'saved\n');assert.equal((await client.review(save)).key,'same-key');
 f.mutate(data=>data.value.revision='0'.repeat(64));await assert.rejects(client.review(input),{code:'invalid_response'});
});
test('review rejects foreign receipt scope, type and comments rather than trusting valid-shaped data',async t=>{
 const f=await fixture(t),client=await f.make(),input={type:'readFile',...f.scope,file:'file.txt'};
 f.mutate(data=>data.value.roomId=f.other);await assert.rejects(client.review(input),{code:'invalid_response'});
 f.mutate(data=>{data.value.type='saved';data.value.key='wrong';});await assert.rejects(client.review(input),{code:'invalid_response'});
 f.mutate(data=>{data.value.comment.line+=1;});await assert.rejects(client.review({type:'addComment',...f.scope,file:'file.txt',key:'comment',version:'a'.repeat(64),side:'additions',line:1,quote:'original',text:'note'}),{code:'invalid_response',outcome:'unknown'});
});
test('a review reply arriving after room change cannot enter the new client scope',async t=>{
 const f=await fixture(t),client=await f.make(),hold=f.delay(),pending=client.review({type:'readFile',...f.scope,file:'file.txt'});const rejected=assert.rejects(pending,error=>['stale_review','offline'].includes(error.code));await hold.arrived;await client.open({roomId:f.other});hold.release();await rejected;assert.equal(client.read().rooms[0].id,f.other);
});
