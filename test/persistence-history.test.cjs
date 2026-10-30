const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const DAY = 86400000, START = Date.parse('2026-01-01T00:00:00.000Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000) { const end = Date.now() + ms; do { if (await check()) return; await pause(20); } while (Date.now() < end); assert.ok(await check(), 'Expected state did not arrive'); }
function receive(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Timed out: ' + type)), 10000);
    const message = value => { if (value.type === type) done(null, value); };
    const exit = () => done(new Error('Backend exited before ' + type));
    function done(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
    child.on('message', message); child.once('exit', exit);
  });
}
function storage() { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-history-'));
  const children = new Set(), clients = new Set(), cleanup = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const fn of cleanup) await fn();
    for (const child of children) { const ended = once(child, 'exit'); child.kill(); await ended; }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('agentroom-history-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  async function start(now = START) {
    const child = fork(path.join(__dirname, 'fixtures/persistence-history-process.cjs'), [directory, String(now)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.add(child); child.once('exit', () => children.delete(child)); child.stderr.on('data', () => {});
    const ready = await receive(child, 'ready');
    const request = async (route, body, key = randomUUID()) => {
      const response = await fetch(ready.origin + '/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + ready.token, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      return { status: response.status, data: await response.json() };
    };
    const boot = (await request('/bootstrap')).data;
    return { ready, child, boot, request,
      create: async () => (await request('/rooms', { title: '历史讨论', workspaceId: boot.workspace.id })).data,
      send: async (roomId, text, key) => (await request(`/rooms/${roomId}/messages`, { workspaceId: boot.workspace.id, text }, key)).data,
      events: (roomId, after) => request(`/rooms/${roomId}/events?` + new URLSearchParams({ after })),
      async clock(now) { const waiting = receive(child, 'clock-set'); child.send({ type: 'clock', now }); await waiting; },
      async arm(point) { const waiting = receive(child, 'armed'); child.send({ type: 'arm', point }); await waiting; },
      async stop() { if (!children.has(child)) return; const ended = once(child, 'exit'); child.kill(); await ended; },
    };
  }
  async function client(server, roomId, options = {}) {
    const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
    const { createPersistentTransport } = await import('../renderer/client/persistent.mjs');
    const value = createAgentRoomClient(createPersistentTransport({ session: () => server().ready, backendId: 'history', localUserId: 'owner', storage: storage(), ...options }));
    clients.add(value); await value.open({ roomId }); assert.equal(value.read().connection, 'live', value.read().error); return value;
  }
  return { directory, cleanup, start, client };
}

test('public history pagination fixes its window while another client sends; pages never advance the SSE cursor', async t => {
  const env = await fixture(t), server = await env.start(), room = await server.create();
  for (let i = 1; i <= 350; i++) await server.send(room.roomId, '历史 ' + i);
  const reader = await env.client(() => server, room.roomId), writer = await env.client(() => server, room.roomId);
  assert.equal(reader.read().messages.length, 100); assert.equal(reader.read().beforeSequence, 251);
  const upper = reader.read().roomSequenceUpperBound;
  await writer.dispatch({ type: 'send', key: randomUUID(), roomId: room.roomId, text: '实时', mode: 'discussion', ownerAgentId: null, mentions: [] });
  await until(() => reader.read().messages.length === 101);
  const cursor = reader.read().cursor;
  assert.equal(await reader.loadOlderMessages({ limit: 200 }), 200);
  assert.equal(reader.read().cursor, cursor); assert.equal(reader.read().roomSequenceUpperBound, upper);
  assert.equal(await reader.loadOlderMessages(), 50); assert.equal(await reader.loadOlderMessages(), 0);
  assert.deepEqual(reader.read().messages.map(m => m.sequence), Array.from({ length: 351 }, (_, i) => i + 1));
  assert.equal(reader.read().beforeSequence, null);
  assert.equal((await server.request(`/rooms/${room.roomId}/messages?limit=201`)).status, 400);
  assert.equal((await server.request(`/rooms/${room.roomId}/messages?upperBound=999`)).status, 400);
});

test('seven-day cutoff is strict, prefix pruning survives restart and preserves receipts plus counters', async t => {
  const env = await fixture(t); let server = await env.start(); const room = await server.create(), key = randomUUID();
  const first = await server.send(room.roomId, '永久消息', key);
  await server.clock(START + DAY); const second = await server.send(room.roomId, '较新');
  await server.clock(START + 7 * DAY); await pause(80);
  assert.equal((await server.events(room.roomId, room.cursor)).status, 200, 'Exactly seven days remains replayable');
  await server.clock(START + 7 * DAY + 1);
  await until(async () => (await server.events(room.roomId, room.cursor)).data.code === 'resync_required');
  const atFloor = await server.events(room.roomId, first.cursor);
  assert.equal(atFloor.status, 200); assert.deepEqual(atFloor.data.events.map(e => e.entityId), [second.messageId]);
  await server.stop(); server = await env.start(START + 7 * DAY + 1);
  assert.equal((await server.events(room.roomId, room.cursor)).data.code, 'resync_required');
  assert.deepEqual(await server.send(room.roomId, '永久消息', key), first);
  const third = await server.send(room.roomId, '重启后'); assert.equal(third.sequence, 3);
  assert.equal((await server.request(`/rooms/${room.roomId}/messages`)).data.messages.length, 3);
  assert.equal((await server.events(room.roomId, second.cursor)).data.events[0].entityId, third.messageId);
});

test('clock rollback cannot prune an expired suffix past a fresh prefix', async t => {
  const env = await fixture(t), server = await env.start(), room = await server.create();
  await server.clock(START + 5 * DAY); const fresh = await server.send(room.roomId, '较新的前缀');
  await server.clock(START); const suffix = await server.send(room.roomId, '时钟回退后的旧时间');
  await server.clock(START + 7 * DAY + 1); await pause(80);
  const result = await server.events(room.roomId, room.cursor);
  assert.equal(result.status, 200); assert.deepEqual(result.data.events.map(e => e.entityId), [fresh.messageId, suffix.messageId]);
});

test('kill during pruning rolls back deletion and floor together', async t => {
  const env = await fixture(t); let server = await env.start(); const room = await server.create();
  const message = await server.send(room.roomId, '事务保护');
  await server.arm('after_prune'); const faulted = receive(server.child, 'fault');
  await server.clock(START + 8 * DAY); await faulted; await server.stop();
  server = await env.start(START);
  const replay = await server.events(room.roomId, room.cursor);
  assert.equal(replay.status, 200); assert.equal(replay.data.events[0].entityId, message.messageId);
});

test('expired resume rebuilds a bounded snapshot then pages all messages without changing scope or replaying drafts', async t => {
  const env = await fixture(t), server = await env.start(), room = await server.create();
  let snapshots = 0, posts = 0;
  const client = await env.client(() => server, room.roomId, { fetch: (url, init) => { if (url.endsWith('/snapshot')) snapshots++; if (init.method === 'POST') posts++; return fetch(url, init); } });
  const scope = client.read().scope; client.close();
  for (let i = 0; i < 230; i++) await server.send(room.roomId, '保留消息 ' + i);
  await server.clock(START + 8 * DAY);
  await until(async () => (await server.events(room.roomId, room.cursor)).data.code === 'resync_required');
  await client.open(); await until(() => client.read().connection === 'live');
  assert.equal(snapshots, 2); assert.equal(client.read().messages.length, 100); assert.strictEqual(client.read().scope, scope);
  assert.match(client.read().syncNotice, /旧历史/); assert.equal(posts, 0);
  while (client.read().beforeSequence !== null) await client.loadOlderMessages();
  assert.equal(client.read().messages.length, 230);
  await server.send(room.roomId, '新实时消息'); await until(() => client.read().messages.length === 231);
});

test('late history response after room change is rejected and cannot alter the new room', async t => {
  const env = await fixture(t), server = await env.start(), a = await server.create(), b = await server.create();
  for (let i = 0; i < 105; i++) await server.send(a.roomId, 'A ' + i);
  await server.send(b.roomId, 'B'); let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const client = await env.client(() => server, a.roomId, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (url.includes('/messages?')) { const text = await response.text(); reached(); await new Promise(resolve => { release = resolve; }); return new Response(text, { status: response.status }); }
    return response;
  } });
  const loading = client.loadOlderMessages(); const rejected = assert.rejects(loading, { code: 'stale_query' }); await waiting;
  await assert.rejects(client.loadOlderMessages(), { code: 'busy' });
  await client.open({ roomId: b.roomId }); release(); await rejected;
  assert.deepEqual(client.read().messages.map(m => m.text), ['B']); assert.equal(client.read().historyLoading, false);
});

