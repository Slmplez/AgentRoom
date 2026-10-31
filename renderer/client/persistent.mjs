import { curationCommandTypes, curationCommandSchema, curationQueryTypes, curationQuerySchema, curationQueryResults, curationReceiptSchema } from '../../contracts/memory-curation-api.mjs';
import { formCommandTypes, formCommandSchema, formQuerySchema, formStateSchema, formResponsesSchema } from '../../contracts/forms.mjs';
import { attachmentCommandTypes, attachmentCommandSchema, uploadAttachmentSchema, attachmentQuerySchema, attachmentSchema, pendingAttachmentsSchema, attachmentLimits } from '../../contracts/attachments.mjs';
import { localExecutionCommandSchema } from '../../contracts/local-execution.mjs';
import { memoryCommandSchema, memoryCommandTypes, memoryQuerySchema, memoryQueryResults, memoryQueryTypes, memoryReceiptSchema, scopeForMemory, sameMemoryScope } from '../../contracts/agent-memory.mjs';
import { taskContextQuerySchema, taskContextResultSchema } from '../../contracts/run-context.mjs';
import { consultationCommandSchema, consultationCommandTypes, consultationQuerySchema, consultationSchema } from '../../contracts/consultations.mjs';
import { runContextSnapshotSchema } from '../../contracts/run-context.mjs';
import { clientError } from '../../contracts/chat.mjs';
import { persistenceBootstrapSchema, persistenceSnapshotSchema, persistenceReceiptSchema, persistenceFrameSchema, persistenceCommandSchema, persistenceHistorySchema } from '../../contracts/persistence.mjs';

