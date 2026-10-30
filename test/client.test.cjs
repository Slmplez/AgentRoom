const { test } = require('node:test');
const assert = require('node:assert/strict');

test('client preserves newer events when the initial snapshot arrives late and releases its subscription', async () => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  let deliver, finishSnapshot, released = 0;
  const transport = {
    subscribe(listener) { deliver = listener; return () => released++; },
    snapshot() { return new Promise(resolve => { finishSnapshot = resolve; }); },
  };
  const snapshot = revision => ({ instanceId: 'server', revision, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], capabilities: { tasks: false } });
  const client = createAgentRoomClient(transport);
  const opening = client.open();
  deliver({ type: 'snapshot', data: snapshot(2) });
  finishSnapshot(snapshot(1));
  await opening;
  assert.equal(client.read().revision, 2);
  assert.equal(client.read().connection, 'live');
  client.close();
  assert.equal(released, 1);
  deliver({ type: 'snapshot', data: snapshot(3) });
  assert.equal(client.read().revision, 2);
  assert.equal(client.read().connection, 'offline');
});

test('backend projection hides engine protocol fields and keeps a reply ID across stream completion', async () => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { createChatProjection } = await import('../lib/chat-projection.mjs');
  const project = createChatProjection();
  let listener;
  const raw = { sync: { instanceId: 'legacy', revision: 1 }, connection: 'connected', workspaces: [{ id: 'w', title: 'Work', directory: 'C:/work' }],
    rooms: [{ id: 'r', title: 'Room', thread: 'room-thread', workspaceId: 'w', allMembers: true }], messages: [],
    agents: [{ id: 'a', name: 'alpha', displayName: 'Alpha', tool: 'codex', workspaceId: 'w', status: 'active', rpc: { current: { id: 4, thread: 'room-thread' }, partial: 'Hello', approvals: [{ id: 'p', kind: 'permission', data: { method: 'item/permissions/requestApproval', command: 'check' } }] } }] };
  const transport = { snapshot: async () => project(raw), subscribe: fn => { listener = fn; return () => {}; } };
  const client = createAgentRoomClient(transport);
  await client.open();
  const id = client.read().messages[0].id;
  assert.equal(client.read().messages[0].status, 'running');
  assert.equal(client.read().approvals[0].scopeLabel, '当前任务轮次');
  assert.equal(JSON.stringify(client.read()).includes('item/permissions'), false);
  raw.sync.revision++;
  raw.messages = [{ id: '5', sender: 'a', senderName: 'Alpha', human: false, thread: 'room-thread', replyTo: '4', text: 'Hello world', timestamp: '2026-10-30T08:00:00Z' }];
  raw.agents[0].rpc.current = null;
  listener({ type: 'snapshot', data: project(raw) });
  assert.equal(client.read().messages.length, 1);
  assert.equal(client.read().messages[0].id, id);
  assert.equal(client.read().messages[0].text, 'Hello world');
  client.close();
});

test('mock and client deliver one stable streamed reply, isolate approval decisions and retain state while offline', async () => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { createMockTransport } = await import('../renderer/client/mock.mjs');
  const mock = createMockTransport({ manual: true });
  const client = createAgentRoomClient(mock.transport);
  await client.open();
  const command = { type: 'send', key: 'first', roomId: 'room-design', text: '请检查', mode: 'task', ownerAgentId: 'alpha', mentions: [] };
  await client.dispatch(command);
  const reply = client.read().messages.at(-1);
  assert.equal(reply.authorId, 'alpha');
  assert.equal(reply.status, 'running');
  mock.control.advance();
  mock.control.advance();
  assert.equal(client.read().messages.at(-1).id, reply.id);
  assert.equal(client.read().messages.at(-1).status, 'complete');
  await client.dispatch(command);
  assert.equal(client.read().messages.filter(m => m.id === reply.id).length, 1);
  mock.control.approval('questions');
  const request = client.read().approvals[0];
  await assert.rejects(client.dispatch({ type: 'decide', approvalId: request.id, expectedRevision: request.revision + 1, allow: true }), { code: 'conflict' });
  await client.dispatch({ type: 'decide', approvalId: request.id, expectedRevision: request.revision, allow: true, answers: [['保持现有布局']] });
  assert.equal(client.read().approvals.length, 0);
  await assert.rejects(client.dispatch({ type: 'decide', approvalId: request.id, expectedRevision: request.revision, allow: true }), { code: 'expired' });
  const count = client.read().messages.length;
  mock.control.disconnect();
  await assert.rejects(client.dispatch({ ...command, key: 'offline' }), { code: 'unavailable' });
  assert.equal(client.read().messages.length, count);
  mock.control.reconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.read().connection, 'live');
  client.close(); mock.control.dispose();
});
