import { randomUUID, createHash } from 'node:crypto';
import { persistenceCommandSchema, persistenceQuerySchema, persistenceMessageSchema, persistenceReceiptSchema, persistenceError as fail } from '../../contracts/persistence.mjs';
import { openStorage } from './storage.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function parse(schema, input) { const r = schema.safeParse(input); if (!r.success) throw fail('invalid_request', '请求不符合持久消息契约。'); return r.data; }
function message(row) {
  return persistenceMessageSchema.parse({ id: row.id, roomId: row.room_id, sequence: row.sequence, authorId: row.author_id, authorKind: row.author_kind, authorName: row.author_name_snapshot, role: 'user', text: row.text, status: 'complete', createdAt: row.created_at, revision: row.revision, tools: [], replyToId: row.reply_to_id, recipientIds: [] });
}

// fault is an internal test-assembly seam; it is never selected by HTTP or environment input.
export async function createApplicationRuntime({ directory, busyTimeoutMs = 5000, fault = () => {}, clock = Date.now, maintenanceIntervalMs = 60000 }) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new Error('Invalid busy timeout.');
  if (typeof clock !== 'function' || !Number.isInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 10 || maintenanceIntervalMs > 60000) throw new Error('Invalid maintenance configuration.');
  const db = await openStorage(directory, busyTimeoutMs);
  const meta = () => db.prepare('SELECT * FROM database_meta WHERE singleton=1').get();
  const initial = meta(), instanceId = randomUUID();
  let closed = false;
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
    try { pruneEvents(); } catch { console.warn('Persistent event retention postponed; will retry.'); }
  }, maintenanceIntervalMs);
  maintenance.unref?.();
  function authorize(caller) {
    if (closed) throw fail('unavailable', '后端已经关闭。', 503);
    const actor = db.prepare('SELECT * FROM principals WHERE id=?').get(caller?.principalId ?? '');
    if (!actor) throw fail('forbidden', '调用身份不可用。', 403);
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
  function execute(input, caller) {
    if (input?.mode === 'task' || (input?.type && !['createRoom', 'sendDiscussion'].includes(input.type))) throw fail('unsupported', '此后端仅支持讨论消息。', 422);
    const c = parse(persistenceCommandSchema, input);
    let inTransaction = false, commitAttempted = false;
    try {
      db.exec('BEGIN IMMEDIATE'); inTransaction = true;
      const actor = authorize(caller); workspace(c.workspaceId, actor);
      if (c.type === 'sendDiscussion' && room(c.roomId, actor).workspace_id !== c.workspaceId) throw fail('not_found', '房间不可访问。', 404);
      const digest = hash(c);
      const previous = db.prepare('SELECT * FROM command_receipts WHERE caller_id=? AND workspace_id=? AND command_type=? AND idempotency_key=?').get(actor.id, c.workspaceId, c.type, c.key);
      if (previous) {
        if (previous.request_hash !== digest) throw fail('idempotency_conflict', '该请求标识已用于不同内容。', 409);
        room(previous.room_id, actor);
        db.exec('ROLLBACK'); inTransaction = false;
        return JSON.parse(previous.receipt_json);
      }
      const operationId = randomUUID(), now = new Date(clock()).toISOString();
      let roomId = c.roomId, messageId = null, sequence = null, payload, eventType, revision;
      if (c.type === 'createRoom') {
        roomId = randomUUID();
        db.prepare('INSERT INTO rooms(id,workspace_id,title) VALUES(?,?,?)').run(roomId, c.workspaceId, c.title);
        db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(roomId, actor.id, 'owner');
        payload = { id: roomId, workspaceId: c.workspaceId, title: c.title, revision: 1 };
        eventType = 'room.created'; revision = 1;
      } else {
        if (c.replyToId && !db.prepare('SELECT id FROM messages WHERE id=? AND room_id=?').get(c.replyToId, roomId)) throw fail('invalid_reply', '引用消息不属于当前房间。');
        const updated = db.prepare('UPDATE rooms SET last_message_sequence=last_message_sequence+1, revision=revision+1 WHERE id=? AND last_message_sequence<? AND revision<? RETURNING last_message_sequence').get(roomId, MAX, MAX);
        if (!updated) throw fail('sequence_exhausted', '房间序号超出安全范围。', 409);
        sequence = updated.last_message_sequence; messageId = randomUUID();
        db.prepare('INSERT INTO messages(id,room_id,sequence,author_id,author_kind,author_name_snapshot,text,reply_to_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(messageId, roomId, sequence, actor.id, 'human', actor.display_name, c.text, c.replyToId, now);
        payload = message(db.prepare('SELECT * FROM messages WHERE id=?').get(messageId));
        eventType = 'message.created'; revision = 1;
      }
      fault('after_entity');
      const next = db.prepare('UPDATE database_meta SET global_event_position=global_event_position+1 WHERE singleton=1 AND global_event_position<? RETURNING global_event_position').get(MAX);
      if (!next) throw fail('sequence_exhausted', '事件序号超出安全范围。', 409);
      const position = next.global_event_position;
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(position, randomUUID(), 1, eventType, c.workspaceId, roomId, messageId || roomId, revision, operationId, now, JSON.stringify(payload));
      fault('after_event');
      const receipt = persistenceReceiptSchema.parse({ schemaVersion: 1, accepted: true, operationId, roomId, messageId, sequence, cursor: cursor(roomId, position) });
      db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(operationId, actor.id, c.workspaceId, c.type, c.key, digest, 1, JSON.stringify(receipt), roomId, messageId, now);
      fault('after_receipt');
      commitAttempted = true; db.exec('COMMIT'); inTransaction = false;
      fault('after_commit');
      for (const wake of wakeups) wake();
      return receipt;
    } catch (error) {
      if (inTransaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } }
      throw mappedError(error, commitAttempted);
    }
  }
  function query(input, caller) {
    const q = parse(persistenceQuerySchema, input);
    let reading = false;
    try {
      db.exec('BEGIN'); reading = true;
      const actor = authorize(caller), m = meta();
      let result;
      if (q.type === 'bootstrap') {
        workspace(initial.workspace_id, actor);
        result = { schemaVersion: 1, databaseId: m.database_id, instanceId, user: { id: actor.id, name: actor.display_name }, workspace: { id: m.workspace_id, title: '持久讨论' }, capabilities: { tasks: false, idempotentSend: true, persistentMessages: true, eventStream: true, multiUser: false } };
      } else if (q.type === 'rooms') {
        workspace(q.workspaceId, actor);
        result = db.prepare('SELECT r.id,r.title,r.revision,r.last_message_sequence AS lastMessageSequence FROM rooms r JOIN room_members m ON r.id=m.room_id WHERE r.workspace_id=? AND m.principal_id=? ORDER BY r.id LIMIT 200').all(q.workspaceId, actor.id);
      } else if (q.type === 'operation' || q.type === 'receipt') {
        if (q.type === 'receipt') workspace(q.workspaceId, actor);
        const row = q.type === 'operation' ? db.prepare('SELECT * FROM command_receipts WHERE operation_id=? AND caller_id=?').get(q.operationId, actor.id) : db.prepare('SELECT * FROM command_receipts WHERE workspace_id=? AND caller_id=? AND command_type=? AND idempotency_key=?').get(q.workspaceId, actor.id, q.commandType, q.key);
        if (!row) throw fail('not_found', '未找到可访问的回执。', 404);
        room(row.room_id, actor); result = JSON.parse(row.receipt_json);
      } else {
        const r = room(q.roomId, actor);
        if (q.type === 'snapshot') {
          const rows = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY sequence DESC LIMIT 101').all(q.roomId);
          const more = rows.length > 100; rows.length = Math.min(rows.length, 100); rows.reverse();
          result = { schemaVersion: 1, databaseId: m.database_id, instanceId, room: { id: r.id, workspaceId: r.workspace_id, title: r.title, revision: r.revision }, messages: rows.map(message), roomSequenceUpperBound: r.last_message_sequence, beforeSequence: more ? rows[0].sequence : null, cursor: cursor(q.roomId, m.global_event_position) };
        } else if (q.type === 'messages') {
          if (q.upperBound !== undefined && q.upperBound > r.last_message_sequence) throw fail('invalid_request', '历史窗口不能超前。');
          const upperBound = q.upperBound ?? r.last_message_sequence;
          const rows = db.prepare('SELECT * FROM messages WHERE room_id=? AND sequence<=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(q.roomId, upperBound, q.beforeSequence ?? null, q.beforeSequence ?? null, q.limit + 1);
          const more = rows.length > q.limit; rows.length = Math.min(rows.length, q.limit); rows.reverse();
          result = { schemaVersion: 1, databaseId: m.database_id, roomId: q.roomId, messages: rows.map(message), roomSequenceUpperBound: upperBound, beforeSequence: more ? rows[0].sequence : null, cursor: cursor(q.roomId, m.global_event_position) };
        } else {
          const after = q.after ? readCursor(q.after, q.roomId, m.global_event_position) : 0;
          if (after < m.pruned_through) throw fail('resync_required', '事件记录已过期，请重新读取快照。', 409);
          const rows = db.prepare('SELECT * FROM events WHERE room_id=? AND position>? ORDER BY position LIMIT ?').all(q.roomId, after, q.limit + 1);
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
  return { execute, query, watch, owner: Object.freeze({ principalId: initial.owner_id }), close() { if (!closed) { closed = true; clearInterval(maintenance); for (const wake of wakeups) wake(); db.close(); } } };
}
