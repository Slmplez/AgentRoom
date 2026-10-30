const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HcomService } = require('../lib/hcom-service.cjs');

async function fixture(t, sendFailure, execution) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-chat-'));
  const events = [];
  const service = new HcomService({ dataDir: directory, run: async args => {
    if (args[0] === 'list') return JSON.stringify([{ name: 'alpha', tool: 'pi', directory, status: 'listening', rpc: execution }]);
    if (args[0] === 'events') return events.map(e => JSON.stringify(e)).join('\n');
    if (args[0] === 'send') {
      if (sendFailure) throw new Error('external process response lost');
      events.push({ id: 40 + events.length, type: 'message', ts: '2026-10-30T12:00:00Z', data: {
        from: 'user', sender_kind: 'external', text: args.at(-1), thread: args[args.indexOf('--thread') + 1], mentions: ['alpha'],
      } });
      return JSON.stringify({ event_id: events.at(-1).id });
    }
    throw new Error('Unexpected external operation');
  } });
  await service.refresh();
  const { createChatApi } = await import('../lib/chat-api.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { createChatTransport } = await import('../renderer/client/transport.mjs');
  const api = createChatApi(service);
  const client = createAgentRoomClient(createChatTransport({ request: input => api.request(input), subscribe: fn => api.subscribe(fn) }));
  t.after(async () => { client.close(); api.close(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.open();
  return { client, api, service };
}

test('chat sends to a public room and receives a validated projection without engine fields', async t => {
  const { client } = await fixture(t);
  const room = client.read().rooms.find(r => r.type === 'group');
  const receipt = await client.dispatch({ type: 'send', key: 'message-one', roomId: room.id, text: '请检查工作区', mode: 'discussion', ownerAgentId: null, mentions: [] });
  assert.equal(receipt.accepted, true);
  assert.equal(typeof receipt.operationId, 'string');
  assert.equal('state' in receipt, false);
  assert.deepEqual(client.read().messages.map(m => [m.roomId, m.text, m.role]), [[room.id, '请检查工作区', 'user']]);
  assert.equal(typeof client.read().messages[0].sequence, 'number');
  assert.equal(Object.isFrozen(client.read().messages[0]), true);
  assert.doesNotMatch(JSON.stringify(client.read()), /"(?:rpc|thread|sessionId|connections|secureStorageAvailable)":/);
});

test('chat distinguishes a rejected message from an uncertain external send', async t => {
  const { client } = await fixture(t, true);
  const roomId = client.read().rooms.find(r => r.type === 'group').id;
  const command = { type: 'send', key: 'failure', roomId, text: '   ', mode: 'discussion', ownerAgentId: null, mentions: [] };
  await assert.rejects(client.dispatch(command), { code: 'invalid_message', outcome: 'rejected' });
  await assert.rejects(client.dispatch({ ...command, text: '请检查' }), { code: 'send_unknown', outcome: 'unknown' });
  assert.equal(client.read().messages.length, 0);
});

test('a failed execution remains visible when the runtime clears its current turn', async t => {
  const execution = { current: null, partial: '', error: '', approvals: [] };
  const { client, service } = await fixture(t, false, execution);
  const roomId = client.read().rooms.find(r => r.type === 'group').id;
  const room = service.findRoom(roomId);
  execution.current = { id: 71, thread: room.thread };
  execution.partial = '正在检查';
  await service.refresh();
  const replyId = client.read().messages[0].id;
  execution.current = null;
  execution.partial = '';
  execution.error = '进程异常退出，结果未确认';
  await service.refresh();
  assert.deepEqual(client.read().messages.map(m => [m.id, m.roomId, m.status, m.text]), [[replyId, roomId, 'unknown', '进程异常退出，结果未确认']]);
});

test('public cancellation identifies the exact run and does not imply observed completion', async t => {
  const execution = { alive: true, current: null, partial: '', error: '', approvals: [], queue: [] };
  const { client, service } = await fixture(t, false, execution);
  execution.current = { id: 91, thread: service.findRoom(client.read().rooms[0].id).thread };
  execution.queue = [{ id: 92, thread: execution.current.thread }];
  await service.refresh();
  const calls = [];
  service.runtime = { cancel: async (id, turnId) => { calls.push([id, turnId]); execution.current.cancelRequested = true; }, close: async () => {} };
  const run = client.read().runs.find(r => r.status === 'running');
  await client.dispatch({ type: 'cancelRun', key: 'cancel', runId: run.id });
  assert.deepEqual(calls, [[run.agentId, '91']]);
  service.runtime = null;
  await service.refresh();
  assert.equal(client.read().runs.find(r => r.id === run.id).status, 'cancel_requested');
  assert.equal(client.read().runs.find(r => r.status === 'queued').queuePosition, 1);
  await assert.rejects(client.dispatch({ type: 'cancelRun', key: 'again', runId: run.id }), { code: 'not_running' });
});

test('an incompatible command error keeps an unknown outcome and a traceable error ID', async () => {
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { createChatTransport } = await import('../renderer/client/transport.mjs');
  const state = { instanceId: 'test', revision: 1, agents: [], rooms: [], workspaces: [], messages: [], approvals: [], capabilities: { tasks: false } };
  const client = createAgentRoomClient(createChatTransport({ subscribe: () => () => {}, request: async input => input.type === 'snapshot' ? { ok: true, value: state } : { ok: false, error: { message: 'old incompatible response' } } }));
  await client.open();
  await assert.rejects(client.dispatch({ type: 'send', key: 'unknown', roomId: 'room', text: 'hello', mode: 'discussion', ownerAgentId: null, mentions: [] }), error => {
    assert.equal(error.code, 'invalid_response');
    assert.equal(error.outcome, 'unknown');
    assert.equal(typeof error.requestId, 'string');
    assert.ok(error.requestId.length > 0);
    return true;
  });
  client.close();
});
