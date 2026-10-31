import { reviewRequestSchema, reviewResultSchema, reviewFailure as fail } from '../../contracts/file-review.mjs';
export const reviewHashText = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export function createFileReviewClient(client, scope, {mock=false,storage=globalThis.localStorage}={}) {
 let tabId;try{tabId=sessionStorage.getItem('agentroom-review-tab');if(!tabId){tabId=crypto.randomUUID();sessionStorage.setItem('agentroom-review-tab',tabId);}}catch{tabId='local';}
 const prefix=`agentroom:review:${JSON.stringify(scope)}`;
 const identity=()=>{const s=client.read();return JSON.stringify([s.backendId,s.databaseId,s.currentUserId,s.rooms.find(r=>r.id===scope.roomId)?.workspaceId]);};
 const born=identity();
 const scopeCheck=()=>{if(identity()!==born || !client.read().rooms.some(r=>r.id===scope.roomId&&r.workspaceId===scope.workspaceId))throw fail('stale_review','会话范围已变化，请重新打开文件。');};
 const load=key=>{try{return JSON.parse(storage.getItem(prefix+key)||'null');}catch{throw fail('draft_storage_error','本地审阅记录不可读。');}};
 const store=(key,value)=>{try{storage.setItem(prefix+key,JSON.stringify(value));}catch{throw fail('draft_storage_error','本地存储空间不足，无法保存。');}};
 async function mockRequest(input) {
  if(input.type==='changes')throw fail('editing_unavailable','模拟场景没有真实 Git 工作区，请使用示例差异。');
  const result={workspaceId:scope.workspaceId,roomId:scope.roomId,file:input.file,simulated:true};
  const key=`:file:${input.file}`,record=load(key);
  if(input.type==='readFile'){if(!record)throw fail('file_missing','此模拟文件尚未载入。');return {type:'file',...result,...record};}
  const digest=await reviewHashText(JSON.stringify(input)), op=load(':op:'+input.key);
  if(input.key&&op){if(op.digest!==digest)throw fail('idempotency_conflict','请求标识已用于其他内容。');return op.result;}
  if(input.type==='saveFile'){
   if(!record||record.revision!==input.expectedRevision||record.rootId!==input.rootId)throw fail('file_conflict','文件已变化，草稿仍保留。');
   const next={rootId:record.rootId,revision:await reviewHashText(input.text),text:input.text};store(key,next);
   const saved={type:'saved',...result,key:input.key,rootId:next.rootId,revision:next.revision};store(':op:'+input.key,{digest,result:saved});return saved;
  }
  const commentsKey=`:comments:${input.file}:${input.version}`,comments=load(commentsKey)||[];
  if(input.type==='comments')return {type:'comments',...result,version:input.version,comments};
  const comment={id:input.key,authorId:scope.userId||'local',authorName:'你',version:input.version,side:input.side,line:input.line,quote:input.quote,text:input.text,createdAt:new Date().toISOString()};
  store(commentsKey,[...comments.filter(c=>c.id!==comment.id),comment]);const saved={type:'comment',...result,key:input.key,comment};store(':op:'+input.key,{digest,result:saved});return saved;
 }
 return {
  draftPrefix:prefix+':tab:'+tabId, simulated:mock,
  async seedFile(file,text){if(!mock)return;const key=`:file:${file}`;if(!load(key))store(key,{text,revision:await reviewHashText(text),rootId:await reviewHashText(prefix)});},
  async request(raw){
   scopeCheck();const input=reviewRequestSchema.parse({...raw,workspaceId:scope.workspaceId,roomId:scope.roomId});
   if(client.read().connection!=='live')throw fail('offline','连接已断开，草稿仍保留，恢复连接后可重试。');
   let value;
   if(mock)value=await mockRequest(input);
   else if(typeof client.review==='function')value=await client.review(input);
   else throw fail('editing_unavailable','当前宿主尚未启用文件审阅服务。');
   scopeCheck();const result=reviewResultSchema.parse(value);
   if(result.workspaceId!==input.workspaceId||result.roomId!==input.roomId||result.file!==input.file||('key'in result&&result.key!==input.key)||('version'in result&&result.version!==input.version))throw fail('invalid_response','文件审阅响应范围不匹配。');
   if(result.type==='file'&&await reviewHashText(result.text)!==result.revision)throw fail('invalid_response','文件校验失败。');
   return result;
  }
 };
}
