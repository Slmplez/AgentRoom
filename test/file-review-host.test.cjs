const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {startPersistentHost}=require('../lib/persistence-host.cjs');
test('proxy marks a lost review save response unknown and the original key recovers the actual committed file',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ar-review-proxy-')),root=path.join(temp,'workspace'),rendererRoot=path.join(temp,'renderer');await fs.mkdir(root);await fs.mkdir(rendererRoot);await fs.writeFile(path.join(root,'file.txt'),'before');await fs.writeFile(path.join(rendererRoot,'chat.html'),'<html data-mode="live"></html>');
 const host=await startPersistentHost({directory:path.join(temp,'data'),editorWorkspace:root,rendererRoot,port:0});const original=http.request;
 t.after(async()=>{http.request=original;await host.close();assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));await fs.rm(temp,{recursive:true,force:true});});
 const session=await fetch(host.origin+'/api/persistence/session'),cookie=session.headers.get('set-cookie').split(';')[0],identity=await session.json(),boot=await (await fetch(host.origin+'/api/v1/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=async input=>{const response=await fetch(host.origin+'/api/v1/file-review',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
 const scope={workspaceId:boot.workspace.id,roomId:identity.roomId,file:'file.txt'},read=(await request({type:'readFile',...scope})).data.value;
 let lose=true;http.request=function(url,options,callback){
  if(lose&&String(url).endsWith('/api/v1/file-review')){lose=false;const upstream=original.call(http,url,options,response=>{response.resume();upstream.destroy(Error('isolated test: response lost after server commit'));});return upstream;}
  return original.call(http,url,options,callback);
 };
 const save={type:'saveFile',...scope,key:'proxy-lost',rootId:read.rootId,expectedRevision:read.revision,text:'committed'};const lost=await request(save);assert.equal(lost.status,502);assert.equal(lost.data.outcome,'unknown');assert.equal(await fs.readFile(path.join(root,'file.txt'),'utf8'),'committed');
 const recovered=await request(save);assert.equal(recovered.status,200);assert.equal(recovered.data.value.key,'proxy-lost');assert.equal(recovered.data.value.type,'saved');
});
