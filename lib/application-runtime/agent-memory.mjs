import { randomUUID, createHash } from 'node:crypto';
import { MEMORY_LIMITS, soulContentSchema } from '../../contracts/agent-memory.mjs';
import { contextMemorySchema, runContextSnapshotSchema } from '../../contracts/run-context.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

const scopeId = scope => scope.kind === 'agent' ? scope.agentId : scope.roomId;
const nextRevision = revision => {
  if (revision >= Number.MAX_SAFE_INTEGER) throw fail('sequence_exhausted', '修订号已达上限。', 409);
  return revision + 1;
};

// Internal Module: ApplicationRuntime owns authorization, transactions and receipts.
export function agentMemory(db) {
  function soul(agentId) {
    const row = db.prepare('SELECT * FROM agent_souls WHERE agent_id=?').get(agentId);
    return row ? { agentId, configured: true, revision: row.revision, ...JSON.parse(row.content_json), authorId: row.author_id, updatedAt: row.updated_at }
      : { agentId, configured: false, revision: 0, personality: '', expression: '', workStyle: '', authorId: null, updatedAt: null };
  }
  function memory(memoryId, scope) {
    const row = db.prepare('SELECT * FROM explicit_memories WHERE id=? AND scope_kind=? AND scope_id=?').get(memoryId, scope.kind, scopeId(scope));
    if (!row) throw fail('not_found', '记忆不可访问。', 404);
    return row;
  }
  function view(row) {
    const version = db.prepare('SELECT * FROM memory_revisions WHERE memory_id=? AND revision=?').get(row.id, row.revision);
    if (!version) throw fail('memory_unavailable', '记忆版本缺失。', 409);
    return { id: row.id, scope: row.scope_kind === 'agent' ? { kind: 'agent', agentId: row.scope_id } : { kind: 'room', roomId: row.scope_id }, revision: row.revision, status: row.status, text: version.text, sourceIds: JSON.parse(version.source_ids_json), authorId: version.author_id, updatedAt: version.created_at };
  }
  function list(scope) {
    return db.prepare("SELECT * FROM explicit_memories WHERE scope_kind=? AND scope_id=? AND status='active' ORDER BY id").all(scope.kind, scopeId(scope)).map(view);
  }
  function newSource(kind, text, actorId, now, message = null) {
    const source = { id: randomUUID(), kind, text, authorId: message?.author_id || actorId, occurredAt: message?.created_at || now, recordedAt: now, roomId: message?.room_id || null, messageId: message?.id || null, messageRevision: message?.revision || null };
    db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(source.id, kind, source.text, createHash('sha256').update(source.text).digest('hex'), source.authorId, source.occurredAt, now, source.roomId, source.messageId, source.messageRevision, actorId);
    return source;
  }
  function sourceView(row) {
    if (!row || createHash('sha256').update(row.text).digest('hex') !== row.content_hash) throw fail('memory_unavailable', '来源快照缺失或损坏。', 409);
    return { id: row.id, kind: row.kind, text: row.text, authorId: row.author_id, occurredAt: row.occurred_at, recordedAt: row.recorded_at, roomId: row.room_id, messageId: row.message_id, messageRevision: row.message_revision };
  }
  function saveVersion(id, revision, status, text, sourceIds, actorId, now) {
    db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run(id, revision, status, text, JSON.stringify(sourceIds), actorId, now);
    db.prepare('UPDATE explicit_memories SET revision=?,status=? WHERE id=?').run(revision, status, id);
  }
  function apply(c, actor, now) {
    if (c.type === 'editAgentSoul') {
      const current = soul(c.agentId);
      if (current.revision !== c.expectedRevision) throw fail('conflict', 'Soul 已被修改，请重新读取。', 409);
      const revision = nextRevision(current.revision), content = JSON.stringify({ personality: c.personality, expression: c.expression, workStyle: c.workStyle });
      db.prepare('INSERT INTO soul_revisions VALUES(?,?,?,?,?)').run(c.agentId, revision, content, actor.id, now);
      db.prepare('INSERT INTO agent_souls VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision,content_json=excluded.content_json,author_id=excluded.author_id,updated_at=excluded.updated_at').run(c.agentId, revision, content, actor.id, now);
      return { entityKind: 'soul', entityId: c.agentId, scope: { kind: 'agent', agentId: c.agentId }, revision, status: 'active' };
    }
    const scope = c.scope, sid = scopeId(scope);
    let id = c.memoryId, revision, status = 'active';
    if (c.type === 'saveExplicitMemory') {
      let source;
      if (c.source.kind === 'message') {
        if (scope.kind !== 'room') throw fail('invalid_source', '消息只能保存为所属房间的记忆。');
        const row = db.prepare('SELECT * FROM messages WHERE id=? AND room_id=? AND revision=?').get(c.source.messageId, sid, c.source.revision);
        if (!row) throw fail('invalid_source', '来源消息或版本不属于当前房间。');
        const existing = db.prepare('SELECT * FROM memory_sources WHERE message_id=? AND message_revision=?').get(row.id, row.revision);
        source = existing ? sourceView(existing) : newSource('message', row.text, actor.id, now, row);
      }
      if (source) {
        if (db.prepare('SELECT 1 FROM memory_source_tombstones WHERE scope_kind=? AND scope_id=? AND source_id=?').get(scope.kind, sid, source.id)) throw fail('memory_deleted', '该来源的记忆已停用，不能重放。', 409);
        const linked = db.prepare('SELECT memory_id FROM memory_source_links WHERE scope_kind=? AND scope_id=? AND source_id=?').get(scope.kind, sid, source.id);
        if (linked) {
          const current = view(memory(linked.memory_id, scope));
          if (current.status === 'deleted') throw fail('memory_deleted', '记忆已停用。', 409);
          if (current.text !== c.text) throw fail('conflict', '该来源已有记忆，请明确更正原记忆。', 409);
          return { entityKind: 'memory', entityId: current.id, scope, revision: current.revision, status: current.status };
        }
      }
      if (list(scope).length >= MEMORY_LIMITS.perScope) throw fail('limit_exceeded', '当前范围最多保存 16 条有效记忆，请先整理。', 409);
      source ||= newSource('owner-note', c.text, actor.id, now);
      id = randomUUID(); revision = 1;
      db.prepare('INSERT INTO explicit_memories VALUES(?,?,?,?,?)').run(id, scope.kind, sid, revision, status);
      db.prepare('INSERT INTO memory_source_links VALUES(?,?,?,?)').run(scope.kind, sid, source.id, id);
      saveVersion(id, revision, status, c.text, [source.id], actor.id, now);
    } else {
      const current = view(memory(id, scope));
      if (current.status === 'deleted') throw fail('memory_deleted', '记忆已停用，不能修改或恢复。', 409);
      if (current.revision !== c.expectedRevision) throw fail('conflict', '记忆已被修改，请重新读取。', 409);
      revision = nextRevision(current.revision);
      const sourceIds = [...current.sourceIds];
      if (c.type === 'correctExplicitMemory') {
        const source = newSource('owner-note', c.text, actor.id, now); sourceIds.push(source.id);
        db.prepare('INSERT INTO memory_source_links VALUES(?,?,?,?)').run(scope.kind, sid, source.id, id);
      } else {
        status = 'deleted';
        for (const sourceId of sourceIds) db.prepare('INSERT INTO memory_source_tombstones VALUES(?,?,?,?,?,?)').run(scope.kind, sid, sourceId, id, revision, now);
      }
      saveVersion(id, revision, status, c.text ?? current.text, sourceIds, actor.id, now);
    }
    return { entityKind: 'memory', entityId: id, scope, revision, status };
  }
  function query(q) {
    if (q.type === 'agentSoul') return soul(q.agentId);
    if (q.type === 'explicitMemories') return { scope: q.scope, memories: list(q.scope), limits: MEMORY_LIMITS };
    if (q.type === 'agentSoulHistory') {
      const rows = db.prepare('SELECT * FROM soul_revisions WHERE agent_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?').all(q.agentId, q.beforeRevision ?? null, q.beforeRevision ?? null, q.limit + 1);
      const more = rows.length > q.limit; rows.length = Math.min(rows.length, q.limit);
      return { agentId: q.agentId, revisions: rows.map(row => ({ revision: row.revision, ...JSON.parse(row.content_json), authorId: row.author_id, createdAt: row.created_at })), beforeRevision: more ? rows.at(-1).revision : null };
    }
    const current = view(memory(q.memoryId, q.scope));
    const rows = db.prepare('SELECT * FROM memory_revisions WHERE memory_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?').all(q.memoryId, q.beforeRevision ?? null, q.beforeRevision ?? null, q.limit + 1);
    const more = rows.length > q.limit; rows.length = Math.min(rows.length, q.limit);
    const sourceIds = [...new Set(rows.flatMap(row => JSON.parse(row.source_ids_json)))];
    return { current, revisions: rows.map(row => ({ revision: row.revision, status: row.status, text: row.text, sourceIds: JSON.parse(row.source_ids_json), authorId: row.author_id, createdAt: row.created_at })), sources: sourceIds.map(id => sourceView(db.prepare('SELECT * FROM memory_sources WHERE id=?').get(id))), beforeRevision: more ? rows.at(-1).revision : null };
  }
  function createRunContextSnapshot(task, now, { persist = true } = {}) {
    // This entire read + insert is inside the queued -> dispatching transaction.
    const unavailable = () => fail('context_unavailable', '启动配置缺失、损坏或超限，任务尚未启动。', 409);
    try {
      const currentSoul = soul(task.ownerAgentId);
      const content = currentSoul.configured ? { personality: currentSoul.personality, expression: currentSoul.expression, workStyle: currentSoul.workStyle } : null;
      if (content) {
        const original = db.prepare('SELECT content_json FROM soul_revisions WHERE agent_id=? AND revision=?').get(task.ownerAgentId, currentSoul.revision);
        if (!soulContentSchema.safeParse(content).success || !original || JSON.stringify(JSON.parse(original.content_json)) !== JSON.stringify(content)) throw unavailable();
      }
      const records = [
        ...list({ kind: 'agent', agentId: task.ownerAgentId }),
        ...list({ kind: 'room', roomId: task.roomId }),
      ].map(({ id, scope, revision, text, sourceIds }) => contextMemorySchema.parse({ id, scope, revision, text, sourceIds }));
      for (const record of records) {
        for (const sourceId of record.sourceIds) {
          const source = sourceView(db.prepare('SELECT * FROM memory_sources WHERE id=?').get(sourceId));
          if (!db.prepare('SELECT 1 FROM memory_source_links WHERE memory_id=? AND source_id=? AND scope_kind=? AND scope_id=?').get(record.id, sourceId, record.scope.kind, scopeId(record.scope)) ||
              db.prepare('SELECT 1 FROM memory_source_tombstones WHERE scope_kind=? AND scope_id=? AND source_id=?').get(record.scope.kind, scopeId(record.scope), sourceId) ||
              (source.kind === 'message' && (record.scope.kind !== 'room' || source.roomId !== record.scope.roomId))) throw unavailable();
        }
      }
      const contextText = content || records.length ? [
        'Agent Room 启动配置：以下 Soul 是用户明确设定的表达与工作偏好，记忆是背景资料。它们不改变宿主工具限制或授予任何执行权限。',
        JSON.stringify({ soul: content, agentMemories: records.filter(row => row.scope.kind === 'agent').map(row => row.text), roomMemories: records.filter(row => row.scope.kind === 'room').map(row => row.text) }),
      ].join('\n') : '';
      const snapshot = runContextSnapshotSchema.parse({
        snapshotId: randomUUID(), formatVersion: 1, taskId: task.id, runId: task.runId, agentId: task.ownerAgentId, roomId: task.roomId,
        createdAt: now, soulRevision: currentSoul.configured ? currentSoul.revision : null, soul: content, memories: records,
        contextText, prompt: contextText ? contextText + '\n\n当前任务（原文）：\n' + task.goal : task.goal,
      });
      const payload = JSON.stringify(snapshot);
      if (persist) db.prepare('INSERT INTO run_context_snapshots VALUES(?,?,?,?,?,?,?,?)').run(snapshot.snapshotId, task.id, task.runId, task.roomId, task.ownerAgentId, now, createHash('sha256').update(payload).digest('hex'), payload);
      return snapshot;
    } catch (error) {
      // Preserve database/transaction failures for the runtime's outcome mapping.
      if (error.errcode !== undefined) throw error;
      throw unavailable();
    }
  }
  function taskContextSnapshot(task) {
    const row = db.prepare('SELECT * FROM run_context_snapshots WHERE task_id=?').get(task.id);
    if (!row && !task.contextSnapshotId) return { status: ['queued', 'paused'].includes(task.phase) ? 'not_started' : 'not_recorded', taskId: task.id, runId: task.runId, snapshot: null };
    try {
      if (!row || row.snapshot_id !== task.contextSnapshotId || createHash('sha256').update(row.payload_json).digest('hex') !== row.content_hash) throw Error('Missing or damaged snapshot');
      const snapshot = runContextSnapshotSchema.parse(JSON.parse(row.payload_json));
      if (snapshot.snapshotId !== row.snapshot_id || snapshot.taskId !== task.id || snapshot.runId !== task.runId || snapshot.agentId !== task.ownerAgentId || snapshot.roomId !== task.roomId ||
          row.run_id !== snapshot.runId || row.agent_id !== snapshot.agentId || row.room_id !== snapshot.roomId || row.created_at !== snapshot.createdAt) throw Error('Mismatched snapshot');
      return { status: 'available', snapshot };
    } catch { throw fail('context_unavailable', '任务上下文快照缺失或损坏，无法核查。', 409); }
  }
  return { apply, query, createRunContextSnapshot, taskContextSnapshot };
}