test('active backlog reader is explicitly resynchronized when cleanup overtakes its last delivered cursor', async t => {
  const env = await fixture(t);
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  let now = START;
  const runtime = await createApplicationRuntime({ directory: env.directory, clock: () => now, maintenanceIntervalMs: 20 });
  const boot = runtime.query({ type: 'bootstrap' }, runtime.owner), room = runtime.execute({ type: 'createRoom', workspaceId: boot.workspace.id, title: '重放', key: randomUUID() }, runtime.owner);
  for (let i = 0; i < 3; i++) runtime.execute({ type: 'sendDiscussion', workspaceId: boot.workspace.id, roomId: room.roomId, text: '消息', key: randomUUID() }, runtime.owner);
  const watch = runtime.watch; let release, first;
  const delivered = new Promise(resolve => { first = resolve; });
  runtime.watch = (...args) => { const stream = watch(...args); return { close: () => stream.close(), async *[Symbol.asyncIterator]() {
    let count = 0; for await (const frame of stream) { yield frame; if (++count === 1) { first(); await new Promise(resolve => { release = resolve; }); } }
  } }; };
  const http = await startPersistenceHttp({ runtime }); env.cleanup.push(async () => { release?.(); await http.close(); runtime.close(); });
  const controller = new AbortController(); env.cleanup.unshift(() => controller.abort());
  const response = await fetch(http.origin + '/api/v1/events?' + new URLSearchParams({ roomId: room.roomId, after: room.cursor }), { headers: { Authorization: 'Bearer ' + http.token }, signal: controller.signal });
  const text = response.text(); await delivered; now = START + 8 * DAY;
  await until(() => { try { runtime.query({ type: 'events', roomId: room.roomId, after: room.cursor }, runtime.owner); return false; } catch (error) { return error.code === 'resync_required'; } });
  release(); assert.match(await text, /event: error\ndata: \{"code":"resync_required"\}/);
});
