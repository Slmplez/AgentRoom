const test=require('node:test'),assert=require('node:assert/strict');
const result=base=>({type:'changes',workspaceId:'w',roomId:'r',rootId:'a'.repeat(64),base,complete:true,files:[],simulated:false});
test('refresh ignores stale responses, retains prior result on error and stops after close',async()=>{
 const {createWorkspaceChangesController}=await import('../renderer/client/workspace-changes.mjs');const pending=[];
 const model=createWorkspaceChangesController({request:input=>{assert.deepEqual(input,{type:'changes'});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});
 const a=model.refresh(),b=model.refresh();pending[1].resolve(result('new'));await b;pending[0].resolve(result('old'));await a;assert.equal(model.read().result.base,'new');
 const c=model.refresh();pending[2].reject(Error('offline'));await c;assert.equal(model.read().error,'offline');assert.equal(model.read().result.base,'new');
 const d=model.refresh();model.close();pending[3].resolve(result('late'));await d;assert.equal(model.read().result.base,'new');
});
test('workspace changes rejects simulated data instead of presenting it as a real workspace',async()=>{
 const {createWorkspaceChangesController}=await import('../renderer/client/workspace-changes.mjs');const model=createWorkspaceChangesController({request:async()=>({...result('mock'),simulated:true})});
 await model.refresh();assert.equal(model.read().result,null);assert.match(model.read().error,/真实宿主/);model.close();
});
