const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
function storage() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), key: i => [...map.keys()][i] ?? null, get length() { return map.size; } }; }
async function setup(t) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs'), { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const { createPersistentTransport } = await import('../renderer/client/persistent.mjs'), { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-memory-client-')); let runtime, http, drop = false, dropBefore = false, posts = 0, corrupt = false;
  const clients = [];
  const start = async () => { runtime = await createApplicationRuntime({ directory, knownAgents: ['iris', 'ember'] }); http = await startPersistenceHttp({ runtime }); };
  await start(); const workspaceId = runtime.query({ type: 'bootstrap' }, runtime.owner).workspace.id;
  const room = key => runtime.execute({ type: 'createRoom', workspaceId, key, title: key }, runtime.owner).roomId;
  const roomId = room('one'), other = room('two');
  const make = async (store = storage()) => {
    const client = createAgentRoomClient(createPersistentTransport({ backendId: 'memory-test', localUserId: 'owner', storage: store, session: async () => ({ origin: http.origin, token: http.token }), fetch: async (url, options) => {
      if (url.endsWith('/agent-memory/commands')) posts++;
      if (url.endsWith('/agent-memory/commands') && dropBefore) { dropBefore = false; throw Error('request lost before arrival'); }
      const res = await fetch(url, options);
      if (url.endsWith('/agent-memory/commands') && drop) { drop = false; throw Error('response lost after commit'); }
      if (url.endsWith('/agent-memory/query') && corrupt) { const data = await res.json(); data.agentId = 'foreign'; return new Response(JSON.stringify(data)); }
      return res;
    } })); clients.push(client); await client.open({ roomId }); return client;
  };
  t.after(async () => { clients.forEach(c => c.close()); await http.close(); runtime.close(); });
  return { workspaceId, roomId, other, make, drop: () => { drop = true; }, dropBefore: () => { dropBefore = true; }, corrupt: () => { corrupt = true; }, posts: () => posts,
    restart: async () => { clients.forEach(c => c.close()); await http.close(); runtime.close(); await start(); },
    soul: (agentId, personality, expectedRevision = 0) => ({ type: 'editAgentSoul', workspaceId, key: crypto.randomUUID(), agentId, expectedRevision, personality, expression: '', workStyle: '' }),
    save: (scope, text) => ({ type: 'saveExplicitMemory', workspaceId, scope, text, key: crypto.randomUUID(), source: { kind: 'owner-note' } }),
  };
}
test('public Client persists independent Souls, notes, exact message sources, correction and disable across restart', async t => {
  const s = await setup(t), a = await s.make(), b = await s.make();
  assert.deepEqual(a.read().knownAgents, ['iris', 'ember']); assert.equal(a.read().capabilities.agentMemory, true);
  await a.dispatch(s.soul('iris', '谨慎')); await a.dispatch(s.soul('ember', '活泼'));
  await assert.rejects(b.dispatch(s.soul('iris', '旧修改')), { code: 'conflict' });
  const scope = { kind: 'room', roomId: s.roomId }, q = { type: 'explicitMemories', workspaceId: s.workspaceId, scope };
  const msg = await a.dispatch({ type: 'send', key: 'message', roomId: s.roomId, text: '原文：周五开会，日期待定。', mode: 'discussion', mentions: [], ownerAgentId: null });
  const saved = await a.dispatch({ ...s.save(scope, '周五开会'), source: { kind: 'message', messageId: msg.messageId, revision: 1 } });
  await a.dispatch({ type: 'correctExplicitMemory', workspaceId: s.workspaceId, scope, memoryId: saved.entityId, expectedRevision: 1, text: '开会日期尚未确定', key: 'correct' });
  const historyQuery = { type: 'explicitMemoryHistory', workspaceId: s.workspaceId, scope, memoryId: saved.entityId, limit: 1 };
  const history = await b.query(historyQuery); assert.equal(history.beforeRevision, 2); assert.equal(history.sources[0].text, '原文：周五开会，日期待定。');
  assert.equal((await b.query({ ...historyQuery, beforeRevision: 2 })).revisions[0].text, '周五开会');
  await a.dispatch({ type: 'forgetExplicitMemory', workspaceId: s.workspaceId, scope, memoryId: saved.entityId, expectedRevision: 2, key: 'disable' });
  assert.deepEqual((await b.query(q)).memories, []); assert.equal((await b.query(historyQuery)).current.status, 'deleted');
  await a.dispatch(s.save({ kind: 'agent', agentId: 'iris' }, '😀'.repeat(256)));
  await assert.rejects(a.dispatch(s.save(scope, '😀'.repeat(257))), { code: 'invalid_command' });
  await assert.rejects(a.dispatch(s.save(scope, '   ')), { code: 'invalid_command' });
  for (let i = 0; i < 16; i++) await a.dispatch(s.save(scope, `note ${i}`));
  await assert.rejects(a.dispatch(s.save(scope, 'overflow')), { code: 'limit_exceeded' });
  await assert.rejects(a.query({ ...q, scope: { kind: 'room', roomId: s.other } }), { code: 'invalid_scope' });
  await a.open({ roomId: s.other }); assert.deepEqual((await a.query({ ...q, scope: { kind: 'room', roomId: s.other } })).memories, []);
  assert.deepEqual((await a.query({ ...q, scope: { kind: 'agent', agentId: 'ember' } })).memories, []);
  await s.restart(); const c = await s.make();
  assert.equal((await c.query({ type: 'agentSoul', workspaceId: s.workspaceId, agentId: 'iris' })).personality, '谨慎');
  assert.equal((await c.query(historyQuery)).current.status, 'deleted'); assert.equal((await c.query(q)).memories.length, 16);
  s.corrupt(); await assert.rejects(c.query({ type: 'agentSoul', workspaceId: s.workspaceId, agentId: 'iris' }), { code: 'invalid_response' });
});
test('lost memory responses retain original key, reload only checks and historical receipts never restore deleted data', async t => {
  const s = await setup(t), store = storage(), a = await s.make(store), b = await s.make();
  const scope = { kind: 'agent', agentId: 'iris' }, command = s.save(scope, '原记忆'), q = { type: 'explicitMemories', workspaceId: s.workspaceId, scope };
  s.drop(); await assert.rejects(a.dispatch(command), { outcome: 'unknown' }); assert.equal(a.read().pendingOperations[0].key, command.key);
  await assert.rejects(a.dispatch(s.save(scope, '新标识')), { code: 'outcome_unknown' });
  const memory = (await b.query(q)).memories[0];
  await b.dispatch({ type: 'forgetExplicitMemory', workspaceId: s.workspaceId, scope, key: 'delete', memoryId: memory.id, expectedRevision: memory.revision });
  const before = s.posts(); a.close(); const c = await s.make(store); assert.equal(s.posts(), before); assert.deepEqual(c.read().pendingOperations, []);
  assert.equal((await c.checkOperation(command.key, command.type)).status, 'active');
  assert.deepEqual((await c.query(q)).memories, []);
  const receipt = await c.dispatch(command); assert.equal(receipt.revision, 1); assert.deepEqual((await c.query(q)).memories, []);
});
test('Mock cannot save production memory', async () => {
  const { createMockTransport } = await import('../renderer/client/mock.mjs'), { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { transport } = createMockTransport({ manual: true }); const client = createAgentRoomClient(transport); await client.open();
  try { await assert.rejects(client.dispatch({ type: 'saveExplicitMemory', workspaceId: 'w', scope: { kind: 'agent', agentId: 'iris' }, key: 'key', text: 'note', source: { kind: 'owner-note' } }), { code: 'unsupported' }); } finally { client.close(); }
});
test('an unreceived memory submission survives reload and retries only the saved original command', async t => {
  const s = await setup(t), store = storage(), a = await s.make(store);
  const command = s.soul('iris', '原草稿'); s.dropBefore();
  await assert.rejects(a.dispatch(command), { outcome: 'unknown' }); a.close();
  const b = await s.make(store); assert.equal(s.posts(), 1); assert.equal(b.read().pendingOperations[0].outcome, 'not_found');
  await assert.rejects(b.dispatch({ ...command, personality: '改变原内容' }), { code: 'idempotency_conflict' });
  const result = await b.retryOperation(command.key); assert.equal(result.entityKind, 'soul'); assert.equal(s.posts(), 2);
  assert.equal((await b.query({ type: 'agentSoul', workspaceId: s.workspaceId, agentId: 'iris' })).personality, '原草稿');
  assert.deepEqual(b.read().pendingOperations, []);
});
