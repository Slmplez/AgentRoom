const { test } = require('node:test');
const assert = require('node:assert/strict');
const state = (instanceId, revision, roomId = 'a') => ({ instanceId, revision, capabilities: { tasks: false }, agents: [], workspaces: [], rooms: [], approvals: [], messages: [{ id: 'message', roomId, sequence: 1, role: 'user', authorId: 'user', authorName: '你', text: instanceId, status: 'complete', createdAt: '' }] });

test('scope switches reject old responses and retired instances while unknown sends are never replayed', async t => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const callbacks = [], snapshots = [];
  let sends = 0, releases = 0;
  const client = createAgentRoomClient({ subscribe: fn => { callbacks.push(fn); return () => releases++; }, snapshot: () => new Promise(resolve => snapshots.push(resolve)), command: async () => { sends++; throw Object.assign(new Error('response lost'), { outcome: 'unknown', requestId: 'request-1' }); } });
  t.after(() => client.close());
  const first = client.open({ roomId: 'a' });
  callbacks[0]({ type: 'snapshot', data: state('old', 4) });
  const second = client.open({ roomId: 'b' });
  callbacks[1]({ type: 'snapshot', data: state('new', 1, 'b') });
  callbacks[0]({ type: 'snapshot', data: state('old', 99) });
  snapshots[0](state('old', 99)); snapshots[1](state('new', 0, 'b'));
  await Promise.all([first, second]);
  assert.equal(client.read().messages[0].roomId, 'b');
  callbacks[1]({ type: 'snapshot', data: state('restarted', 1, 'b') });
  callbacks[1]({ type: 'snapshot', data: state('new', 100, 'b') });
  assert.equal(client.read().instanceId, 'restarted');
  const command = { type: 'send', key: 'uncertain', roomId: 'b', text: 'hello', mode: 'discussion', ownerAgentId: null, mentions: [] };
  await assert.rejects(client.dispatch(command), /response lost/);
  await assert.rejects(client.dispatch(command), { code: 'outcome_unknown' });
  assert.equal(sends, 1);
  assert.equal(client.read().pendingOperations[0].key, 'uncertain');
  client.close(); assert.equal(releases, 2);
});

test('a missing delta base resynchronizes and close cancels scheduled reconnection', async () => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  let callback, reads = 0, connections = 0, releases = 0;
  const client = createAgentRoomClient({ snapshot: async () => state('one', ++reads), subscribe: fn => { callback = fn; connections++; return () => releases++; } });
  await client.open();
  callback({ type: 'delta', baseRevision: 100, offset: 90 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  callback({ type: 'offline' }); client.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(connections, 1); assert.equal(releases, 1);
});

test('offline subscription reconnects once through the client and releases the replaced stream', async t => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  let callback, connections = 0, releases = 0;
  const client = createAgentRoomClient({ snapshot: async () => state('one', connections), subscribe: fn => { callback = fn; connections++; return () => releases++; } });
  t.after(() => client.close());
  await client.open(); callback({ type: 'offline' });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(connections, 2); assert.equal(releases, 1);
  assert.equal(client.read().connection, 'live');
});
