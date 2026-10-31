import { reviewResultSchema, reviewFailure as fail } from '../../contracts/file-review.mjs';

// Explicit refresh only; no polling, task creation, or workspace writes.
export function createWorkspaceChangesController(client) {
 /** @type {{result:import('zod').infer<typeof reviewResultSchema>|null,loading:boolean,error:string}} */
 let state={result:null,loading:false,error:''};let generation=0,closed=false;
 const listeners=new Set();
 const publish=patch=>{state={...state,...patch};for(const listener of listeners)listener();};
 return {
  read:()=>state,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  activate(){closed=false;},
  async refresh(){
   if(closed)return;const request=++generation;publish({loading:true,error:''});
   try{
    const result=reviewResultSchema.parse(await client.request({type:'changes'}));
    if(result.type!=='changes'||result.simulated)throw fail('invalid_response','工作区变更需要真实宿主响应。');
    if(!closed&&request===generation)publish({result,loading:false,error:''});
   }catch(error){if(!closed&&request===generation)publish({loading:false,error:error.message||'读取工作区变更失败。'});}
  },
  close(){closed=true;++generation;listeners.clear();},
 };
}
