import path from 'node:path';
import { createFileReviewService } from './service.mjs';
import { reviewFailure as fail } from '../../contracts/file-review.mjs';
// Assembly seam: the owner of shared HTTP/Client files installs this after handoff.
// editorWorkspace is a separate trusted host option, never inferred from read-only execution.
export function createRuntimeFileReview(runtime,{directory,editorWorkspace}) {
 return createFileReviewService({directory:path.join(directory,'file-review'),resolveScope(input,caller){
  const boot=runtime.query({type:'bootstrap'},caller);
  if(boot.workspace.id!==input.workspaceId)throw fail('forbidden','工作区不可访问。');
  runtime.query({type:'snapshot',roomId:input.roomId},caller);
  if(input.type==='saveFile'){
   const rooms=runtime.query({type:'rooms',workspaceId:input.workspaceId},caller);
   if(rooms.length>=200)throw fail('workspace_busy','当前房间数量超出可安全核查范围，已暂停编辑。');
   for(const room of rooms){
    const snapshot=runtime.query({type:'snapshot',roomId:room.id},caller);
    if(snapshot.localTasks.length>=100)throw fail('workspace_busy','执行历史超出可安全核查范围，已暂停编辑。');
    if(snapshot.localTasks.some(task=>task.leaseHeld||['queued','dispatching','running','awaiting_input','answer_pending','submitting','unknown'].includes(task.phase)))throw fail('workspace_busy','工作区有尚未确认停止的 Agent 执行，已保留草稿并暂停保存。');
   }
  }
  return {workspaceId:boot.workspace.id,roomId:input.roomId,authorId:boot.user.id,authorName:boot.user.name,root:editorWorkspace,canWrite:Boolean(editorWorkspace)};
 }});
}
