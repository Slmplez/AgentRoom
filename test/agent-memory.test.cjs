const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function setup(t, options = {}) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'ar-memory-'));
  const runtime = await createApplicationRuntime({ directory, knownAgents: ['iris', 'ember'], ...options });
  const http = await startPersistenceHttp({ runtime });
  const actor = runtime.owner, boot = runtime.query({ type: 'bootstrap' }, actor), workspaceId = boot.workspace.id;
  const request = async (route, input, key, headers = {}) => {
    const response = await fetch(http.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${http.token}`, ...(input ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}), ...headers }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const close = async () => { await http.close(); runtime.close(); }; t.after(close);
  return { directory, runtime, actor, boot, workspaceId, request, close,
    command: (input, key = 'key') => request('/agent-memory/commands', { workspaceId, ...input }, key),
    query: input => runtime.query({ workspaceId, ...input }, actor),
    room: key => runtime.execute({ type: 'createRoom', workspaceId, title: key, key }, actor).roomId,
  };
}
const scope = { kind: 'agent', agentId: 'iris' };
const save = (text, target = scope) => ({ type: 'saveExplicitMemory', scope: target, text, source: { kind: 'owner-note' } });
const soul = (agentId, personality, expectedRevision = 0) => ({ type: 'editAgentSoul', agentId, expectedRevision, personality, expression: '简洁', workStyle: '核查来源' });

test('authenticated memory lifecycle keeps exact source, history, independent Souls and durable tombstones', async t => {
  let s = await setup(t);
  assert.equal((await s.request('/agent-memory/query', { type: 'agentSoul', workspaceId: s.workspaceId, agentId: 'iris' }, null, { authorization: 'wrong' })).status, 401);
  assert.equal((await s.command(soul('iris', '审慎'), 'iris')).status, 200);
  assert.equal((await s.command(soul('ember', '热情'), 'ember')).status, 200);
  assert.equal((await s.command(save('Iris preference'), 'private')).status, 200);
  assert.deepEqual(s.query({ type: 'explicitMemories', scope: { kind: 'agent', agentId: 'ember' } }).memories, []);
  const roomId = s.room('source-room'), roomScope = { kind: 'room', roomId };
  const message = s.runtime.execute({ type: 'sendDiscussion', workspaceId: s.workspaceId, roomId, key: 'message', text: '星期五开会，日期还没有确定。' }, s.actor);
  const input = { type: 'saveExplicitMemory', scope: roomScope, text: '星期五开会', source: { kind: 'message', messageId: message.messageId, revision: 1 } };
  const first = await s.command(input, 'remember'); assert.equal(first.status, 200);
  const id = first.data.entityId;
  assert.deepEqual((await s.command(input, 'remember')).data, first.data);
  assert.equal((await s.command({ ...input, text: '不同内容' }, 'remember')).status, 409);
  assert.equal((await s.command(input, 'same-source')).data.entityId, id);
  assert.equal((await s.command({ ...input, text: '改成星期六' }, 'same-source-new-text')).data.code, 'conflict');
  const update = { type: 'correctExplicitMemory', scope: roomScope, memoryId: id, expectedRevision: 1, text: '改到星期六，仍没有确定日期。' };
  assert.equal((await s.command(update, 'correct')).data.revision, 2);
  const history = s.query({ type: 'explicitMemoryHistory', scope: roomScope, memoryId: id });
  assert.deepEqual(history.revisions.map(x => x.revision), [2, 1]);
  assert.equal(history.sources.find(x => x.kind === 'message').text, '星期五开会，日期还没有确定。');
  assert.equal(history.sources.find(x => x.kind === 'message').authorId, s.actor.principalId);
  assert.equal(history.sources.find(x => x.kind === 'owner-note').text, update.text);
  assert.equal((await s.command({ type: 'forgetExplicitMemory', scope: roomScope, memoryId: id, expectedRevision: 2 }, 'forget')).data.status, 'deleted');
  assert.deepEqual(s.query({ type: 'explicitMemories', scope: roomScope }).memories, []);
  // A past success remains a receipt, never a command to restore its old value.
  assert.deepEqual((await s.command(input, 'remember')).data, first.data);
  assert.deepEqual(s.query({ type: 'explicitMemories', scope: roomScope }).memories, []);
  assert.equal((await s.command(input, 'replay-new-key')).data.code, 'memory_deleted');
  assert.equal((await s.command({ ...update, expectedRevision: 3 }, 'restore')).data.code, 'memory_deleted');
  const firstPage = s.query({ type: 'explicitMemoryHistory', scope: roomScope, memoryId: id, limit: 1 });
  assert.equal(firstPage.revisions[0].status, 'deleted'); assert.equal(firstPage.beforeRevision, 3);
  assert.equal(s.query({ type: 'explicitMemoryHistory', scope: roomScope, memoryId: id, limit: 1, beforeRevision: 3 }).revisions[0].revision, 2);
  const events = s.runtime.query({ type: 'events', roomId }, s.actor);
  const { persistenceEventSchema } = await import('../contracts/persistence.mjs');
  for (const event of events.events) assert.equal(persistenceEventSchema.safeParse(event).success, true);
  assert.deepEqual(events.events.map(x => x.type), ['room.created', 'message.created']);
  const { directory } = s; await s.close(); s = await setup(t, { directory });
  assert.equal(s.query({ type: 'agentSoul', agentId: 'iris' }).personality, '审慎');
  assert.equal(s.query({ type: 'agentSoul', agentId: 'ember' }).personality, '热情');
  assert.equal((await s.command(soul('iris', '证据优先', 1), 'edit-iris')).data.revision, 2);
  assert.equal(s.query({ type: 'agentSoul', agentId: 'ember' }).revision, 1);
  assert.equal(s.query({ type: 'agentSoulHistory', agentId: 'iris', limit: 1 }).beforeRevision, 2);
  assert.equal((await s.command(input, 'after-restart')).data.code, 'memory_deleted');
  assert.deepEqual((await s.request(`/operations/${first.data.operationId}`)).data, first.data);
  assert.deepEqual((await s.request(`/operations?workspaceId=${s.workspaceId}&commandType=saveExplicitMemory&key=remember`)).data, first.data);
});

test('owner, registered identity, scope and provenance are enforced for writes, reads and receipts', async t => {
  const s = await setup(t), roomId = s.room('a'), otherRoomId = s.room('b');
  const message = s.runtime.execute({ type: 'sendDiscussion', workspaceId: s.workspaceId, roomId, key: 'msg', text: 'private source' }, s.actor);
  const input = { type: 'saveExplicitMemory', scope: { kind: 'room', roomId }, text: 'fact', source: { kind: 'message', messageId: message.messageId, revision: 1 } };
  const receipt = (await s.command(input)).data;
  for (const forged of [{ ...input, scope: { kind: 'room', roomId: otherRoomId } }, { ...input, scope }, { ...input, source: { ...input.source, revision: 2 } }, { ...input, source: { ...input.source, text: 'forged' } }, { ...input, authorId: s.actor.principalId }]) assert.equal((await s.command(forged, 'invalid')).status, 400);
  assert.equal((await s.command(soul('unknown', 'evil'))).status, 404);
  assert.equal((await s.request('/agent-memory/commands', { type: 'createRoom', workspaceId: s.workspaceId, title: 'bypass' }, 'bad')).status, 400);
  assert.equal((await s.request('/agent-memory/query', { type: 'bootstrap' })).status, 400);
  assert.equal((await s.request('/agent-memory/query', { type: 'agentSoul', workspaceId: s.workspaceId, agentId: 'iris' }, null, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.throws(() => s.runtime.query({ type: 'explicitMemoryHistory', workspaceId: s.workspaceId, scope: input.scope, memoryId: receipt.entityId }, { principalId: 'iris' }), { code: 'forbidden' });
  assert.throws(() => s.query({ type: 'explicitMemoryHistory', scope: { kind: 'room', roomId: otherRoomId }, memoryId: receipt.entityId }), { code: 'not_found' });
  assert.equal((await s.command({ ...save('x'), workspaceId: 'wrong' })).status, 404);
  assert.equal((await s.command({ ...save('x'), query: 'semantic search' })).status, 400);
});

test('capacity, Unicode and competing revisions reject changes without silently losing data', async t => {
  const s = await setup(t);
  assert.equal((await s.command({ ...soul('iris', '😀'.repeat(2048)), expression: '', workStyle: '' }, 'unicode-soul')).status, 200);
  assert.equal((await s.command({ ...soul('iris', '😀'.repeat(2049), 1), expression: '', workStyle: '' }, 'oversize-soul')).status, 400);
  assert.equal((await s.command(save('😀'.repeat(257)), 'oversize')).status, 400);
  const first = (await s.command(save('😀'.repeat(256)), 'first')).data;
  for (let i = 1; i < 16; i++) assert.equal((await s.command(save('note-' + i), 'n-' + i)).status, 200);
  assert.equal((await s.command(save('overflow'), 'overflow')).data.code, 'limit_exceeded');
  const revise = { type: 'correctExplicitMemory', scope, memoryId: first.entityId, expectedRevision: 1, text: 'new' };
  const outcomes = await Promise.all([s.command(revise, 'race-a'), s.command({ ...revise, text: 'other' }, 'race-b')]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), [200, 409]);
  assert.equal(s.query({ type: 'explicitMemories', scope }).memories.length, 16);
  assert.equal((await s.command({ type: 'forgetExplicitMemory', scope, memoryId: first.entityId, expectedRevision: 2 }, 'forget')).status, 200);
  assert.equal((await s.command(save('space after stop'), 'space')).status, 200);
  assert.equal(s.query({ type: 'explicitMemoryHistory', scope, memoryId: first.entityId }).current.status, 'deleted');
  assert.equal(s.query({ type: 'agentSoul', agentId: 'iris' }).personality, '😀'.repeat(2048));
});

test('reconfiguring execution model does not reassign a persistent Agent identity', async t => {
  let s = await setup(t, { execution: { agentId: 'iris', model: 'first', createEngine() { throw Error('not executing'); } } });
  await s.command(soul('iris', 'stable personality'), 'soul'); const directory = s.directory; await s.close();
  s = await setup(t, { directory, execution: { agentId: 'iris', model: 'second', createEngine() { throw Error('not executing'); } } });
  assert.equal(s.query({ type: 'agentSoul', agentId: 'iris' }).personality, 'stable personality');
});