// A transport and an already-submitted-command journal, never a second message store.
// backendId/localUserId are stable identities supplied by the trusted host, not a session token/port.
export function createPersistentTransport({ session, backendId, localUserId, storage = globalThis.localStorage, fetch: fetcher = globalThis.fetch }) {
  if (typeof session !== 'function' || !backendId || !localUserId || !storage?.getItem || !storage?.setItem || !storage?.removeItem || !storage?.key) throw new Error('Persistent transport requires a trusted session and durable user-scoped storage.');
  let active;
  const isMemory = command => memoryCommandTypes.includes(command?.type);
  const isCuration = command => curationCommandTypes.includes(command?.type);
  const isScopedMemory = command => isMemory(command) || isCuration(command);
  const isConsultation = command => consultationCommandTypes.includes(command?.type);
  const receiptFor = command => isCuration(command) ? curationReceiptSchema : isMemory(command) ? memoryReceiptSchema : persistenceReceiptSchema;
  const parseCommand = value => { if (isCuration(value)) return curationCommandSchema.safeParse(value); if(formCommandTypes.includes(value?.type))return formCommandSchema.safeParse(value); if (attachmentCommandTypes.includes(value?.type)) return attachmentCommandSchema.safeParse(value); if (isConsultation(value)) return consultationCommandSchema.safeParse(value); if (isMemory(value)) return memoryCommandSchema.safeParse(value); const original = persistenceCommandSchema.safeParse(value); return original.success ? original : localExecutionCommandSchema.safeParse(value); };
  const routeFor = command => isCuration(command) ? '/memory-curation/commands' : formCommandTypes.includes(command.type)?'/forms/commands':attachmentCommandTypes.includes(command.type) ? `/rooms/${encodeURIComponent(command.roomId)}/attachments${command.type==='removeAttachment'?`/${encodeURIComponent(command.attachmentId)}/remove`:''}` : isConsultation(command) ? '/consultations/commands' : isMemory(command) ? '/agent-memory/commands' : `/rooms/${encodeURIComponent(command.roomId)}/` + (command.type === 'sendDiscussion' ? 'messages' : command.type === 'createLocalTask' ? 'local-tasks' : `local-tasks/${encodeURIComponent(command.taskId)}/answers`);
  function commandBody(command) { if(command.type==='removeAttachment') return {workspaceId:command.workspaceId}; if (isScopedMemory(command) || isConsultation(command) || formCommandTypes.includes(command.type)) { const { key, ...body } = command; return body; } const { type, key, roomId, taskId, ...body } = command; return body; }
  function validateReceipt(command, receipt) {
    if (isCuration(command)) {
      if (receipt.type !== command.type || !sameMemoryScope(command.scope, receipt.scope) || (command.type === 'configureMemoryCuration' ? receipt.revision !== command.expectedRevision + 1 || receipt.enabled !== command.enabled : receipt.runId !== command.runId)) throw clientError('invalid_response', '整理回执范围或修订不匹配。', 'unknown');
      return;
    }
    if(formCommandTypes.includes(command.type)) {
      const form=receipt.form;
      if(!form || form.artifactId!==command.artifactId || form.version!==command.version || form.roomId!==command.roomId || (command.type==='submitForm'?form.responseRevision!==command.expectedResponseRevision+1:form.responseRevision!==command.responseRevision||form.status!=='pending'))throw clientError('invalid_response','表单回执范围或修订不匹配。','unknown');return;
    }

    if(attachmentCommandTypes.includes(command.type)) {
      const a=receipt.attachment;
      if(receipt.roomId!==command.roomId || !a || a.roomId!==command.roomId || (command.type==='uploadAttachment' ? a.name!==command.name || a.size!==command.size || a.sha256!==command.sha256 || a.status!=='pending' : a.id!==command.attachmentId || a.status!=='deleted')) throw clientError('invalid_response','附件回执范围不匹配。','unknown');
      return;
    }

    if (isConsultation(command)) { if (receipt.roomId !== command.roomId || !receipt.consultationId || (command.consultationId && receipt.consultationId !== command.consultationId)) throw clientError('invalid_response', '咨询回执范围不匹配。', 'unknown'); return; }
    if (isMemory(command)) {
      if (!sameMemoryScope(scopeForMemory(command), receipt.scope) || receipt.entityKind !== (command.type === 'editAgentSoul' ? 'soul' : 'memory') || (command.agentId && receipt.entityId !== command.agentId) || (command.memoryId && receipt.entityId !== command.memoryId) || receipt.status !== (command.type === 'forgetExplicitMemory' ? 'deleted' : 'active') || (command.expectedRevision !== undefined && receipt.revision !== command.expectedRevision + 1)) throw clientError('invalid_response', '记忆回执范围或版本不匹配。', 'unknown');
      return;
    }
    if (receipt.roomId !== command.roomId || (command.taskId && receipt.taskId !== command.taskId) || (command.type !== 'sendDiscussion' && !receipt.taskId)) throw clientError('invalid_response', '回执范围不匹配。', 'unknown');
  }

  const controllers = new Set();
  const journalPrefix = boot => 'agentroom:submitted:v1:' + JSON.stringify([localUserId, backendId, boot.databaseId, boot.user.id]) + ':';
  const journalKey = (boot, key) => journalPrefix(boot) + JSON.stringify(key);
  function readJournal(boot) {
    try {
      const items = [], prefix = journalPrefix(boot);
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const raw = storage.getItem(key); if (raw === null) continue;
        const item = JSON.parse(raw), parsed = parseCommand(item.command);
        if (!parsed.success || !['sendDiscussion', 'createLocalTask', 'answerLocalQuestion', ...formCommandTypes, ...attachmentCommandTypes, ...memoryCommandTypes, ...curationCommandTypes, ...consultationCommandTypes].includes(item.command.type) || item.databaseId !== boot.databaseId || item.command.workspaceId !== boot.workspace.id || key !== journalKey(boot, item.command.key) || !['unknown', 'not_found'].includes(item.outcome)) throw new Error('Invalid journal entry.');
        items.push(item);
      }
      return items;
    } catch { throw clientError('journal_invalid', '待核查记录不可读，已停止发送。'); }
  }
  function pending(context) {
    if (active !== context || context.controller.signal.aborted) return;
    context.emit({ type: 'persistence.pending', data: readJournal(context.boot).map(item => ({ key: item.command.key, type: item.command.type === 'sendDiscussion' ? 'send' : item.command.type, taskId: item.command.taskId, consultationId: item.command.consultationId, roomId: item.command.roomId, memoryScope: isScopedMemory(item.command) ? scopeForMemory(item.command) : undefined, artifactId:item.command.artifactId, version:item.command.version, name: item.command.name, attachmentId: item.command.attachmentId, entityId: item.command.memoryId || item.command.agentId, databaseId: item.databaseId, outcome: item.outcome })) });
  }
  function update(context, key, value) {
    // One durable key per submitted command: separate windows cannot overwrite each other's list.
    try {
      if (value) storage.setItem(journalKey(context.boot, key), JSON.stringify(value));
      else storage.removeItem(journalKey(context.boot, key));
    } catch { throw clientError('journal_unavailable', '无法保存待核查记录，请检查本地存储。'); }
    pending(context);
  }
  async function response(context, route, { command, query, signal = context.controller.signal, stream = false, binary } = {}) {
    let res;
    try {
      res = await fetcher(context.credentials.origin + '/api/v1' + route, {
        method: command || query ? 'POST' : 'GET',
        redirect: 'error',
        credentials: 'same-origin',
        headers: { ...(context.credentials.authentication === 'cookie' ? {} : { Authorization: 'Bearer ' + context.credentials.token }), ...(command || query ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}), ...(command ? { 'Idempotency-Key': command.key } : {}), ...(binary ? {'X-Attachment-Name':encodeURIComponent(command.name),'X-Workspace-Id':command.workspaceId,'X-Content-Sha256':command.sha256} : {}) },
        body: binary || (command || query ? JSON.stringify(command ? commandBody(command) : query) : undefined),
        signal: stream ? signal : AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch { throw clientError('transport_unavailable', '连接中断，请核查原请求。', command ? 'unknown' : 'rejected'); }
    if (!res.ok) {
      let data;
      try { data = await res.json(); } catch { throw clientError('invalid_response', '服务端响应无效。', command ? 'unknown' : 'rejected'); }
      throw clientError(data.code || 'unavailable', data.message || '请求失败。', command ? data.outcome || 'unknown' : 'rejected');
    }
    return res;
  }
  async function json(context, route, schema, options) {
    const res = await response(context, route, options);
    try { return schema.parse(await res.json()); }
    catch { throw clientError('invalid_response', '服务端响应不符合持久消息契约。', options?.command ? 'unknown' : 'rejected'); }
  }
  async function check(context, key, commandType = 'sendDiscussion') {
    if (!['sendDiscussion', 'createLocalTask', 'answerLocalQuestion', ...formCommandTypes, ...attachmentCommandTypes, ...memoryCommandTypes, ...curationCommandTypes, ...consultationCommandTypes].includes(commandType)) throw clientError('invalid_command', '未知的请求类型。');
    const entry = readJournal(context.boot).find(item => item.command.key === key);
    try {
      const receipt = await json(context, '/operations?' + new URLSearchParams({ workspaceId: entry?.command.workspaceId || context.boot.workspace.id, commandType: entry?.command.type || commandType, key }), receiptFor(entry?.command || { type: commandType }));
      if (entry) validateReceipt(entry.command, receipt);
      if (entry) update(context, key, null); return receipt;
    } catch (error) {
      if (error.code !== 'not_found') throw error;
      if (entry) update(context, key, { ...entry, outcome: 'not_found' }); return null;
    }
  }
  async function consume(context, res) {
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) { await res.body?.cancel(); throw clientError('invalid_response', '订阅响应无效。'); }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!context.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) throw clientError('transport_unavailable', '实时连接已关闭。');
        buffer += decoder.decode(value, { stream: true });
        // The server bounds each message. Also bound an incomplete/untrusted frame.
        if (buffer.length > 1024 * 1024) throw clientError('invalid_response', '订阅帧过大。');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (lines.includes('event: error')) throw clientError(JSON.parse(data).code, '订阅需要恢复。');
          const parsed = persistenceFrameSchema.parse(JSON.parse(data));
          if (!context.controller.signal.aborted) context.emit({ type: 'persistence.frame', data: parsed });
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function synchronize(scope, emit, resume) {
    active?.controller.abort();
    const context = { controller: new AbortController(), emit, scope: { ...scope } };
    active = context;
    const ready = (async () => {
      if (!scope.roomId) throw clientError('invalid_scope', '持久讨论同步需要明确房间。');
      context.credentials = await session();
      if (context.controller.signal.aborted) return;
      const origin = new URL(context.credentials.origin);
      const cookieSession = context.credentials.authentication === 'cookie' && origin.origin === globalThis.location?.origin;
      if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== context.credentials.origin || !(cookieSession || /^[a-f0-9]{64}$/.test(context.credentials.token))) throw clientError('invalid_session', '本机会话配置无效。');
      context.boot = await json(context, '/bootstrap', persistenceBootstrapSchema);
      if (context.controller.signal.aborted) return;
      if (scope.workspaceId && scope.workspaceId !== context.boot.workspace.id) throw clientError('not_found', '工作区不可访问。');
      const matching = resume?.databaseId === context.boot.databaseId && resume.roomId === scope.roomId;
      emit({ type: 'persistence.identity', backendId, data: context.boot, changed: !!resume && !matching });
      // Only query previous explicit submissions; never execute them during recovery.
      for (const entry of readJournal(context.boot)) {
        if (context.controller.signal.aborted) return;
        await check(context, entry.command.key);
      }
      pending(context);
      let cursor = matching ? resume.cursor : null;
      if (!cursor) {
        const data = await json(context, `/rooms/${encodeURIComponent(scope.roomId)}/snapshot`, persistenceSnapshotSchema);
        if (context.controller.signal.aborted) return;
        if (data.databaseId !== context.boot.databaseId || data.room.id !== scope.roomId || data.room.workspaceId !== context.boot.workspace.id) throw clientError('invalid_response', '快照范围不匹配。');
        if (data.consultations.some(q => q.roomId !== scope.roomId) || data.localTasks.some(t => t.roomId !== scope.roomId)) throw clientError('invalid_response', '任务快照范围不匹配。');
        emit({ type: 'persistence.snapshot', data, boot: context.boot });
        cursor = data.cursor;
      }
      const res = await response(context, '/events?' + new URLSearchParams({ roomId: scope.roomId, after: cursor }), { stream: true });
      if (context.controller.signal.aborted) { await res.body?.cancel(); return; }
      emit({ type: 'persistence.ready', data: context.boot });
      void consume(context, res).catch(error => {
        if (!context.controller.signal.aborted) { context.controller.abort(); emit({ type: error.code === 'resync_required' ? 'resync_required' : 'offline', error }); }
      });
    })();
    return { ready, close() { context.controller.abort(); if (active === context) { active = undefined; for (const controller of controllers) controller.abort(); } } };
  }
  return {
    synchronize,
    async query(input) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      if(['formState','formResponses'].includes(input.type)) {
        const q=formQuerySchema.parse(input);if(q.roomId!==context.scope.roomId)throw clientError('invalid_scope','表单不属于当前房间。');
        const data=await json(context,'/forms/query',q.type==='formState'?formStateSchema:formResponsesSchema,{query:q});
        if(active!==context || context.controller.signal.aborted)throw clientError('stale_query','表单读取范围已变化。');
        if(data.artifactId!==q.artifactId || data.version!==q.version || data.roomId!==q.roomId)throw clientError('invalid_response','表单响应范围不匹配。');return data;
      }
      if (['attachment','pendingAttachments'].includes(input.type)) {
        const q=attachmentQuerySchema.parse(input);
        if(q.roomId!==context.scope.roomId || !context.boot.capabilities.attachments) throw clientError('invalid_scope','附件读取范围不匹配。');
        const route=`/rooms/${encodeURIComponent(q.roomId)}/attachments`;
        const data=await json(context,q.type==='attachment'?`${route}/${encodeURIComponent(q.attachmentId)}`:`${route}?`+new URLSearchParams({limit:q.limit,...(q.afterId?{afterId:q.afterId}:{})}),q.type==='attachment'?attachmentSchema:pendingAttachmentsSchema);
        if(active!==context || context.controller.signal.aborted) throw clientError('stale_query','附件读取范围已变化。');
        if((q.type==='attachment'?[data]:data.attachments).some(a=>a.roomId!==q.roomId || q.type==='attachment' && a.id!==q.attachmentId)) throw clientError('invalid_response','附件响应范围不匹配。');
        return data;
      }
      if (['consultations','consultation','consultationContext'].includes(input.type)) {
        const q = consultationQuerySchema.parse(input);
        if (q.roomId !== context.scope.roomId) throw clientError('invalid_scope', '咨询读取范围不匹配。');
        const data = await json(context, '/consultations/query', q.type === 'consultationContext' ? runContextSnapshotSchema : q.type === 'consultations' ? consultationSchema.array() : consultationSchema, { query: q });
        if (active !== context || context.controller.signal.aborted) throw clientError('stale_query', '咨询读取范围已变化。');
        if (q.type === 'consultationContext' ? data.roomId !== q.roomId || data.taskId !== q.assignmentId : q.type === 'consultation' ? data.roomId !== q.roomId || data.id !== q.consultationId : data.some(item => item.roomId !== q.roomId)) throw clientError('invalid_response', '咨询响应范围不匹配。');
        return data;
      }
      if (curationQueryTypes.includes(input.type)) {
        if (!context.boot.capabilities.memoryCuration) throw clientError('unsupported', '当前后端不支持后台整理。');
        const q = curationQuerySchema.parse(input);
        if (q.workspaceId !== context.boot.workspace.id || (q.scope.kind === 'room' ? q.scope.roomId !== context.scope.roomId : !context.boot.knownAgents.includes(q.scope.agentId))) throw clientError('invalid_scope', '整理归属不匹配。');
        const data = await json(context, '/memory-curation/query', curationQueryResults[q.type], { query: q });
        if (active !== context || context.controller.signal.aborted) throw clientError('stale_query', '整理读取范围已变化。');
        if (q.type === 'memoryCurationHistory' && data.runs.some(run => !sameMemoryScope(run.input.scope, q.scope))) throw clientError('invalid_response', '整理历史归属不匹配。');
        return data;
      }
      if (memoryQueryTypes.includes(input.type) || input.type === 'taskContextSnapshot') {
        if (!context.boot.capabilities.agentMemory) throw clientError('unsupported', '当前后端不支持记忆管理。');
        const task = input.type === 'taskContextSnapshot';
        const q = (task ? taskContextQuerySchema : memoryQuerySchema).parse(input);
        if (task ? q.roomId !== context.scope.roomId : q.workspaceId !== context.boot.workspace.id || (q.scope?.kind === 'room' && q.scope.roomId !== context.scope.roomId) || ((q.agentId || q.scope?.agentId) && !context.boot.knownAgents.includes(q.agentId || q.scope.agentId))) throw clientError('invalid_scope', '记忆读取范围不匹配。');
        const data = await json(context, task ? `/rooms/${encodeURIComponent(q.roomId)}/local-tasks/${encodeURIComponent(q.taskId)}/context` : '/agent-memory/query', task ? taskContextResultSchema : memoryQueryResults[q.type], task ? undefined : { query: q });
        if (active !== context || context.controller.signal.aborted) throw clientError('stale_query', '记忆读取范围已变化。');
        const bad = task ? (data.status === 'available' ? data.snapshot.taskId !== q.taskId || data.snapshot.roomId !== q.roomId : data.taskId !== q.taskId)
          : q.agentId ? data.agentId !== q.agentId
          : q.type === 'explicitMemories' ? !sameMemoryScope(data.scope, q.scope) || data.memories.some(m => !sameMemoryScope(m.scope, q.scope) || m.status !== 'active')
          : data.current.id !== q.memoryId || !sameMemoryScope(data.current.scope, q.scope);
        if (bad) throw clientError('invalid_response', '记忆结果范围不匹配。');
        return data;
      }
      if (!['artifact', 'artifactVersions'].includes(input.type) || !context.boot.capabilities.readOnlyArtifacts) throw clientError('unsupported', '当前后端不支持报告读取。');
      if (input.roomId !== context.scope.roomId) throw clientError('invalid_scope', '报告不属于当前房间。');
      const { artifactQuerySchema, artifactVersionSchema, artifactVersionsSchema } = await import('../../contracts/artifacts.mjs');
      const q = artifactQuerySchema.parse(input);
      const route = `/rooms/${encodeURIComponent(q.roomId)}/artifacts/${encodeURIComponent(q.artifactId)}/versions`;
      let data;
      try { data = await json(context, q.type === 'artifact' ? `${route}/${q.version}` : `${route}?` + new URLSearchParams({ limit: q.limit, ...(q.beforeVersion ? { beforeVersion: q.beforeVersion } : {}) }), q.type === 'artifact' ? artifactVersionSchema : artifactVersionsSchema); }
      catch (error) { if (active !== context || context.controller.signal.aborted) throw clientError('stale_query', '报告读取范围已变化。'); throw error; }
      if (active !== context || context.controller.signal.aborted) throw clientError('stale_query', '报告读取范围已变化。');
      if ((q.type === 'artifact' ? [data] : data.versions).some(v => v.roomId !== q.roomId || v.artifactId !== q.artifactId || (q.type === 'artifact' && v.version !== q.version))) throw clientError('invalid_response', '报告版本或范围不匹配。');
      return data;
    },
    async history({ roomId, beforeSequence, upperBound, limit = 100 }) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      if (roomId !== context.scope.roomId) throw clientError('invalid_scope', '历史范围已变化。');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw clientError('invalid_request', '每页消息数必须为 1–200。');
      const data = await json(context, `/rooms/${encodeURIComponent(roomId)}/messages?` + new URLSearchParams({ beforeSequence, upperBound, limit }), persistenceHistorySchema);
      if (data.databaseId !== context.boot.databaseId || data.roomId !== roomId || data.roomSequenceUpperBound !== upperBound || (data.beforeSequence !== null && data.beforeSequence >= beforeSequence) || data.messages.some(m => m.roomId !== roomId || m.sequence >= beforeSequence || m.sequence > upperBound)) throw clientError('invalid_response', '历史页范围不匹配。');
      return data;
    },
    async command(input) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      const form=formCommandTypes.includes(input.type);
      if(form && !context.boot.capabilities.forms)throw clientError('unsupported','当前后端未启用表单答复。');
      const attachment=input.type==='removeAttachment';
      const local = ['createLocalTask', 'answerLocalQuestion'].includes(input.type);
      const memory = isScopedMemory(input);
      if (isCuration(input) && !context.boot.capabilities.memoryCuration) throw clientError('unsupported', '当前后端不支持后台整理。');
      const consultation = isConsultation(input);
      if (consultation && !context.boot.capabilities.consultations) throw clientError('unsupported', '本机咨询尚未启用。');
      if (memory && !context.boot.capabilities.agentMemory) throw clientError('unsupported', '当前后端未启用记忆管理。');
      if (local && !context.boot.capabilities.localExecution) throw clientError('unsupported', '本机执行尚未启用。');
      if (!form && !attachment && !consultation && !memory && !local && (input.type !== 'send' || input.mode !== 'discussion' || input.mentions?.length || input.ownerAgentId)) throw clientError('unsupported', '持久后端仅支持普通讨论消息。');
      if (!memory && input.roomId !== context.scope.roomId) throw clientError('invalid_scope', '只能向当前房间发送。');
      const command = isCuration(input) ? curationCommandSchema.parse(input) : form ? formCommandSchema.parse(input) : attachment ? attachmentCommandSchema.parse(input) : consultation ? consultationCommandSchema.parse(input) : memory ? memoryCommandSchema.parse(input) : local ? localExecutionCommandSchema.parse(input) : { type: 'sendDiscussion', key: input.key, workspaceId: context.boot.workspace.id, roomId: input.roomId, text: input.text, attachmentIds: input.attachmentIds || [], replyToId: null };
      if(form && readJournal(context.boot).some(e=>e.command.key!==command.key && formCommandTypes.includes(e.command.type) && e.command.artifactId===command.artifactId && e.command.version===command.version))throw clientError('outcome_unknown','原表单操作结果待核查，不会换标识重复提交。','unknown');
      if (consultation && readJournal(context.boot).some(e => e.command.key !== command.key && isConsultation(e.command) && e.command.roomId === command.roomId && (command.type === 'createConsultation' || e.command.type === 'createConsultation' || command.consultationId === e.command.consultationId))) throw clientError('outcome_unknown', '此前咨询请求结果待核查，不能换标识重复提交。', 'unknown');
      if (command.workspaceId !== context.boot.workspace.id) throw clientError('invalid_scope', '工作区已变化。');
      if (memory) {
        const scope = scopeForMemory(command);
        if (scope.kind === 'room' ? scope.roomId !== context.scope.roomId : !context.boot.knownAgents.includes(scope.agentId)) throw clientError('invalid_scope', '记忆归属不匹配。');
        // Serialize unresolved writes within one memory scope, including across reloads/windows.
        if (readJournal(context.boot).some(e => e.command.key !== command.key && isScopedMemory(e.command) && sameMemoryScope(scopeForMemory(e.command), scope))) throw clientError('outcome_unknown', '此前记忆请求结果待核查，不能换标识重复提交。', 'unknown');
      }
      if (local && readJournal(context.boot).some(e => e.command.key !== command.key && e.command.type !== 'sendDiscussion' && e.command.roomId === command.roomId && (command.type === 'createLocalTask' || e.command.type === 'createLocalTask' || command.taskId === e.command.taskId))) throw clientError('outcome_unknown', '此前任务请求结果待核查，不能换标识重复提交。', 'unknown');
      const previous = readJournal(context.boot).find(item => item.command.key === command.key);
      if (previous) {
        if (JSON.stringify(parseCommand(previous.command).data) !== JSON.stringify(parseCommand(command).data)) throw clientError('idempotency_conflict', '待核查请求内容不能改变。');
        const receipt = await check(context, command.key);
        if (receipt) return receipt;
      }
      const entry = { databaseId: context.boot.databaseId, command, outcome: 'unknown' };
      // Save before network submission, including the page/process-crash window.
      update(context, command.key, entry);
      const controller = new AbortController(); controllers.add(controller);
      try {
        const receipt = await json(context, routeFor(command), receiptFor(command), { command, signal: controller.signal });
        validateReceipt(command, receipt);
        try { update(context, command.key, null); }
        catch { throw clientError('journal_unavailable', '消息已提交，但本地回执未保存；请核查原请求。', 'unknown'); }
        return receipt;
      } catch (error) {
        if (error.outcome !== 'unknown') update(context, command.key, null);
        throw error;
      } finally { controllers.delete(controller); }
    },
    async uploadAttachment({key,roomId,name,file,signal}) {
      const context=active;
      if(!context?.boot || context.controller.signal.aborted || !context.boot.capabilities.attachments || roomId!==context.scope.roomId) throw clientError('unavailable','附件上传连接不可用。');
      if(!(file instanceof Blob) || file.size<1 || file.size>attachmentLimits.fileBytes) throw clientError('invalid_attachment','请选择 1 byte–8 MiB 的文件。');
      const buffer=await file.arrayBuffer();
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
      const command=uploadAttachmentSchema.parse({type:'uploadAttachment',key,workspaceId:context.boot.workspace.id,roomId,name,size:buffer.byteLength,sha256});
      if(active!==context || context.controller.signal.aborted || signal?.aborted) throw clientError('cancelled','上传已取消，尚未提交。');
      if(readJournal(context.boot).some(e=>e.command.type==='uploadAttachment' && e.command.roomId===roomId && e.command.key!==key)) throw clientError('outcome_unknown','请先核查原附件上传。','unknown');
      const previous=readJournal(context.boot).find(e=>e.command.key===key);
      if(previous) {
        if(JSON.stringify(previous.command)!==JSON.stringify(command)) throw clientError('idempotency_conflict','重选文件与原上传的名称、大小或摘要不一致。');
        const receipt=await check(context,key,'uploadAttachment'); if(receipt) return receipt;
      }
      if(active!==context || context.controller.signal.aborted || signal?.aborted) throw clientError('cancelled','上传已取消，尚未提交。');
      update(context,key,{databaseId:context.boot.databaseId,command,outcome:'unknown'});
      const controller=new AbortController(); controllers.add(controller);
      try {
        const receipt=await json(context,routeFor(command),persistenceReceiptSchema,{command,binary:new Uint8Array(buffer),signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
        validateReceipt(command,receipt); update(context,key,null); return receipt;
      } catch(error) { if(error.outcome!=='unknown') update(context,key,null); throw error; }
      finally {controllers.delete(controller);}
    },
    async downloadAttachment({roomId,attachmentId}) {
      const context=active;
      if(!context?.boot || context.controller.signal.aborted || roomId!==context.scope.roomId || !context.boot.capabilities.attachments) throw clientError('unavailable','附件下载连接不可用。');
      const metadata=await this.query({type:'attachment',roomId,attachmentId});
      const res=await response(context,`/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/content`);
      if(res.headers.get('content-type')!=='application/octet-stream' || !res.headers.get('content-disposition')?.startsWith('attachment;') || Number(res.headers.get('content-length'))!==metadata.size) {await res.body?.cancel();throw clientError('invalid_response','附件下载响应无效。');}
      const reader=res.body.getReader(), chunks=[]; let size=0;
      try {for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>metadata.size)throw clientError('invalid_response','附件大小不匹配。');chunks.push(value);}} finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      const blob=new Blob(chunks,{type:'application/octet-stream'});
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
      if(size!==metadata.size || sha256!==metadata.sha256) throw clientError('attachment_unavailable','附件内容缺失或损坏。');
      if(active!==context || context.controller.signal.aborted) throw clientError('stale_query','附件读取范围已变化。');
      return {metadata,blob};
    },
    pendingMemoryOperations({workspaceId, scope}) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted || workspaceId !== context.boot.workspace.id) throw clientError('unavailable', '原请求日志连接不可用。');
      return readJournal(context.boot).filter(item => isScopedMemory(item.command) && sameMemoryScope(scopeForMemory(item.command), scope)).map(item => ({key: item.command.key, outcome: item.outcome}));
    },
    async checkOperation(key, commandType) {
      if (!active?.boot || active.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      return check(active, key, commandType);
    },
    async retryOperation(key) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      const entry = readJournal(context.boot).find(item => item.command.key === key);
      if (!entry) throw clientError('not_found', '没有待重试的原请求，请先核查消息记录。');
      if (!isScopedMemory(entry.command) && entry.command.roomId !== context.scope.roomId) throw clientError('invalid_scope', '原请求不属于当前房间。');
      if (entry.outcome !== 'not_found') throw clientError('outcome_unknown', '请先核查原请求。', 'unknown');
      if(entry.command.type==='uploadAttachment') throw clientError('file_required','请重新选择相同文件，再使用原标识明确重试。');
      if (entry.command.type !== 'sendDiscussion') return this.command(entry.command);
      return this.command({ type: 'send', key, roomId: entry.command.roomId, text: entry.command.text, attachmentIds: entry.command.attachmentIds, mode: 'discussion', mentions: [], ownerAgentId: null });
    },
  };
}
