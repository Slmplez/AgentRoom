const { test } = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));
const send = { type: 'send', key: 'send-key', roomId: 'r', text: 'hello', mode: 'discussion', ownerAgentId: null, mentions: [] };
const snapshot = { instanceId: 'process', revision: 1, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], capabilities: { tasks: false } };

test('merged client validates legacy receipts and preserves persistent receipt identity fields', async t => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const receipt = { schemaVersion: 1, accepted: true, operationId: 'op', roomId: 'r', messageId: 'message', sequence: 1, cursor: 'opaque-cursor' };
  let raw = receipt, snapshots = 0;
  const persistent = createAgentRoomClient({
    synchronize(scope, emit) {
      const ready = Promise.resolve().then(() => emit({ type: 'persistence.ready', data: { instanceId: 'process' } }));
      return { ready, close() {} };
    },
    command: async () => raw,
    snapshot() { snapshots++; throw new Error('Persistent receipt must not trigger legacy refresh'); },
  });
  t.after(() => persistent.close()); await persistent.open({ roomId: 'r' });
  assert.deepEqual(await persistent.dispatch(send), receipt);
  raw = { accepted: true, operationId: 'op' };
  await assert.rejects(persistent.dispatch({ ...send, key: 'bad-receipt' }), { code: 'invalid_response', outcome: 'unknown' });
  assert.equal(snapshots, 0);

  const legacy = createAgentRoomClient({ subscribe: () => () => {}, snapshot: async () => snapshot, command: async () => raw });
  t.after(() => legacy.close()); await legacy.open();
  raw = { accepted: true, operationId: 'legacy-op', entityId: 'agent', delivery: 'confirmed', secret: 'never-public' };
  assert.deepEqual(await legacy.dispatch(send), { accepted: true, operationId: 'legacy-op', entityId: 'agent', delivery: 'confirmed' });
  raw = { accepted: true };
  await assert.rejects(legacy.dispatch({ ...send, key: 'unknown' }), { code: 'invalid_response', outcome: 'unknown' });
  await assert.rejects(legacy.dispatch({ ...send, key: 'unknown' }), { code: 'outcome_unknown' });
});

test('merged query rejects late results after scope change and close disposes watches plus SSE', async t => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  let resolveQuery, closedStreams = 0, polls = 0;
  const client = createAgentRoomClient({
    synchronize(scope, emit) { return { ready: Promise.resolve().then(() => emit({ type: 'persistence.ready', data: { instanceId: 'process' } })), close() { closedStreams++; } }; },
    query: () => { polls++; return new Promise(resolve => { resolveQuery = resolve; }); },
  });
  t.after(() => client.close()); await client.open({ roomId: 'first' });
  const result = client.query({ type: 'contexts' });
  const rejected = assert.rejects(result, { code: 'stale_query' });
  await client.open({ roomId: 'second' }); resolveQuery({ agents: [] }); await rejected;
  const updates = [];
  client.watch({ type: 'contexts' }, state => updates.push(state.status), { intervalMs: 250 });
  client.close(); resolveQuery({ agents: [] }); await tick();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(updates, ['loading']); assert.equal(polls, 2); assert.equal(closedStreams, 2);
});

test('persistent transport without management queries fails explicitly instead of invoking undefined', async t => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const client = createAgentRoomClient({ synchronize: () => ({ ready: Promise.resolve(), close() {} }) });
  t.after(() => client.close()); await client.open({ roomId: 'r' });
  await assert.rejects(client.query({ type: 'connections' }), { code: 'unsupported' });
  const updates = [], dispose = client.watch({ type: 'contexts' }, event => updates.push(event));
  await tick(); dispose();
  assert.deepEqual(updates.map(item => item.status), ['loading', 'error']);
  assert.match(updates[1].error, /不支持/);
});
