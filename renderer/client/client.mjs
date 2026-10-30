import { snapshotSchema, commandSchema, clientError } from '../../contracts/chat.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const empty = () => ({ instanceId: '', revision: -1, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], approvalHistory: [], runs: [], capabilities: { tasks: false, idempotentSend: false } });

// The client owns the single projection, its subscription, recovery and uncertain operations.
export function createAgentRoomClient(transport) {
  let state = freeze({ ...empty(), connection: 'connecting', error: '', scope: {}, pendingOperations: [] });
  let generation = 0, unsubscribe, refreshNumber = 0, retryTimer, attempts = 0, closed = true, streamOffline = false, scope = {};
  const listeners = new Set(), inFlight = new Set(), retired = new Set(), uncertain = new Map();
  const publish = patch => { state = freeze({ ...state, ...patch }); for (const listener of listeners) listener(); };
  const scopeKey = () => JSON.stringify(scope);
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
    publish({ connection: state.instanceId ? 'resyncing' : 'connecting', error: '' });
    try {
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
    } catch (error) { if (epoch === generation) { publish({ connection: 'offline', error: error.message }); retry(epoch); } }
  }
  return {
    read: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open(nextScope = scope) {
      closed = false;
      const next = { ...(nextScope.workspaceId ? { workspaceId: String(nextScope.workspaceId) } : {}), ...(nextScope.roomId ? { roomId: String(nextScope.roomId) } : {}) };
      if (JSON.stringify(next) !== scopeKey()) { scope = next; publish({ ...empty(), scope, pendingOperations: [...uncertain.values()].filter(item => item.scope === scopeKey()) }); }
      return connect();
    },
    async dispatch(input) {
      if (state.connection !== 'live') throw clientError('unavailable', '连接尚未恢复，请稍后发送。');
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) throw clientError('invalid_command', '请求不符合聊天契约。');
      const command = parsed.data;
      const token = command.type === 'decide' ? command.approvalId : command.key;
      if (uncertain.has(token)) throw clientError('outcome_unknown', '此前操作结果未知，请核查后端记录；不会重复提交。', 'unknown');
      if (inFlight.has(token)) throw clientError('busy', '操作正在处理。');
      inFlight.add(token);
      const epoch = generation;
      const submittedInstance = state.instanceId, submittedScope = scopeKey();
      try {
        const receipt = await transport.command(command);
        if (epoch === generation) await refresh(epoch);
        return receipt;
      } catch (error) {
        if (error.outcome === 'unknown') {
          // Store identifiers only: credentials and user content never enter diagnostic state.
          uncertain.set(token, { key: token, type: command.type, scope: submittedScope, instanceId: submittedInstance, requestId: error.requestId || '', outcome: 'unknown' });
          if (!closed && submittedScope === scopeKey()) publish({ pendingOperations: [...uncertain.values()].filter(item => item.scope === scopeKey()) });
        }
        throw error;
      } finally { inFlight.delete(token); }
    },
    close() { closed = true; ++generation; ++refreshNumber; clearTimeout(retryTimer); retryTimer = undefined; unsubscribe?.(); unsubscribe = undefined; publish({ connection: 'offline' }); },
  };
}
