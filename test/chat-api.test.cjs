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

for (const mode of ['backend', 'mock']) test(`${mode} connection commands preserve, replace and clear credentials without exposing values`, async t => {
  let client;
  if (mode === 'backend') {
    const fixtureResult = await fixture(t); client = fixtureResult.client;
    fixtureResult.service.connections.secretStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() };
  } else {
    const { createMockTransport } = await import('../renderer/client/mock.mjs');
    const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
    const mock = createMockTransport({ manual: true }); client = createAgentRoomClient(mock.transport);
    t.after(() => { client.close(); mock.control.dispose(); }); await client.open();
  }
  const profile = { name: '本地', baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'chat', model: 'example', authMode: 'bearer', contextWindow: 8192, maxTokens: 1024 };
  const credentials = { apiKey: { action: 'replace', value: 'never-in-public-state' }, passphrase: { action: 'keep' } };
  const receipt = await client.dispatch({ type: 'saveConnection', key: 'save', profile, credentials });
  const id = receipt.entityId;
  assert.ok(id);
  let listed = await client.query({ type: 'connections' });
  assert.equal(listed.profiles.find(p => p.id === id).hasApiKey, true);
  assert.doesNotMatch(JSON.stringify([listed, client.read(), receipt]), /never-in-public-state/);
  await client.dispatch({ type: 'saveConnection', key: 'keep', id, profile: { ...profile, name: '改名' }, credentials: { apiKey: { action: 'keep' }, passphrase: { action: 'keep' } } });
  listed = await client.query({ type: 'connections' });
  assert.equal(listed.profiles.find(p => p.id === id).hasApiKey, true);
  await client.dispatch({ type: 'saveConnection', key: 'clear', id, profile: { ...profile, authMode: 'none' }, credentials: { apiKey: { action: 'clear' }, passphrase: { action: 'keep' } } });
  assert.equal((await client.query({ type: 'connections' })).profiles.find(p => p.id === id).hasApiKey, false);
  await assert.rejects(client.dispatch({ type: 'saveConnection', key: 'invalid', profile: { ...profile, name: '' }, credentials }), { code: 'invalid_command' });
  await client.dispatch({ type: 'removeConnection', key: 'remove', id });
  assert.equal((await client.query({ type: 'connections' })).profiles.some(p => p.id === id), false);
});

test('room membership commands preserve workspace boundaries and return only receipts', async t => {
  const { client } = await fixture(t);
  const workspaceId = client.read().workspaces[0].id, agentId = client.read().agents[0].id;
  const room = await client.dispatch({ type: 'createRoom', key: 'room', title: '审阅', workspaceId, memberIds: [agentId] });
  assert.ok(room.entityId); assert.equal('state' in room, false);
  await client.dispatch({ type: 'setRoomMembers', key: 'members', roomId: room.entityId, memberIds: [agentId] });
  assert.deepEqual(client.read().rooms.find(r => r.id === room.entityId).memberIds, [agentId]);
  await assert.rejects(client.dispatch({ type: 'setRoomMembers', key: 'invalid-member', roomId: room.entityId, memberIds: ['other-workspace-agent'] }), { code: 'invalid_members', outcome: 'rejected' });
});

