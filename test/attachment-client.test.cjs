const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const until=async read=>{for(let i=0;i<200;i++){if(await read())return;await new Promise(r=>setTimeout(r,10));}throw Error('State did not arrive');};
function storage(){const data=new Map();return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),key:i=>[...data.keys()][i]??null,get length(){return data.size;}};}
test('public Client uploads without binary journal, synchronizes attachment-only messages, validates downloads and recovers unknown uploads without replay',async t=>{
  const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs'),{startPersistenceHttp}=await import('../lib/application-http/index.mjs'),{createAgentRoomClient}=await import('../renderer/client/client.mjs'),{createPersistentTransport}=await import('../renderer/client/persistent.mjs');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-attachment-client-')),runtime=await createApplicationRuntime({directory}),server=await startPersistenceHttp({runtime});
  const workspaceId=runtime.query({type:'bootstrap'},runtime.owner).workspace.id,roomId=runtime.execute({type:'createRoom',workspaceId,key:'r',title:'Files'},runtime.owner).roomId;
  const clients=[];t.after(async()=>{clients.forEach(c=>c.close());await server.close();runtime.close();});
  let uploadCount=0,lose=false,dropBefore=false,corrupt=false,hold=false;
  const journal=storage();
  async function make(store=storage()){
    const c=createAgentRoomClient(createPersistentTransport({backendId:'attachments',localUserId:'owner',storage:store,session:async()=>({origin:server.origin,token:server.token}),fetch:async(url,options)=>{
      const upload=options.method==='POST' && url.endsWith('/attachments');if(upload){uploadCount++;if(dropBefore)throw Error('offline');if(hold){await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw Error('cancelled');}}
      const res=await fetch(url,options);if(upload&&lose)throw Error('lost');
      if(corrupt&&url.endsWith('/content'))return new Response(Buffer.from('corrupt'),{headers:res.headers});
      return res;
    }}));clients.push(c);await c.open({roomId});return c;
  }
  const a=await make(journal),b=await make();assert.equal(a.read().capabilities.attachments,true);
  const file=new Blob(['secret-file-content']),input={key:'upload',roomId,name:'报告.txt',file};lose=true;
  await assert.rejects(a.uploadAttachment(input),{outcome:'unknown'});assert.equal(uploadCount,1);assert.equal(journal.data.size,1);assert.doesNotMatch([...journal.data.values()].join(''),/secret-file-content|"bytes"|"file"|base64|"path"/);
  a.close();lose=false;const recovered=await make(journal);assert.equal(uploadCount,1);assert.equal(journal.data.size,0);
  const staged=await recovered.query({type:'pendingAttachments',roomId});assert.equal(staged.attachments.length,1);
  const id=staged.attachments[0].id;
  await recovered.dispatch({type:'send',key:'send',roomId,text:'',mode:'discussion',ownerAgentId:null,mentions:[],attachmentIds:[id]});
  await until(()=>b.read().messages.length===1);assert.equal(b.read().messages[0].attachmentRefs[0].id,id);
  const download=await b.downloadAttachment({roomId,attachmentId:id});assert.equal(await download.blob.text(),'secret-file-content');
  corrupt=true;await assert.rejects(b.downloadAttachment({roomId,attachmentId:id}));corrupt=false;
  dropBefore=true;await assert.rejects(recovered.uploadAttachment({...input,key:'retry'}),{outcome:'unknown'});dropBefore=false;
  assert.equal(await recovered.checkOperation('retry','uploadAttachment'),null);const count=uploadCount;
  await assert.rejects(recovered.retryOperation('retry'),{code:'file_required'});assert.equal(uploadCount,count);
  await assert.rejects(recovered.uploadAttachment({...input,key:'retry',file:new Blob(['changed'])}),{code:'idempotency_conflict'});assert.equal(uploadCount,count);
  await recovered.uploadAttachment({...input,key:'retry'});assert.equal(uploadCount,count+1);
  const controller=new AbortController();hold=true;const cancelled=recovered.uploadAttachment({...input,key:'cancel',signal:controller.signal});
  await until(()=>recovered.read().pendingOperations.some(o=>o.key==='cancel'));controller.abort();await assert.rejects(cancelled,{outcome:'unknown'});hold=false;
  assert.equal(await recovered.checkOperation('cancel','uploadAttachment'),null);
  await recovered.uploadAttachment({...input,key:'cancel'});
  const pending=await recovered.query({type:'pendingAttachments',roomId});assert.equal(pending.attachments.length,2);
  await recovered.dispatch({type:'removeAttachment',schemaVersion:1,key:'remove',workspaceId,roomId,attachmentId:pending.attachments[0].id});assert.equal((await recovered.query({type:'pendingAttachments',roomId})).attachments.length,1);
});
