import { curationCommandTypes, curationCommandSchema, curationQueryTypes, curationQuerySchema, curationReceiptSchema } from '../../contracts/memory-curation-api.mjs';
import { memoryCurationRuntime } from './memory-curation-runtime.mjs';
import { forms } from './forms.mjs';
import { formPublishSchema, formCommandSchema, formCommandTypes, formQuerySchema } from '../../contracts/forms.mjs';
import { attachments, validateAttachmentBytes } from './attachments.mjs';
import { attachmentCommandSchema, attachmentQuerySchema, uploadAttachmentSchema } from '../../contracts/attachments.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { persistenceCommandSchema, persistenceQuerySchema, persistenceMessageSchema, persistenceReceiptSchema, persistenceError as fail } from '../../contracts/persistence.mjs';
import { openStorage } from './storage.mjs';
import { localExecutionCommandSchema, localExecutionQuerySchema } from '../../contracts/local-execution.mjs';
import { localExecution } from './local-execution.mjs';
import { artifacts } from './artifacts.mjs';
import { artifactPublishSchema, artifactQuerySchema } from '../../contracts/artifacts.mjs';
import { memoryCommandTypes, memoryCommandSchema, memoryQueryTypes, memoryQuerySchema, memoryReceiptSchema } from '../../contracts/agent-memory.mjs';
import { agentMemory } from './agent-memory.mjs';
import { taskContextQuerySchema } from '../../contracts/run-context.mjs';
import { consultationCommandSchema, consultationCommandTypes, consultationQuerySchema, consultationAgentSchema } from '../../contracts/consultations.mjs';
import { consultations } from './consultations.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function parse(schema, input) { const r = schema.safeParse(input); if (!r.success) throw fail('invalid_request', '请求不符合持久消息契约。'); return r.data; }
function message(row) {
  return persistenceMessageSchema.parse({ id: row.id, roomId: row.room_id, sequence: row.sequence, authorId: row.author_id, authorKind: row.author_kind, authorName: row.author_name_snapshot, role: row.author_kind==='agent'?'assistant':'user', text: row.text, status: 'complete', createdAt: row.created_at, revision: row.revision, tools: [], replyToId: row.reply_to_id, recipientIds: [], artifactRefs: JSON.parse(row.artifact_refs_json || '[]'), attachmentRefs: JSON.parse(row.attachment_refs_json || '[]') });
}