test('backend capability and telemetry queries expose allowlisted read models', async t => {
  const { client, service } = await fixture(t);
  const directory = path.join(service.dataDir, 'skill'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: example\ndescription: Local example\n---\nExample skill');
  const skill = await client.dispatch({ type: 'importSkill', key: 'skill', directory });
  const workspaceId = client.read().workspaces[0].id;
  await client.dispatch({ type: 'bindCapabilities', key: 'bind', workspaceId, serverIds: [], skillIds: [skill.entityId] });
  const library = await client.query({ type: 'capabilities' });
  assert.equal(library.skills[0].name, 'example'); assert.deepEqual(library.bindings[0].skillIds, [skill.entityId]);
  const contexts = await client.query({ type: 'contexts' });
  assert.equal(contexts.agents[0].context.used, null);
  service.state.agents[0].context = { used: 123, window: 128000, source: 'gateway', reason: null, updatedAt: new Date().toISOString() };
  assert.equal((await client.query({ type: 'contexts' })).agents[0].context.used, 123);
  const usage = await client.query({ type: 'usage' });
  assert.equal(usage.days.length, 364);
  assert.doesNotMatch(JSON.stringify([contexts, usage, library]), /encryptedSecrets|transcript_path|backendSessionId/);
  await client.dispatch({ type: 'removeCapability', key: 'remove', kind: 'skills', id: skill.entityId });
  assert.equal((await client.query({ type: 'capabilities' })).skills.length, 0);
});

test('tool summaries stay bounded and details are fetched by opaque identity or report expiry', async t => {
  const execution = { alive: true, current: null, partial: '工具运行中', tools: [], approvals: [] };
  const { client, service } = await fixture(t, false, execution);
  execution.current = { id: 50, thread: service.findRoom(client.read().rooms[0].id).thread };
  execution.tools = [{ id: 'tool-1', turnId: '50', kind: 'edit', status: 'completed', detail: 'file.js', output: 'x'.repeat(20000), diffs: [{ patch: '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n' }] }];
  await service.refresh();
  const tool = client.read().messages[0].tools[0];
  assert.equal(tool.output.length, 300); assert.deepEqual(tool.patches, []); assert.equal(tool.hasDiff, true);
  const detail = await client.query({ type: 'toolDetails', ref: tool.detailRef });
  assert.equal(detail.output.length, 16000); assert.equal(detail.truncated, true); assert.match(detail.patches[0], /\+new/);
  execution.tools = []; await service.refresh();
  await assert.rejects(client.query({ type: 'toolDetails', ref: tool.detailRef }), { code: 'expired', outcome: 'rejected' });
});

test('removing an Agent preserves its private history after service restart', async t => {
  const { client, service } = await fixture(t);
  const roomId = client.read().rooms.find(r => r.type === 'dm').id;
  await client.dispatch({ type: 'send', key: 'private', roomId, text: '保留历史', mode: 'discussion', ownerAgentId: null, mentions: [] });
  service.state.agents[0].status = 'inactive';
  await client.dispatch({ type: 'removeAgent', key: 'remove', agentId: 'alpha' });
  assert.equal(client.read().agents.length, 0);
  assert.deepEqual(client.read().rooms.find(r => r.id === roomId).memberIds, []);
  assert.equal(client.read().messages[0].text, '保留历史');
  const restarted = new HcomService({ dataDir: service.dataDir, run: service.run });
  try {
    await restarted.start();
    const { createChatApi } = await import('../lib/chat-api.mjs');
    const api = createChatApi(restarted);
    try { const response = await api.request({ type: 'snapshot' }); assert.equal(response.ok, true); assert.equal(response.value.messages[0].text, '保留历史'); assert.equal(response.value.agents.length, 0); }
    finally { api.close(); }
  } finally { await restarted.close(); }
});

test('public capabilities redact legacy credential arguments and reject new plaintext credentials', async t => {
  const { client, service } = await fixture(t);
  await service.library.saveServer({ name: 'legacy', transport: 'http', url: 'https://example.com/mcp?api_key=secret-url', enabled: true, isolation: 'session' });
  await service.library.saveServer({ name: 'legacy cli', transport: 'stdio', command: 'node', args: ['server.js', '--token', 'secret-cli', 'https://example.com/mcp?token=secret-arg-url', '--header', 'Authorization: Bearer secret-header'], enabled: true, isolation: 'session' });
  const view = await client.query({ type: 'capabilities' });
  assert.doesNotMatch(JSON.stringify(view), /secret-url|secret-cli|secret-arg-url|secret-header/);
  assert.ok(view.servers.every(s => s.redacted));
  await assert.rejects(client.dispatch({ type: 'saveCapabilityServer', key: 'unsafe', server: { name: 'unsafe', transport: 'http', url: 'https://example.com/mcp?token=secret', enabled: true, isolation: 'session' } }), { code: 'invalid_command' });
});

test('unacknowledged approval writes report unknown and cannot be repeated', async t => {
  const execution = { alive: true, current: null, approvals: [{ id: 'approval-write', kind: 'permission', data: { title: '运行检查' } }] };
  const { client, service } = await fixture(t, false, execution); let writes = 0;
  service.respondSession = async () => { writes++; return { delivery: 'unknown' }; };
  const request = client.read().approvals[0];
  const command = { type: 'decide', approvalId: request.id, expectedRevision: request.revision, allow: false };
  await assert.rejects(client.dispatch(command), { outcome: 'unknown' });
  await assert.rejects(client.dispatch(command), { code: 'outcome_unknown' });
  assert.equal(writes, 1);
});

test('catalog refresh discovers installed engines through the public query', async t => {
  const { client, service } = await fixture(t), run = service.run;
  service.run = async args => args[0] === 'status' ? JSON.stringify({ tools: { pi: { installed: true } } }) : run(args);
  assert.equal((await client.query({ type: 'catalog' })).engines.length, 0);
  assert.equal((await client.query({ type: 'catalog', refresh: true })).engines.find(e => e.id === 'pi').installed, true);
});
