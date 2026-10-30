import { snapshotSchema, commandSchema, receiptSchema, clientError } from '../../contracts/chat.mjs';
import { persistenceSnapshotSchema, persistenceFrameSchema, persistenceReceiptSchema } from '../../contracts/persistence.mjs';

import { querySchema, queryResults } from '../../contracts/settings.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const empty = () => ({ instanceId: '', revision: -1, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], approvalHistory: [], runs: [], localTasks: [], localAgentId: null, currentUserId: null, capabilities: { tasks: false, idempotentSend: false, localExecution: false } });

// The client owns the single projection, its subscription, recovery and uncertain operations.
export function createAgentRoomClient(transport) {
  let state = freeze({ ...empty(), connection: 'connecting', error: '', scope: {}, pendingOperations: [] });
  let generation = 0, unsubscribe, refreshNumber = 0, retryTimer, attempts = 0, closed = true, streamOffline = false, scope = {};
  const watches = new Set();
  const listeners = new Set(), inFlight = new Set(), retired = new Set(), uncertain = new Map();
  let applied = null;
  let historyRequest = 0;
  const publish = patch => { state = freeze({ ...state, ...patch }); for (const listener of listeners) listener(); };
  const scopeKey = () => JSON.stringify(scope);
  function requireResync() {
    applied = null;
    publish({ syncNotice: '事件记录已不可续订，正在重新加载消息；旧历史仍可分页读取。' });
  }
  function acceptPersistence(event) {
    if (event.type === 'persistence.identity') {
      publish({ backendId: event.backendId });
      if (state.databaseId && state.databaseId !== event.data.databaseId) {
        applied = null;
        publish({ ...empty(), databaseId: event.data.databaseId, cursor: null, pendingOperations: [], databaseChanged: true, connection: 'resyncing', error: '后端数据库已更换，请重新确认；旧请求不会重发。' });
      }
    } else if (event.type === 'persistence.snapshot') {
      const data = persistenceSnapshotSchema.parse(event.data), boot = event.boot;
      if (data.room.id !== scope.roomId) throw clientError('invalid_scope', '快照范围不匹配。');
      // The projection and applied cursor are published together; listeners never see a cursor ahead of data.
      const next = snapshotSchema.parse({ instanceId: data.instanceId, revision: data.room.revision, agents: [], rooms: [{ ...data.room, type: 'group', memberIds: [boot.user.id] }], workspaces: [{ ...boot.workspace, directory: '' }], messages: data.messages, approvals: [], runs: [], currentUserId: boot.user.id, localTasks: data.localTasks, localAgentId: boot.localAgentId || null, capabilities: { tasks: false, idempotentSend: true, localExecution: boot.capabilities.localExecution } });
      applied = { databaseId: data.databaseId, roomId: data.room.id, cursor: data.cursor };
      publish({ ...next, messages: data.messages, databaseId: data.databaseId, cursor: data.cursor, roomSequenceUpperBound: data.roomSequenceUpperBound, beforeSequence: data.beforeSequence });
    } else if (event.type === 'persistence.frame') {
      if (!applied) throw clientError('resync_required', '需要先读取快照。');
      const frame = persistenceFrameSchema.parse(event.data);
      let messages = state.messages, localTasks = state.localTasks || [];
      if (frame.type === 'event') {
        const e = frame.data;
        if (e.roomId !== scope.roomId || e.workspaceId !== state.rooms[0]?.workspaceId) throw clientError('invalid_scope', '事件范围不匹配。');
        if (e.type === 'localTask.updated') {
          const old = localTasks.find(t => t.id === e.entityId);
          if (!old) localTasks = [e.payload, ...localTasks].slice(0, 100);
          else if (old.revision < e.entityRevision) localTasks = localTasks.map(t => t.id === e.entityId ? e.payload : t);
        }
        if (e.type === 'message.created') {
          const previous = messages.find(m => m.id === e.entityId);
          if (!previous || previous.revision < e.entityRevision) messages = [...messages.filter(m => m.id !== e.entityId), e.payload].sort((a, b) => a.sequence - b.sequence);
        }
      }
      const cursor = frame.type === 'event' ? frame.data.cursor : frame.cursor;
      applied = { ...applied, cursor };
      publish({ messages, localTasks, cursor });
    } else if (event.type === 'persistence.pending') {
      publish({ pendingOperations: event.data.filter(item => item.roomId === scope.roomId) });
    } else if (event.type === 'persistence.ready') {
      attempts = 0; streamOffline = false;
      publish({ instanceId: event.data.instanceId, currentUserId: event.data.user?.id ?? state.currentUserId, localAgentId: event.data.capabilities ? event.data.localAgentId || null : state.localAgentId, capabilities: { ...state.capabilities, localExecution: event.data.capabilities?.localExecution ?? state.capabilities.localExecution }, connection: 'live', syncNotice: state.syncNotice ? '事件记录已不可续订，已重新加载消息；旧历史仍可分页读取。' : '', error: state.databaseChanged ? '后端数据库已更换，请重新确认；旧请求不会重发。' : '' });
    }
  }
  function accept(raw) {
    const next = snapshotSchema.parse(raw);
    if (retired.has(next.instanceId) || (state.instanceId === next.instanceId && next.revision < state.revision)) return;
    if (state.instanceId && state.instanceId !== next.instanceId) { retired.add(state.instanceId); publish({ connection: 'resyncing' }); }
    const roomIds = new Set(next.rooms.filter(r => (!scope.workspaceId || r.workspaceId === scope.workspaceId) && (!scope.roomId || r.id === scope.roomId)).map(r => r.id));
    const inScope = item => !scope.workspaceId && !scope.roomId || roomIds.has(item.roomId) || item.roomId === scope.roomId;
    if (scope.workspaceId) {
      next.workspaces = next.workspaces.filter(w => w.id === scope.workspaceId);
      next.agents = next.agents.filter(a => a.workspaceId === scope.workspaceId);
      next.rooms = next.rooms.filter(r => r.workspaceId === scope.workspaceId);
    }
    next.messages = next.messages.filter(inScope);
    next.approvals = next.approvals.filter(inScope); next.approvalHistory = next.approvalHistory.filter(inScope); next.runs = next.runs.filter(inScope);
    // Full snapshots may skip revisions. Duplicate message identities replace, never append.
    next.messages = [...new Map(next.messages.map(m => [m.id, m])).values()].sort((a, b) => a.sequence - b.sequence);
    if (!streamOffline) { attempts = 0; clearTimeout(retryTimer); retryTimer = undefined; }
    publish({ ...next, connection: streamOffline ? 'offline' : 'live', error: streamOffline ? '实时连接尚未恢复。' : '' });
  }
  function retry(epoch) {
    if (closed || epoch !== generation || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; if (!closed && epoch === generation) void connect(); }, Math.min(250 * 2 ** attempts++, 8000));
    retryTimer.unref?.();
  }
  async function refresh(epoch) {
    const request = ++refreshNumber;
    try {
      const next = await transport.snapshot(scope);
      if (epoch === generation && request === refreshNumber) accept(next);
    } catch (error) {
      if (epoch === generation && request === refreshNumber) { publish({ connection: 'offline', error: error.message }); retry(epoch); }
    }
  }
  async function connect() {
    unsubscribe?.(); unsubscribe = undefined; clearTimeout(retryTimer); retryTimer = undefined;
    const epoch = ++generation;
    streamOffline = false;
    publish({ connection: state.instanceId ? 'resyncing' : 'connecting', error: '', historyLoading: false });
    try {
      if (transport.synchronize) {
        const sync = transport.synchronize(scope, event => {
          if (epoch !== generation || closed) return;
          try {
            if (event.type.startsWith('persistence.')) acceptPersistence(event);
            else {
              if (event.type === 'resync_required') requireResync();
              publish({ connection: 'offline', error: event.error?.message || '实时连接已断开。' }); retry(epoch);
            }
          } catch (error) { applied = null; unsubscribe?.(); publish({ connection: 'offline', error: error.message }); retry(epoch); }
        }, applied);
        unsubscribe = () => sync.close();
        await sync.ready;
        return;
      }
      unsubscribe = transport.subscribe(event => {
        if (epoch !== generation || closed) return;
        try {
          if (event.type === 'snapshot') { streamOffline = false; ++refreshNumber; accept(event.data); }
          else if (event.type === 'offline') { streamOffline = true; ++refreshNumber; publish({ connection: 'offline', error: '连接已断开，草稿已保留。' }); retry(epoch); }
          else if (['resync', 'resync_required', 'delta'].includes(event.type)) {
            // This migration protocol sends complete snapshots. Unsupported deltas require a fresh snapshot.
            streamOffline = false; publish({ connection: 'resyncing' }); void refresh(epoch);
          }
        } catch { publish({ connection: 'offline', error: '服务端数据不符合聊天契约。' }); retry(epoch); }
      }, scope);
      await refresh(epoch);
    } catch (error) { if (epoch === generation) { if (error.code === 'resync_required') requireResync(); unsubscribe?.(); publish({ connection: 'offline', error: error.message }); retry(epoch); } }
  }
  async function query(input) {
      const parsed = querySchema.safeParse(input);
      if (!parsed.success) throw clientError('invalid_query', '查询不符合公开契约。');
      if (!transport.query) throw clientError('unsupported', '当前后端不支持此查询。');
      const epoch = generation;
      const result = await transport.query(parsed.data);
      if (epoch !== generation) throw clientError('stale_query', '查询范围已变化。');
      const value = freeze(queryResults[parsed.data.type].parse(result));
      if (parsed.data.type === 'questionOperation' && (value.key !== parsed.data.key || value.questionId !== parsed.data.questionId)) throw clientError('invalid_response', '问题回执范围不匹配。', 'unknown');
      if (parsed.data.type === 'questionOperation' && value.found && uncertain.get(parsed.data.key)?.target === parsed.data.questionId) {
        uncertain.delete(parsed.data.key);
        publish({ pendingOperations: [...uncertain.values()].filter(item => item.scope === scopeKey()) });
      }
      return value;
    }
  return {
    read: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    query,
    watch(input, listener, { intervalMs = 5000 } = {}) {
      let disposed = false, timer;
      const poll = async () => {
        try { const value = await query(input); if (!disposed) listener({ status: "ready", value }); }
        catch (error) { if (!disposed) listener({ status: "error", error: error.message }); }
        if (!disposed) { timer = setTimeout(poll, Math.max(250, intervalMs)); timer.unref?.(); }
      };
      const dispose = () => { disposed = true; clearTimeout(timer); watches.delete(dispose); };
      watches.add(dispose); listener({ status: "loading" }); void poll(); return dispose;
    },
    async open(nextScope = scope) {
      closed = false;
      const next = { ...(nextScope.workspaceId ? { workspaceId: String(nextScope.workspaceId) } : {}), ...(nextScope.roomId ? { roomId: String(nextScope.roomId) } : {}) };
      if (JSON.stringify(next) !== scopeKey()) { scope = next; applied = null; publish({ ...empty(), scope, cursor: null, syncNotice: '', beforeSequence: null, roomSequenceUpperBound: null, pendingOperations: [...uncertain.values()].filter(item => item.scope === scopeKey()) }); }
      return connect();
    },
    async dispatch(input) {
      if (state.connection !== 'live') throw clientError('unavailable', '连接尚未恢复，请稍后发送。');
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) throw clientError('invalid_command', '请求不符合聊天契约。');
      const command = parsed.data;
      if (['createLocalTask', 'answerLocalQuestion'].includes(command.type) && !state.capabilities.localExecution) throw clientError('unsupported', '当前后端未启用本机只读执行。');
      if (command.type === 'answerQuestion' && !state.capabilities.collaborationQuestions) throw clientError('unsupported', '当前后端不支持协作问题。');
      if (['requestQuestionAdvice', 'adoptQuestionAdvice'].includes(command.type) && (!state.capabilities.collaborationQuestions || !state.capabilities.questionAdvice)) throw clientError('unsupported', '当前后端不支持 Agent 建议。');
      const token = command.type === 'decide' ? command.approvalId : command.key;
      const target = command.questionId || command.agentId || command.roomId || command.workspaceId || command.id || '';
      if (uncertain.has(token) || !['send', 'decide', 'cancelRun'].includes(command.type) && [...uncertain.values()].some(item => item.target === target && (item.type === command.type || command.questionId && ['answerQuestion', 'requestQuestionAdvice', 'adoptQuestionAdvice'].includes(item.type)))) throw clientError('outcome_unknown', '此前同类操作结果未知，请核查后端记录；不会使用新请求键重复提交。', 'unknown');
      if (inFlight.has(token)) throw clientError('busy', '操作正在处理。');
      inFlight.add(token);
      const epoch = generation;
      const submittedInstance = state.instanceId, submittedScope = scopeKey();
      try {
        const schema = transport.synchronize ? persistenceReceiptSchema : receiptSchema;
        const parsedReceipt = schema.safeParse(await transport.command(command));
        if (!parsedReceipt.success) throw clientError('invalid_response', '操作回执不符合公开契约，请核查结果。', 'unknown');
        const receipt = parsedReceipt.data;
        if (epoch === generation && !transport.synchronize) await refresh(epoch);
        return receipt;
      } catch (error) {
        if (error.outcome === 'unknown' && !transport.synchronize) {
          // Store identifiers only: credentials and user content never enter diagnostic state.
          uncertain.set(token, { key: token, type: command.type, target, scope: submittedScope, instanceId: submittedInstance, requestId: error.requestId || '', outcome: 'unknown' });
          if (!closed && submittedScope === scopeKey()) publish({ pendingOperations: [...uncertain.values()].filter(item => item.scope === scopeKey()) });
        }
        throw error;
      } finally { inFlight.delete(token); }
    },
    async checkOperation(key) {
      if (!transport.checkOperation) throw clientError('unsupported', '当前后端不支持回执核查。');
      return transport.checkOperation(key);
    },
    async retryOperation(key) {
      if (!transport.retryOperation) throw clientError('unsupported', '当前后端不支持原请求重试。');
      if (state.connection !== 'live') throw clientError('unavailable', '连接尚未恢复。');
      if (inFlight.has(key)) throw clientError('busy', '原请求正在提交。');
      inFlight.add(key);
      try {
        const receipt = persistenceReceiptSchema.safeParse(await transport.retryOperation(key));
        if (!receipt.success) throw clientError('invalid_response', '原请求回执无效，请再次核查。', 'unknown');
        return receipt.data;
      } finally { inFlight.delete(key); }
    },
    async loadOlderMessages({ limit = 100 } = {}) {
      if (!transport.history) throw clientError('unsupported', '当前后端不支持历史分页。');
      if (state.connection !== 'live') throw clientError('unavailable', '连接尚未恢复。');
      if (state.historyLoading) throw clientError('busy', '历史消息正在加载。');
      if (state.beforeSequence === null) return 0;
      const epoch = generation, request = ++historyRequest;
      const roomId = scope.roomId, beforeSequence = state.beforeSequence, upperBound = state.roomSequenceUpperBound;
      publish({ historyLoading: true });
      try {
        const page = await transport.history({ roomId, beforeSequence, upperBound, limit });
        if (closed || epoch !== generation || request !== historyRequest) throw clientError('stale_query', '历史范围已变化。');
        const messages = [...new Map([...page.messages, ...state.messages].map(message => [message.id, message])).values()].sort((a, b) => a.sequence - b.sequence);
        publish({ messages, beforeSequence: page.beforeSequence });
        return page.messages.length;
      } finally { if (epoch === generation && request === historyRequest) publish({ historyLoading: false }); }
    },
    close() { for (const dispose of [...watches]) dispose(); closed = true; ++generation; ++refreshNumber; clearTimeout(retryTimer); retryTimer = undefined; unsubscribe?.(); unsubscribe = undefined; publish({ connection: 'offline', historyLoading: false }); },
  };
}