// fault is an internal test-assembly seam; it is never selected by HTTP or environment input.
export async function createApplicationRuntime({ directory, busyTimeoutMs = 5000, fault = () => {}, clock = Date.now, maintenanceIntervalMs = 60000, execution = null, memoryCurator = null, consultationAgents = [], consultationTiming = {}, knownAgents = [...new Set([...(execution ? [execution.agentId] : []), ...consultationAgents.map(a => a.id)])] }) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new Error('Invalid busy timeout.');
  if (typeof clock !== 'function' || !Number.isInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 10 || maintenanceIntervalMs > 60000) throw new Error('Invalid maintenance configuration.');
  const db = await openStorage(directory, busyTimeoutMs);
  const meta = () => db.prepare('SELECT * FROM database_meta WHERE singleton=1').get();
  const initial = meta(), instanceId = randomUUID();
  let closed = false;
  if (execution && (typeof execution.agentId !== 'string' || !execution.agentId || execution.agentId.length > 300 || typeof execution.createEngine !== 'function')) { db.close(); throw new Error('Invalid trusted execution configuration.'); }
  if (!Array.isArray(consultationAgents) || consultationAgents.length > 20 || new Set(consultationAgents.map(a => a.id)).size !== consultationAgents.length || consultationAgents.some(a => !consultationAgentSchema.safeParse(a).success || typeof a.createEngine !== 'function' || !knownAgents.includes(a.id))) { db.close(); throw Error('Invalid trusted consultation Agent registry.'); }
  if (!Array.isArray(knownAgents) || knownAgents.length > 100 || new Set(knownAgents).size !== knownAgents.length || knownAgents.some(id => typeof id !== 'string' || !id.trim() || id.length > 300 || db.prepare('SELECT kind FROM principals WHERE id=?').get(id)?.kind === 'human') || (execution && !knownAgents.includes(execution.agentId))) { db.close(); throw new Error('Invalid trusted Agent registry.'); }
  const agents = new Set(knownAgents);
  let commandTransaction = false;
  const curation = memoryCurationRuntime({ db, engine: memoryCurator, clock, checkpoint: fault,
    allowedScope(scope) { try { memoryScope(scope, { id: initial.owner_id }); return true; } catch { return false; } },
    atomic(action) {
      if (commandTransaction) return action();
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  });
  const memories = agentMemory(db, { curationContext: scope => curation.context(scope) });
  const reports = artifacts(db), files = attachments(db);
  const formStore=forms(db,{linkAttachments:files.link});
  let advice;
  function commitForm(taskId,mutation) { const t=local.read(taskId); return execute({type:'formFact',workspaceId:initial.workspace_id,roomId:t.roomId,taskId,key:randomUUID()},{principalId:initial.owner_id},mutation); }
  const local = localExecution({ db, configuration: execution, checkpoint: fault, agentBusy: id => advice?.occupied(id) || false, captureContext(task) {
    if (!execution || task.ownerAgentId !== execution.agentId || !agents.has(task.ownerAgentId)) throw fail('invalid_owner', '任务负责人不是宿主登记的执行 Agent。', 409);
    return memories.createRunContextSnapshot(task, new Date(clock()).toISOString());
  }, publishArtifact(taskId, incarnation, input) {
    const c = parse(artifactPublishSchema,input), t = local.read(taskId);
    return execute({ ...c, key: `${t.runId}:${c.key}`, type:'publishArtifact', taskId, workspaceId:initial.workspace_id, roomId:t.roomId }, {principalId:initial.owner_id}, null, {incarnation});
  }, publishForm(taskId,incarnation,input) {
    const c=parse(formPublishSchema,input),t=local.read(taskId);
    const receipt=execute({...c,key:`${t.runId}:${c.key}`,type:'publishForm',taskId,workspaceId:initial.workspace_id,roomId:t.roomId},{principalId:initial.owner_id},null,{incarnation,kind:'form'});
    return {artifactId:receipt.artifactId,version:receipt.artifactVersion,title:c.title,receipt};
  }, claimForm(taskId) {
    let payload;
    commitForm(taskId,t=>{const claimed=formStore.claim(t.formWait,t);payload=claimed.payload;t.phase='submitting';t.delivery='attempting';return claimed.wait;});
    return payload;
  }, acknowledgeForm(taskId,token) {
    return commitForm(taskId,t=>{const wait=formStore.acknowledge(t.formWait,t,token);if(t.phase==='submitting')t.phase='running';t.delivery='submitted';return wait;});
  }, expireForm(taskId) {
    const task=local.read(taskId),wait=formStore.read(task.formWait.artifactId,task.formWait.version,task.roomId);
    if(['submitted','expired','unknown'].includes(wait.status))return;
    return commitForm(taskId,t=>{const wait=formStore.expire(t.formWait,t);if(wait.status!=='submitted'){t.phase='unknown';if(t.delivery!=='none')t.delivery='unknown';}return wait;});
  }, commit(taskId, mutation) {
    const t = local.read(taskId);
    execute({ type: 'localFact', workspaceId: initial.workspace_id, roomId: t.roomId, taskId, key: randomUUID() }, { principalId: initial.owner_id }, mutation);
  } });
  advice = consultations({ db, agents: consultationAgents, clock, checkpoint: fault, ...consultationTiming,
    localBusy: id => local.busy(id),
    captureContext: task => memories.createRunContextSnapshot(task, new Date(clock()).toISOString(), { persist: false }),
    verifySource(roomId, source) { const t = local.read(source.taskId); if (t.roomId !== roomId || !local.canAnswer(t.id) || t.question.id !== source.questionId || t.question.revision !== source.questionRevision) throw fail('expired', '来源原生问题已失效。', 409); return { ...source, runId: t.runId, ownerAgentId: t.ownerAgentId, contextText: JSON.stringify({ taskGoal:t.goal, question:t.question.title, options:t.question.options }) }; },
    deliverSource(roomId, source, text, actor) { try { const t = local.read(source.taskId); if (t.runId !== source.runId || t.ownerAgentId !== source.ownerAgentId) return null; return local.apply({ type: 'answerLocalQuestion', roomId, taskId: t.id, questionId: source.questionId, expectedRevision: source.questionRevision, optionIds: [], text }, actor); } catch (e) { if (['expired','conflict','not_found','invalid_answer'].includes(e.code)) return null; throw e; } },
    commit(id, mutation) { const q = advice.read(id); execute({ type: 'consultationFact', workspaceId: initial.workspace_id, roomId: q.roomId, consultationId: id, key: randomUUID() }, { principalId: initial.owner_id }, mutation); },
  });
  const wakeups = new Set();
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  function pruneEvents() {
    if (closed) return;
    let writing = false;
    try {
      const cutoff = new Date(clock() - retentionMs).toISOString();
      db.exec('BEGIN IMMEDIATE'); writing = true;
      const m = meta();
      // A later expired timestamp cannot jump past an earlier fresh event (clock rollback).
      const barrier = db.prepare('SELECT MIN(position) AS position FROM events WHERE occurred_at>=?').get(cutoff).position;
      const through = barrier === null ? m.global_event_position : barrier - 1;
      if (through > m.pruned_through) {
        db.prepare('DELETE FROM events WHERE position<=?').run(through);
        db.prepare('UPDATE database_meta SET pruned_through=? WHERE singleton=1').run(through);
        fault('after_prune');
      }
      files.prune(new Date(clock()).toISOString());
      db.exec('COMMIT'); writing = false;
      if (through > m.pruned_through) for (const wake of wakeups) wake();
    } catch (error) {
      if (writing) { try { db.exec('ROLLBACK'); } catch {} }
      throw mappedError(error, false);
    }
  }
  // Host-only clock/scheduler seams; never configured by request bodies or URLs.
  try { pruneEvents(); } catch (error) { db.close(); throw error; }
  const maintenance = setInterval(() => {
    curation.schedule();
    try { pruneEvents(); } catch { console.warn('Persistent event retention postponed; will retry.'); }
  }, maintenanceIntervalMs);
  maintenance.unref?.();
  function authorize(caller) {
    if (closed) throw fail('unavailable', '后端已经关闭。', 503);
    const actor = db.prepare('SELECT * FROM principals WHERE id=?').get(caller?.principalId ?? '');
    if (!actor || actor.kind !== 'human') throw fail('forbidden', '调用身份不可用。', 403);
    return actor;
  }
  function workspace(id, actor) {
    if (id !== initial.workspace_id || actor.id !== initial.owner_id) throw fail('not_found', '工作区不可访问。', 404);
  }
  function room(id, actor) {
    const r = db.prepare('SELECT r.* FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE r.id=? AND m.principal_id=?').get(id, actor.id);
    if (!r) throw fail('not_found', '房间不可访问。', 404);
    return r;
  }
  function memoryScope(scope, actor) {
    if (scope.kind === 'agent') { if (!agents.has(scope.agentId)) throw fail('not_found', 'Agent 未在可信宿主登记。', 404); }
    else if (room(scope.roomId, actor).workspace_id !== initial.workspace_id) throw fail('not_found', '房间不可访问。', 404);
  }
  function cursor(roomId, position) { return Buffer.from(JSON.stringify([1, initial.database_id, roomId, position])).toString('base64url'); }
  function readCursor(value, roomId, high) {
    let parts;
    try { parts = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw fail('invalid_cursor', '游标无效。'); }
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 1 || !Number.isSafeInteger(parts[3]) || parts[3] < 0) throw fail('invalid_cursor', '游标无效。');
    if (parts[1] !== initial.database_id || parts[2] !== roomId || parts[3] < meta().pruned_through) throw fail('resync_required', '需要重新读取快照。', 409);
    if (parts[3] > high) throw fail('invalid_cursor', '游标超前。');
    return parts[3];
  }
  function mappedError(error, commitAttempted) {
    if (error.code && error.status) return error;
    if (error.errcode === 5 || error.errcode === 6) return fail('unavailable', '数据库繁忙，请使用原请求标识重试。', 503);
    return fail('storage_error', '存储操作失败，请核查原请求回执。', 500, commitAttempted ? 'unknown' : 'rejected');
  }
  function execute(input, caller, mutation = null, publication = null, binary = null) {
    const formCommand=formCommandTypes.includes(input?.type),formFact=mutation && input?.type==='formFact';
    const attachmentCommand = input?.type === 'removeAttachment' || binary !== null && input?.type === 'uploadAttachment';
    const localCommand = ['createLocalTask', 'answerLocalQuestion'].includes(input?.type);
    const consultationCommand = consultationCommandTypes.includes(input?.type), consultationFact = mutation && input?.type === 'consultationFact';
    const curationCommand = curationCommandTypes.includes(input?.type);
    const memoryCommand = memoryCommandTypes.includes(input?.type);
    if (!mutation && !publication && (input?.mode === 'task' || (input?.type && !['createRoom', 'sendDiscussion'].includes(input.type) && !localCommand && !curationCommand && !memoryCommand && !consultationCommand && !attachmentCommand && !formCommand))) throw fail('unsupported', '该命令不可用。', 422);
    const c = mutation || publication ? input : parse(curationCommand ? curationCommandSchema : formCommand ? formCommandSchema : attachmentCommand ? attachmentCommandSchema : consultationCommand ? consultationCommandSchema : memoryCommand ? memoryCommandSchema : localCommand ? localExecutionCommandSchema : persistenceCommandSchema, input);
    let inTransaction = false, commitAttempted = false;
    try {
      db.exec('BEGIN IMMEDIATE'); inTransaction = true; commandTransaction = true;
      const actor = authorize(caller); workspace(c.workspaceId, actor);
      if (memoryCommand || curationCommand) memoryScope(c.scope || { kind: 'agent', agentId: c.agentId }, actor);
      else if (c.type !== 'createRoom' && room(c.roomId, actor).workspace_id !== c.workspaceId) throw fail('not_found', '房间不可访问。', 404);
      const {attachmentIds,...legacyCommand}=c;
      const digest = hash(c.type==='sendDiscussion' && !attachmentIds?.length ? legacyCommand : c);
      const previous = db.prepare('SELECT * FROM command_receipts WHERE caller_id=? AND workspace_id=? AND command_type=? AND idempotency_key=?').get(actor.id, c.workspaceId, c.type, c.key);
      if (previous) {
        if (previous.request_hash !== digest) throw fail('idempotency_conflict', '该请求标识已用于不同内容。', 409);
        if (previous.room_id) room(previous.room_id, actor);
        db.exec('ROLLBACK'); inTransaction = false;
        return JSON.parse(previous.receipt_json);
      }
      const operationId = randomUUID(), now = new Date(clock()).toISOString();
      let roomId = c.roomId, messageId = null, sequence = null, taskId, consultationId, artifact, attachment, form, payload, eventType, revision;
      const extraEvents = [];
      if (curationCommand) {
        payload = curation.apply(c, operationId); roomId = c.scope.kind === 'room' ? c.scope.roomId : null;
        eventType = 'memoryCuration.updated'; revision = payload.revision || 1;
      } else if(formCommand || formFact) {
        let wait;
        if(formFact) {
          const task=local.apply(c,actor,t=>{wait=mutation(t);});taskId=task.id;extraEvents.push({type:'localTask.updated',payload:task});
        } else {
          const original=formStore.read(c.artifactId,c.version,roomId),live=local.formLive(original.taskId,original.incarnation,{artifactId:c.artifactId,version:c.version});
          taskId=original.taskId;
          if(c.type==='submitForm') {
            const result=formStore.submit(c,actor,now,live);wait=result.wait;
              const updated=db.prepare('UPDATE rooms SET last_message_sequence=last_message_sequence+1,revision=revision+1 WHERE id=? AND last_message_sequence<? AND revision<? RETURNING last_message_sequence').get(roomId,MAX,MAX);
            if(!updated)throw fail('sequence_exhausted','消息序号超出安全范围。',409);
            sequence=updated.last_message_sequence;messageId=randomUUID();
            const ref={artifactId:wait.artifactId,version:wait.version,title:wait.title,kind:'form',catalogVersion:1};
            db.prepare('INSERT INTO messages(id,room_id,sequence,author_id,author_kind,author_name_snapshot,text,created_at,artifact_refs_json,attachment_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(messageId,roomId,sequence,actor.id,'human',actor.display_name,`已提交“${wait.title}”答复（修订 ${wait.responseRevision}）。尚未继续任务。`,now,JSON.stringify([ref]),JSON.stringify(result.response.attachmentRefs));
            extraEvents.push({type:'message.created',payload:message(db.prepare('SELECT * FROM messages WHERE id=?').get(messageId))});
          } else {
            wait=formStore.continueWait(c,live);
            const task=local.apply({taskId},actor,t=>{t.phase='answer_pending';t.delivery='pending';});extraEvents.push({type:'localTask.updated',payload:task});
          }
        }
        form=formStore.view(wait,local.formLive(wait.taskId,wait.incarnation,{artifactId:wait.artifactId,version:wait.version}));payload=form;eventType='form.updated';revision=form.waitRevision;
      } else if (attachmentCommand) {
        attachment = c.type === 'uploadAttachment' ? files.upload(c,binary,actor,now) : files.remove(c,actor,now);
        payload=attachment; eventType='attachment.updated'; revision=attachment.revision;
      } else if (consultationCommand || consultationFact) {
        const result = advice.apply(c, actor, mutation); payload = result.question; consultationId = payload.id; eventType = 'consultation.updated'; revision = payload.revision;
        if (result.task) { taskId = result.task.id; extraEvents.push({ type: 'localTask.updated', payload: result.task }); for (const question of advice.sourceAnswered(result.task, actor)) extraEvents.push({ type: 'consultation.updated', payload: question }); }
        db.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').run(roomId);
      } else if (memoryCommand) {
        payload = memories.apply(c, actor, now);
        roomId = payload.scope.kind === 'room' ? payload.scope.roomId : null;
        eventType = payload.entityKind === 'soul' ? 'soul.updated' : 'memory.updated'; revision = payload.revision;
      } else if (c.type === 'createRoom') {
        roomId = randomUUID();
        db.prepare('INSERT INTO rooms(id,workspace_id,title) VALUES(?,?,?)').run(roomId, c.workspaceId, c.title);
        db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(roomId, actor.id, 'owner');
        payload = { id: roomId, workspaceId: c.workspaceId, title: c.title, revision: 1 };
        eventType = 'room.created'; revision = 1;
      } else if (publication) {
        if (execution?.artifacts !== true || publication.kind==='form' && execution?.forms!==true || !local.canPublish(c.taskId,publication.incarnation)) throw fail('expired','产物发布所属执行已失效。',409);
        const t = local.read(c.taskId), principal = db.prepare('SELECT kind FROM principals WHERE id=?').get(t.ownerAgentId);
        if(principal && principal.kind!=='agent') throw fail('invalid_owner','Agent 身份冲突。',409);
        if(!principal) db.prepare('INSERT INTO principals VALUES(?,?,?)').run(t.ownerAgentId,'agent',t.ownerAgentId);
        if(publication.kind==='form') {
          const published=formStore.publish(c,t,now);artifact=published.ref;taskId=t.id;
          const task=local.apply(c,actor,current=>{if(current.question)current.history.push(current.question);current.question=null;current.nativeId=null;current.formWait={artifactId:artifact.artifactId,version:artifact.version,title:artifact.title};current.phase='awaiting_input';current.delivery='none';});
          form=formStore.view(published.wait);extraEvents.push({type:'localTask.updated',payload:task});
        } else artifact = reports.publish(c,t,now);
        const updated = db.prepare('UPDATE rooms SET last_message_sequence=last_message_sequence+1, revision=revision+1 WHERE id=? AND last_message_sequence<? AND revision<? RETURNING last_message_sequence').get(roomId,MAX,MAX);
        if(!updated) throw fail('sequence_exhausted','房间序号超出安全范围。',409);
        sequence=updated.last_message_sequence; messageId=randomUUID();
        db.prepare('INSERT INTO messages(id,room_id,sequence,author_id,author_kind,author_name_snapshot,text,created_at,artifact_refs_json) VALUES(?,?,?,?,?,?,?,?,?)').run(messageId,roomId,sequence,t.ownerAgentId,'agent',t.ownerAgentId,c.title,now,JSON.stringify([artifact]));
        payload=message(db.prepare('SELECT * FROM messages WHERE id=?').get(messageId)); eventType='message.created'; revision=1;
      } else if (localCommand || mutation) {
        payload = local.apply(c, actor, mutation); taskId = payload.id;
        eventType = 'localTask.updated'; revision = payload.revision;
        db.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').run(roomId);
        if (c.type === 'answerLocalQuestion') for (const question of advice.sourceAnswered(payload, actor)) extraEvents.push({ type: 'consultation.updated', payload: question });
      } else {
        if (!c.text.trim() && !c.attachmentIds.length) throw fail('invalid_request','消息和附件不能同时为空。');
        const refs = files.link(c.attachmentIds,roomId,actor,now);
        if (c.replyToId && !db.prepare('SELECT id FROM messages WHERE id=? AND room_id=?').get(c.replyToId, roomId)) throw fail('invalid_reply', '引用消息不属于当前房间。');
        const updated = db.prepare('UPDATE rooms SET last_message_sequence=last_message_sequence+1, revision=revision+1 WHERE id=? AND last_message_sequence<? AND revision<? RETURNING last_message_sequence').get(roomId, MAX, MAX);
        if (!updated) throw fail('sequence_exhausted', '房间序号超出安全范围。', 409);
        sequence = updated.last_message_sequence; messageId = randomUUID();
        db.prepare('INSERT INTO messages(id,room_id,sequence,author_id,author_kind,author_name_snapshot,text,reply_to_id,created_at,attachment_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(messageId, roomId, sequence, actor.id, 'human', actor.display_name, c.text, c.replyToId, now, JSON.stringify(refs));
        payload = message(db.prepare('SELECT * FROM messages WHERE id=?').get(messageId));
        eventType = 'message.created'; revision = 1;
      }
      fault('after_entity');
      let position;
      for (const event of [{ type: eventType, payload, entityId: curationCommand ? (c.runId || c.scope.agentId || c.scope.roomId) : memoryCommand ? payload.entityId : form && !publication ? form.artifactId : attachment?.id || consultationId || messageId || taskId || roomId, revision }, ...extraEvents]) {
        const next = db.prepare('UPDATE database_meta SET global_event_position=global_event_position+1 WHERE singleton=1 AND global_event_position<? RETURNING global_event_position').get(MAX);
        if (!next) throw fail('sequence_exhausted', '事件序号超出安全范围。', 409);
        position = next.global_event_position;
        db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(position, randomUUID(), 1, event.type, c.workspaceId, roomId, event.entityId || event.payload.id, event.revision || event.payload.revision, operationId, now, JSON.stringify(event.payload));
      }
      fault('after_event');
      const receipt = curationCommand ? curationReceiptSchema.parse({ schemaVersion: 1, accepted: true, operationId, ...payload }) : memoryCommand ? memoryReceiptSchema.parse({ schemaVersion: 1, accepted: true, operationId, ...payload }) : persistenceReceiptSchema.parse({ schemaVersion: 1, accepted: true, operationId, roomId, messageId, sequence, ...(form ? {form} : {}), ...(attachment ? {attachment} : {}), ...(taskId ? { taskId } : {}), ...(consultationId ? { consultationId } : {}), ...(artifact ? {artifactId:artifact.artifactId,artifactVersion:artifact.version}:{}), cursor: cursor(roomId, position) });
      db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(operationId, actor.id, c.workspaceId, c.type, c.key, digest, 1, JSON.stringify(receipt), roomId, messageId, now);
      fault('after_receipt');
      commitAttempted = true; db.exec('COMMIT'); inTransaction = false;
      fault('after_commit');
      for (const wake of wakeups) wake();
      if (taskId) local.schedule(taskId);
      advice.schedule(); curation.schedule();
      return receipt;
    } catch (error) {
      if (inTransaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } }
      throw mappedError(error, commitAttempted);
    } finally { commandTransaction = false; }
  }
  function query(input, caller) {
    const formQuery=['formState','formResponses'].includes(input?.type);
    const attachmentQuery = ['attachment','pendingAttachments'].includes(input?.type);
    const localQuery = ['localTask', 'localTasks'].includes(input?.type);
    const artifactQuery = ['artifact','artifactVersions'].includes(input?.type);
    const memoryQuery = memoryQueryTypes.includes(input?.type);
    const curationQuery = curationQueryTypes.includes(input?.type);
    const contextQuery = input?.type === 'taskContextSnapshot';
    const consultationQuery = ['consultations','consultation','consultationContext'].includes(input?.type);
    const q = parse(curationQuery ? curationQuerySchema : formQuery ? formQuerySchema : attachmentQuery ? attachmentQuerySchema : consultationQuery ? consultationQuerySchema : contextQuery ? taskContextQuerySchema : memoryQuery ? memoryQuerySchema : artifactQuery ? artifactQuerySchema : localQuery ? localExecutionQuerySchema : persistenceQuerySchema, input);
    let reading = false;
    try {
      db.exec('BEGIN'); reading = true;
      const actor = authorize(caller), m = meta();
      let result;
      if (curationQuery) {
        workspace(q.workspaceId, actor); memoryScope(q.scope, actor); result = curation.query(q);
      } else if (memoryQuery) {
        workspace(q.workspaceId, actor); memoryScope(q.scope || { kind: 'agent', agentId: q.agentId }, actor);
        result = memories.query(q);
      } else if (q.type === 'bootstrap') {
        workspace(initial.workspace_id, actor);
        result = { schemaVersion: 1, databaseId: m.database_id, instanceId, user: { id: actor.id, name: actor.display_name }, workspace: { id: m.workspace_id, title: '持久讨论' }, capabilities: { forms:execution?.forms===true, attachments: true, tasks: false, memoryCuration: true, agentMemory: true, localExecution: Boolean(execution), consultations: consultationAgents.length > 0, readOnlyArtifacts: true, artifactPublishing: execution?.artifacts === true, idempotentSend: true, persistentMessages: true, eventStream: true, multiUser: false }, consultationAgents: advice.agents(), knownAgents: [...agents], ...(execution ? { localAgentId: execution.agentId } : {}) };
      } else if (q.type === 'rooms') {
        workspace(q.workspaceId, actor);
        result = db.prepare('SELECT r.id,r.title,r.revision,r.last_message_sequence AS lastMessageSequence FROM rooms r JOIN room_members m ON r.id=m.room_id WHERE r.workspace_id=? AND m.principal_id=? ORDER BY r.id LIMIT 200').all(q.workspaceId, actor.id);
      } else if (q.type === 'operation' || q.type === 'receipt') {
        if (q.type === 'receipt') workspace(q.workspaceId, actor);
        const row = q.type === 'operation' ? db.prepare('SELECT * FROM command_receipts WHERE operation_id=? AND caller_id=?').get(q.operationId, actor.id) : db.prepare('SELECT * FROM command_receipts WHERE workspace_id=? AND caller_id=? AND command_type=? AND idempotency_key=?').get(q.workspaceId, actor.id, q.commandType, q.key);
        if (!row) throw fail('not_found', '未找到可访问的回执。', 404);
        workspace(row.workspace_id, actor);
        result = JSON.parse(row.receipt_json);
        if (memoryCommandTypes.includes(row.command_type) || curationCommandTypes.includes(row.command_type)) memoryScope(result.scope, actor);
        else room(row.room_id, actor);
      } else {
        const r = room(q.roomId, actor);
        if (consultationQuery) {
          if (q.type === 'consultations') result = advice.list(q.roomId);
          else { const question = advice.read(q.consultationId); if (question.roomId !== q.roomId) throw fail('not_found', '咨询不可访问。', 404); result = q.type === 'consultationContext' ? advice.context(question, q.assignmentId) : advice.view(question); }
        } else if (contextQuery) {
          const task = local.read(q.taskId);
          if (task.roomId !== q.roomId) throw fail('not_found', '任务不可访问。', 404);
          result = memories.taskContextSnapshot(task);
        }
        else if(q.type==='formResponses') result=formStore.history(q);
        else if(formQuery) {const wait=formStore.read(q.artifactId,q.version,q.roomId);result=formStore.view(wait,local.formLive(wait.taskId,wait.incarnation,{artifactId:wait.artifactId,version:wait.version}));}
        else if (attachmentQuery) result=files.query(q,actor,new Date(clock()).toISOString());
        else if (artifactQuery) result=reports.query(q);
        else if (localQuery) {
          result = local.list(q.roomId);
          if (q.type === 'localTask') { const t = local.read(q.taskId); if (t.roomId !== q.roomId) throw fail('not_found', '任务不可访问。', 404); result = local.view(t); }
        } else if (q.type === 'snapshot') {
          const rows = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY sequence DESC LIMIT 101').all(q.roomId);
          const more = rows.length > 100; rows.length = Math.min(rows.length, 100); rows.reverse();
          result = { schemaVersion: 1, databaseId: m.database_id, instanceId, room: { id: r.id, workspaceId: r.workspace_id, title: r.title, revision: r.revision }, messages: rows.map(message), localTasks: local.list(q.roomId), consultations: advice.list(q.roomId), roomSequenceUpperBound: r.last_message_sequence, beforeSequence: more ? rows[0].sequence : null, cursor: cursor(q.roomId, m.global_event_position) };
        } else if (q.type === 'messages') {
          if (q.upperBound !== undefined && q.upperBound > r.last_message_sequence) throw fail('invalid_request', '历史窗口不能超前。');
          const upperBound = q.upperBound ?? r.last_message_sequence;
          const rows = db.prepare('SELECT * FROM messages WHERE room_id=? AND sequence<=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(q.roomId, upperBound, q.beforeSequence ?? null, q.beforeSequence ?? null, q.limit + 1);
          const more = rows.length > q.limit; rows.length = Math.min(rows.length, q.limit); rows.reverse();
          result = { schemaVersion: 1, databaseId: m.database_id, roomId: q.roomId, messages: rows.map(message), roomSequenceUpperBound: upperBound, beforeSequence: more ? rows[0].sequence : null, cursor: cursor(q.roomId, m.global_event_position) };
        } else {
          const after = q.after ? readCursor(q.after, q.roomId, m.global_event_position) : 0;
          if (after < m.pruned_through) throw fail('resync_required', '事件记录已过期，请重新读取快照。', 409);
          const rows = db.prepare("SELECT * FROM events WHERE room_id=? AND position>? AND type IN ('room.created','message.created','localTask.updated','consultation.updated','attachment.updated','form.updated') AND (type!='attachment.updated' OR json_extract(payload_json,'$.uploaderId')=?) ORDER BY position LIMIT ?").all(q.roomId, after, actor.id, q.limit + 1);
          const more = rows.length > q.limit; rows.length = Math.min(rows.length, q.limit);
          result = { events: rows.map(e => ({ eventId: e.event_id, schemaVersion: e.schema_version, type: e.type, entityId: e.entity_id, entityRevision: e.entity_revision, operationId: e.operation_id, workspaceId: e.workspace_id, roomId: e.room_id, occurredAt: e.occurred_at, payload: JSON.parse(e.payload_json), cursor: cursor(q.roomId, e.position) })), cursor: cursor(q.roomId, more ? rows.at(-1).position : m.global_event_position) };
        }
      }
      db.exec('COMMIT'); reading = false; return result;
    } catch (e) { if (reading) { try { db.exec('ROLLBACK'); } catch {} } throw mappedError(e, false); }
  }
  // Register before reading; notification is only an optimization of the durable log scan.
  function watch(input, caller, { signal } = {}) {
    const q = parse(persistenceQuerySchema, { ...input, type: 'events' });
    let dirty = false, waiting, ended = false;
    const wake = () => { dirty = true; waiting?.(); };
    const close = () => { ended = true; wake(); wakeups.delete(wake); signal?.removeEventListener('abort', close); };
    wakeups.add(wake); signal?.addEventListener('abort', close, { once: true });
    let first;
    try { first = query(q, caller); } catch (error) { close(); throw error; }
    if (signal?.aborted) close();
    return { close, async *[Symbol.asyncIterator]() {
      let after = q.after;
      try {
        while (!ended && !closed) {
          dirty = false;
          const page = first || query({ ...q, after }, caller); first = null;
          for (const event of page.events) {
            if (ended || closed) return;
            if (after) readCursor(after, q.roomId, meta().global_event_position);
            yield { type: 'event', data: event }; after = event.cursor;
          }
          if (page.cursor !== after) { if (ended || closed) return; yield { type: 'checkpoint', cursor: page.cursor }; }
          after = page.cursor;
          if (page.events.length === q.limit) { await new Promise(resolve => setImmediate(resolve)); continue; }
          fault('before_wait');
          if (!dirty && !ended && !closed) await new Promise(resolve => {
            const timer = setTimeout(done, 1000);
            function done() { clearTimeout(timer); waiting = undefined; resolve(); }
            waiting = done;
          });
        }
      } finally { close(); }
    } };
  }
  try { local.recover(); advice.recover(); curation.recover(); } catch (e) { advice.shutdown(); clearInterval(maintenance); db.close(); throw e; }
  function uploadAttachment(input, bytes, caller) {
    const c=parse(uploadAttachmentSchema,input);
    validateAttachmentBytes(c,bytes);
    return execute(c,caller,null,null,bytes);
  }
  function downloadAttachment(input, caller) {
    const q=parse(attachmentQuerySchema,{...input,type:'attachment'}), actor=authorize(caller);
    room(q.roomId,actor);
    return files.download(q,actor,new Date(clock()).toISOString());
  }
  return { uploadAttachment, downloadAttachment, execute(input, caller) { const receipt = execute(input, caller); return input.type === 'inspectMemoryCuration' ? curation.inspected().then(() => receipt) : receipt; }, query, watch, owner: Object.freeze({ principalId: initial.owner_id }), close() { if (!closed) { curation.shutdown(); advice.shutdown(); local.shutdown(); closed = true; clearInterval(maintenance); for (const wake of wakeups) wake(); db.close(); } } };
}
