import { localExecutionCommandSchema } from '../../contracts/local-execution.mjs';
import { clientError } from '../../contracts/chat.mjs';
import { persistenceBootstrapSchema, persistenceSnapshotSchema, persistenceReceiptSchema, persistenceFrameSchema, persistenceCommandSchema, persistenceHistorySchema } from '../../contracts/persistence.mjs';

// A transport and an already-submitted-command journal, never a second message store.
// backendId/localUserId are stable identities supplied by the trusted host, not a session token/port.
export function createPersistentTransport({ session, backendId, localUserId, storage = globalThis.localStorage, fetch: fetcher = globalThis.fetch }) {
  if (typeof session !== 'function' || !backendId || !localUserId || !storage?.getItem || !storage?.setItem || !storage?.removeItem || !storage?.key) throw new Error('Persistent transport requires a trusted session and durable user-scoped storage.');
  let active;
  const parseCommand = value => { const original = persistenceCommandSchema.safeParse(value); return original.success ? original : localExecutionCommandSchema.safeParse(value); };
  const routeFor = command => `/rooms/${encodeURIComponent(command.roomId)}/` + (command.type === 'sendDiscussion' ? 'messages' : command.type === 'createLocalTask' ? 'local-tasks' : `local-tasks/${encodeURIComponent(command.taskId)}/answers`);
  function commandBody(command) { const { type, key, roomId, taskId, ...body } = command; return body; }
  function validateReceipt(command, receipt) {
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
        if (!parsed.success || !['sendDiscussion', 'createLocalTask', 'answerLocalQuestion'].includes(item.command.type) || item.databaseId !== boot.databaseId || item.command.workspaceId !== boot.workspace.id || key !== journalKey(boot, item.command.key) || !['unknown', 'not_found'].includes(item.outcome)) throw new Error('Invalid journal entry.');
        items.push(item);
      }
      return items;
    } catch { throw clientError('journal_invalid', '待核查记录不可读，已停止发送。'); }
  }
  function pending(context) {
    if (active !== context || context.controller.signal.aborted) return;
    context.emit({ type: 'persistence.pending', data: readJournal(context.boot).map(item => ({ key: item.command.key, type: item.command.type === 'sendDiscussion' ? 'send' : item.command.type, taskId: item.command.taskId, roomId: item.command.roomId, databaseId: item.databaseId, outcome: item.outcome })) });
  }
  function update(context, key, value) {
    // One durable key per submitted command: separate windows cannot overwrite each other's list.
    try {
      if (value) storage.setItem(journalKey(context.boot, key), JSON.stringify(value));
      else storage.removeItem(journalKey(context.boot, key));
    } catch { throw clientError('journal_unavailable', '无法保存待核查记录，请检查本地存储。'); }
    pending(context);
  }
  async function response(context, route, { command, signal = context.controller.signal, stream = false } = {}) {
    let res;
    try {
      res = await fetcher(context.credentials.origin + '/api/v1' + route, {
        method: command ? 'POST' : 'GET',
        redirect: 'error',
        credentials: 'same-origin',
        headers: { ...(context.credentials.authentication === 'cookie' ? {} : { Authorization: 'Bearer ' + context.credentials.token }), ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': command.key } : {}) },
        body: command ? JSON.stringify(commandBody(command)) : undefined,
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
  async function check(context, key) {
    const entry = readJournal(context.boot).find(item => item.command.key === key);
    try {
      const receipt = await json(context, '/operations?' + new URLSearchParams({ workspaceId: entry?.command.workspaceId || context.boot.workspace.id, commandType: entry?.command.type || 'sendDiscussion', key }), persistenceReceiptSchema);
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
        if (data.localTasks.some(t => t.roomId !== scope.roomId)) throw clientError('invalid_response', '任务快照范围不匹配。');
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
      const local = ['createLocalTask', 'answerLocalQuestion'].includes(input.type);
      if (local && !context.boot.capabilities.localExecution) throw clientError('unsupported', '本机执行尚未启用。');
      if (!local && (input.type !== 'send' || input.mode !== 'discussion' || input.mentions?.length || input.ownerAgentId)) throw clientError('unsupported', '持久后端仅支持普通讨论消息。');
      if (input.roomId !== context.scope.roomId) throw clientError('invalid_scope', '只能向当前房间发送。');
      const command = local ? localExecutionCommandSchema.parse(input) : { type: 'sendDiscussion', key: input.key, workspaceId: context.boot.workspace.id, roomId: input.roomId, text: input.text, replyToId: null };
      if (command.workspaceId !== context.boot.workspace.id) throw clientError('invalid_scope', '工作区已变化。');
      if (local && readJournal(context.boot).some(e => e.command.key !== command.key && e.command.type !== 'sendDiscussion' && e.command.roomId === command.roomId && (command.type === 'createLocalTask' || e.command.type === 'createLocalTask' || command.taskId === e.command.taskId))) throw clientError('outcome_unknown', '此前任务请求结果待核查，不能换标识重复提交。', 'unknown');
      const previous = readJournal(context.boot).find(item => item.command.key === command.key);
      if (previous) {
        if (JSON.stringify(previous.command) !== JSON.stringify(command)) throw clientError('idempotency_conflict', '待核查请求内容不能改变。');
        const receipt = await check(context, command.key);
        if (receipt) return receipt;
      }
      const entry = { databaseId: context.boot.databaseId, command, outcome: 'unknown' };
      // Save before network submission, including the page/process-crash window.
      update(context, command.key, entry);
      const controller = new AbortController(); controllers.add(controller);
      try {
        const receipt = await json(context, routeFor(command), persistenceReceiptSchema, { command, signal: controller.signal });
        validateReceipt(command, receipt);
        try { update(context, command.key, null); }
        catch { throw clientError('journal_unavailable', '消息已提交，但本地回执未保存；请核查原请求。', 'unknown'); }
        return receipt;
      } catch (error) {
        if (error.outcome !== 'unknown') update(context, command.key, null);
        throw error;
      } finally { controllers.delete(controller); }
    },
    async checkOperation(key) {
      if (!active?.boot || active.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      return check(active, key);
    },
    async retryOperation(key) {
      const context = active;
      if (!context?.boot || context.controller.signal.aborted) throw clientError('unavailable', '连接尚未恢复。');
      const entry = readJournal(context.boot).find(item => item.command.key === key);
      if (!entry) throw clientError('not_found', '没有待重试的原请求，请先核查消息记录。');
      if (entry.command.roomId !== context.scope.roomId) throw clientError('invalid_scope', '原请求不属于当前房间。');
      if (entry.outcome !== 'not_found') throw clientError('outcome_unknown', '请先核查原请求。', 'unknown');
      if (entry.command.type !== 'sendDiscussion') return this.command(entry.command);
      return this.command({ type: 'send', key, roomId: entry.command.roomId, text: entry.command.text, mode: 'discussion', mentions: [], ownerAgentId: null });
    },
  };
}
