import { snapshotSchema, commandSchema, clientError } from '../../contracts/chat.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

// The public module owns projections and synchronization. Transports never mutate the UI.
export function createAgentRoomClient(transport) {
  let state = freeze({ instanceId: '', revision: -1, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], capabilities: { tasks: false, idempotentSend: false }, connection: 'connecting', error: '' });
  let generation = 0, unsubscribe, refreshNumber = 0;
  const listeners = new Set(), inFlight = new Set();
  const publish = patch => { state = freeze({ ...state, ...patch }); for (const listener of listeners) listener(); };
  function accept(raw) {
    const next = snapshotSchema.parse(raw);
    if (state.instanceId === next.instanceId && next.revision < state.revision) return;
    publish({ ...next, connection: 'live', error: '' });
  }
  async function refresh(epoch) {
    const request = ++refreshNumber;
    try {
      const next = await transport.snapshot();
      if (epoch === generation && request === refreshNumber) accept(next);
    } catch (error) {
      if (epoch === generation && request === refreshNumber) publish({ connection: 'offline', error: error.message });
    }
  }
  return {
    read: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open() {
      unsubscribe?.();
      const epoch = ++generation;
      publish({ connection: 'connecting', error: '' });
      unsubscribe = transport.subscribe(event => {
        if (epoch !== generation) return;
        try {
          if (event.type === 'snapshot') {
            // An event is newer evidence than a pending initial HTTP response, including restarts.
            ++refreshNumber;
            accept(event.data);
          } else if (event.type === 'offline') { ++refreshNumber; publish({ connection: 'offline', error: '连接已断开，草稿已保留。' }); }
          else if (event.type === 'resync') { publish({ connection: 'resyncing' }); void refresh(epoch); }
        } catch { publish({ connection: 'offline', error: '服务端数据不符合聊天契约。' }); }
      });
      await refresh(epoch);
    },
    async dispatch(input) {
      if (state.connection !== 'live') throw clientError('unavailable', '连接尚未恢复，请稍后发送。');
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) throw clientError('invalid_command', '请求不符合聊天契约。');
      const command = parsed.data;
      const token = command.type === 'send' ? command.key : command.approvalId;
      if (inFlight.has(token)) throw clientError('busy', '操作正在处理。');
      inFlight.add(token);
      const epoch = generation;
      try {
        const receipt = await transport.command(command);
        if (epoch === generation) await refresh(epoch);
        return receipt;
      } finally { inFlight.delete(token); }
    },
    close() { ++generation; ++refreshNumber; unsubscribe?.(); unsubscribe = undefined; publish({ connection: 'offline' }); },
  };
}
