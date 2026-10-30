const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const until = async read => { const end = Date.now() + 6000; while (!await read()) { if (Date.now() > end) throw Error('State did not arrive'); await new Promise(r => setTimeout(r, 10)); } };
function storage() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), key: i => [...data.keys()][i] ?? null, get length() { return data.size; } }; }

test('public clients lazily read reports, preserve SSE/history refs and reject stale or foreign results', async t => {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs'), { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const { createPersistentTransport } = await import('../renderer/client/persistent.mjs'), { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-report-client-')); let publish, finish, reads = 0, hold, release, corrupt = false;
  const runtime = await createApplicationRuntime({ directory, execution: { agentId: 'reporter', artifacts: true, createEngine(context) { publish = context.publishArtifact; return { onQuestion() {}, async start() {}, prompt: () => new Promise(r => { finish = r; }), async close() { finish?.({ text: 'done', outcome: 'complete' }); } }; } } });
  const http = await startPersistenceHttp({ runtime }), clients = []; t.after(async () => { clients.forEach(c => c.close()); await http.close(); runtime.close(); });
  const workspaceId = runtime.query({ type: 'bootstrap' }, runtime.owner).workspace.id;
  const roomId = runtime.execute({ type: 'createRoom', workspaceId, key: 'room', title: 'Reports' }, runtime.owner).roomId;
  const other = runtime.execute({ type: 'createRoom', workspaceId, key: 'other', title: 'Other' }, runtime.owner).roomId;
  const make = async () => {
    const client = createAgentRoomClient(createPersistentTransport({ backendId: 'reports', localUserId: 'owner', storage: storage(), session: async () => ({ origin: http.origin, token: http.token }), fetch: async (url, options) => {
      const res = await fetch(url, options);
      if (/\/artifacts\//.test(url)) {
        reads++; if (hold) { hold = false; await new Promise(r => { release = r; }); }
        if (corrupt && /\/versions\/1$/.test(url)) { const body = await res.json(); body.spec.elements.r.props.action = 'execute'; return new Response(JSON.stringify(body), { status: 200 }); }
      }
      return res;
    } })); clients.push(client); await client.open({ roomId }); return client;
  };
  const a = await make(), b = await make();
  runtime.execute({ type: 'createLocalTask', workspaceId, roomId, key: 'task', ownerAgentId: 'reporter', goal: 'Report' }, runtime.owner); await until(() => finish);
  const input = { key: 'one', expectedVersion: 0, title: 'First', catalogVersion: 1, spec: { root: 'r', elements: { r: { type: 'Section', props: { title: 'First', description: 'Actual content' }, children: [] } } } };
  const receipt = publish(input); publish({ ...input, key: 'two', artifactId: receipt.artifactId, expectedVersion: 1, title: 'Second' });
  await until(() => a.read().messages.length === 2 && b.read().messages.length === 2);
  assert.equal(reads, 0, 'Messages never prefetch report bodies'); assert.equal(a.read().capabilities.readOnlyArtifacts, true);
  assert.deepEqual(a.read().messages.map(m => m.artifactRefs[0].version), [1, 2]);
  const q = { type: 'artifact', roomId, artifactId: receipt.artifactId, version: 1 };
  assert.equal((await a.query(q)).title, 'First');
  assert.equal((await b.query({ type: 'artifactVersions', roomId, artifactId: receipt.artifactId, limit: 1 })).beforeVersion, 2);
  await assert.rejects(a.query({ ...q, roomId: other }), { code: 'invalid_scope' });
  hold = true; const pending = a.query(q); const rejected = assert.rejects(pending, e => ['stale_query', 'transport_unavailable'].includes(e.code)); await until(() => release);
  await a.open({ roomId: other }); release(); await rejected; assert.equal(a.read().messages.length, 0);
  await a.open({ roomId }); corrupt = true; await assert.rejects(a.query(q), { code: 'invalid_response' }); corrupt = false;
  // Push the first report into history, then recover it through the public client.
  for (let i = 0; i < 101; i++) runtime.execute({ type: 'sendDiscussion', workspaceId, roomId, key: `history-${i}`, text: `Message ${i}` }, runtime.owner);
  a.close(); const c = await make(); assert.equal(c.read().messages.some(m => m.artifactRefs.length), false);
  await c.loadOlderMessages(); assert.deepEqual(c.read().messages.filter(m => m.artifactRefs.length).map(m => m.artifactRefs[0].version), [1, 2]);
  assert.equal((await c.query(q)).spec.elements.r.props.description, 'Actual content');
});

test('Mock reports use the same public contract and remain explicitly simulated', async () => {
  const { createMockTransport } = await import('../renderer/client/mock.mjs'), { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { transport, control } = createMockTransport({ manual: true }); const client = createAgentRoomClient(transport);
  try {
    await client.open(); control.artifact('room-design'); const ref = client.read().messages.at(-1).artifactRefs[0];
    const report = await client.query({ type: 'artifact', roomId: 'room-design', artifactId: ref.artifactId, version: ref.version });
    assert.match(report.title, /模拟/); assert.match(report.spec.elements.r.props.description, /没有调用 Agent/);
  } finally { client.close(); }
});
