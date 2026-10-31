// One document owns its draft, immutable in-flight request and serial autosave queue.
// No transport side effects happen during IME composition. Closing drains a pending edit;
// abrupt process exit restores the persisted draft and retries its original key.
const controllers = new WeakMap();
/** @returns {ReturnType<typeof createController>} */
export function createAutosaveDocument(options) {
 const storage=options.storage||globalThis.localStorage,key=`${options.client.draftPrefix}:draft:${options.file}`;
 let documents=controllers.get(storage);if(!documents){documents=new Map();controllers.set(storage,documents);}
 let entry=documents.get(key);
 if(!entry){entry={users:0,model:null};const own=entry;entry.model=createController({...options,storage,onIdle:()=>{if(own.users===0&&documents.get(key)===own)documents.delete(key);}});documents.set(key,entry);}
 entry.users++;entry.model.rebind(options.client);let released=false;
 return {...entry.model,close(){if(released)return;released=true;if(--entry.users===0)entry.model.close();}};
}
function createController({ client,file,storage,delay=700,onIdle }) {
 const storageKey=`${client.draftPrefix}:draft:${file}`;
 let state={ready:false,status:'loading',text:'',savedText:'',revision:'',rootId:'',error:'',disk:/** @type {null | {text:string;revision:string;rootId:string}} */(null)},pending=null,timer,opening=null,saving=false,composing=false,closed=false,ready=false;
 const listeners=new Set();const publish=patch=>{state={...state,...patch};for(const listener of listeners)listener();};
 const persist=()=>{try{storage.setItem(storageKey,JSON.stringify({text:state.text,savedText:state.savedText,revision:state.revision,rootId:state.rootId,pending}));return true;}catch{publish({status:'error',error:'本地草稿保存失败，请先复制内容，避免关闭后丢失。'});return false;}};
 const schedule=()=>{clearTimeout(timer);if(!composing&&!['conflict','error'].includes(state.status))timer=setTimeout(()=>void flush(),delay);};
 async function open(){
  closed=false;if(opening)return opening;
  const request=load();opening=request;
  try{return await request;}finally{if(opening===request)opening=null;}
 }
 async function load(){
  closed=false;
  if(ready&&(saving||pending||state.status!=='saved'))return;
  publish({ready:false,status:'loading'});
  try {
   const stored=JSON.parse(storage.getItem(storageKey)||'null');
   if(stored&&typeof stored.text==='string')publish({text:stored.text});
   let recovered;
   if(stored?.pending){pending=stored.pending;try{recovered=await client.request(pending);}catch(e){if(e.code!=='file_conflict')throw e;}}
   const disk=await client.request({type:'readFile',file});
   if(disk.type!=='file')throw Error('文件响应不正确。');
   ready=true;
   const restored=stored&&typeof stored.text==='string'&&(stored.text!==stored.savedText||Boolean(stored.pending));
   const revision=recovered?.revision||stored?.revision;
   const dirty=restored&&stored.text!==disk.text;
   pending=null;
   publish({ready:true,text:restored?stored.text:disk.text,savedText:disk.text,revision:disk.revision,rootId:disk.rootId,disk:null,status:dirty?(revision===disk.revision&&stored.rootId===disk.rootId?'dirty':'conflict'):'saved',error:dirty&&revision!==disk.revision?'磁盘已变化，恢复的草稿尚未写入。':''});
   if(state.status==='conflict')publish({disk});
   if(persist()&&state.status==='dirty')schedule();
  }catch(e){publish({status:'error',error:e.message});}
 }
 async function flush(){
  clearTimeout(timer);
  if(!ready||saving||composing||state.status==='conflict'||(!pending&&state.text===state.savedText))return;
  if(!pending)pending={type:'saveFile',key:crypto.randomUUID(),file,rootId:state.rootId,expectedRevision:state.revision,text:state.text};
  if(!persist())return;
  saving=true;publish({status:'saving',error:''});
  try {
   const result=await client.request(pending);if(result.type!=='saved')throw Error('保存响应不正确。');
   const savedText=pending.text;pending=null;
   publish({savedText,revision:result.revision,status:state.text===savedText?'saved':'dirty',error:''});
   persist();
  }catch(e){
   publish({status:e.code==='file_conflict'?'conflict':'error',error:e.message});
   if(e.code==='file_conflict'){try{const disk=await client.request({type:'readFile',file});publish({disk});}catch{} }
   persist();
  }finally{saving=false;if(state.status==='dirty'){if(closed)void flush();else schedule();}else if(closed&&state.status==='saved')onIdle();}
 }
 return {rebind(next){client=next;if(closed){composing=false;closed=false;if(state.status==='dirty')schedule();}},read:()=>state,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},open,
  update(text){if(!ready)return;publish({text,status:['conflict','error'].includes(state.status)?state.status:saving?'saving':'dirty'});if(persist())schedule();},
  composition(value){composing=value;if(value)clearTimeout(timer);else schedule();},
  retry(){if(!ready)return open();if(state.status==='conflict')return;publish({status:'dirty',error:''});return flush();},
  async useDisk(){
   try{const disk=await client.request({type:'readFile',file});storage.setItem(storageKey+':recovery',JSON.stringify({text:state.text,revision:state.revision,at:Date.now()}));pending=null;publish({text:disk.text,savedText:disk.text,rootId:disk.rootId,revision:disk.revision,status:'saved',disk:null,error:''});persist();}catch(e){publish({error:e.message});}
  },
  flush,close(){closed=true;clearTimeout(timer);if(!['conflict','error'].includes(state.status))void flush();if(!saving&&!pending&&state.status==='saved')onIdle();},
 };
}
