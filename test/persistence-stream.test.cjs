const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, timeout = 10000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await pause(20); } while (Date.now() < end);
  assert.ok(await check(), 'Expected state did not arrive');
}
function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Timed out: ' + type)), 15000);
    const message = value => { if (value.type === type) done(null, value); };
    const exit = () => done(new Error('Exited before: ' + type));
    function done(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
    child.on('message', message); child.once('exit', exit);
  });
}
function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), key: i => [...data.keys()][i] ?? null, get length() { return data.size; }, dump: () => JSON.stringify([...data]) };
}
function fileStorage(directory) {
  const sync = require('node:fs'); sync.mkdirSync(directory, { recursive: true });
  const filename = key => path.join(directory, require('node:crypto').createHash('sha256').update(key).digest('hex') + '.json');
  return {
    getItem(key) { try { return JSON.parse(sync.readFileSync(filename(key), 'utf8')).value; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    setItem(key, value) { sync.writeFileSync(filename(key), JSON.stringify({ key, value })); },
    removeItem(key) { try { sync.unlinkSync(filename(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    key(i) { const file = sync.readdirSync(directory)[i]; return file ? JSON.parse(sync.readFileSync(path.join(directory, file), 'utf8')).key : null; },
    get length() { return sync.readdirSync(directory).length; },
    dump() { return sync.readdirSync(directory).map(file => sync.readFileSync(path.join(directory, file), 'utf8')).join('\n'); },
  };
}
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-stream-'));
  const children = new Set(), clients = new Set(), streams = new Set(), disposers = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const stream of streams) await stream.close();
    for (const child of children) { const ended = once(child, 'exit'); child.kill(); await ended; }
    for (const dispose of disposers) await dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agentroom-stream-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  async function start(dir = directory) {
    const child = fork(path.join(__dirname, 'fixtures/persistence-process.cjs'), [dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.add(child); child.once('exit', () => children.delete(child));
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const ready = await waitMessage(child, 'ready').catch(error => { throw new Error(error.message + stderr); });
    const call = async (route, body, key = randomUUID(), headers = {}) => {
      const res = await fetch(ready.origin + '/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + ready.token, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      return { status: res.status, data: await res.json() };
    };
    const boot = (await call('/bootstrap')).data;
    return { ready, child, call, boot,
      create: async title => (await call('/rooms', { workspaceId: boot.workspace.id, title: title || '讨论' })).data,
      send: async (roomId, text = '你好', key) => (await call(`/rooms/${roomId}/messages`, { workspaceId: boot.workspace.id, text }, key)).data,
      async stop() { if (!children.has(child)) return; const ended = once(child, 'exit'); child.kill(); await ended; },
      async arm(point) { const armed = waitMessage(child, 'armed'); child.send({ type: 'arm', point }); await armed; },
    };
  }
  async function client(server, roomId, options = {}) {
    const { createPersistentTransport } = await import('../renderer/client/persistent.mjs');
    const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
    const { decorateTransport = value => value, ...transportOptions } = options;
    const transport = createPersistentTransport({ session: async () => server().ready, backendId: 'test-backend', localUserId: 'test-user', storage: memoryStorage(), ...transportOptions });
    const result = createAgentRoomClient(decorateTransport(transport)); clients.add(result);
    await result.open({ roomId });
    assert.equal(result.read().connection, 'live', result.read().error);
    return result;
  }
  async function stream(server, roomId, after) {
    const controller = new AbortController();
    const res = await fetch(server.ready.origin + '/api/v1/events?' + new URLSearchParams({ roomId, after }), { headers: { Authorization: 'Bearer ' + server.ready.token }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(), frames = [];
    const consuming = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = raw.split('\n').find(line => line.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    const result = { frames, async close() { controller.abort(); await consuming; reader.releaseLock(); streams.delete(result); } };
    streams.add(result); return result;
  }
  return { directory, start, client, stream, disposers };
}
const command = (roomId, text, key = randomUUID()) => ({ type: 'send', roomId, text, key, mode: 'discussion', ownerAgentId: null, mentions: [] });

test('two public clients synchronize through real SSE; both receipt/event orders deduplicate', async t => {
  const env = await setup(t), server = await env.start(), room = await server.create();
  let eventFirst = false, releaseResponse;
  const a = await env.client(() => server, room.roomId, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (init.method === 'POST' && eventFirst) await new Promise(resolve => { releaseResponse = resolve; });
    return response;
  } });
  const b = await env.client(() => server, room.roomId);
  const first = await a.dispatch(command(room.roomId, '第一条'));
  await eventually(() => b.read().messages.length === 1 && a.read().messages.length === 1);
  assert.equal(b.read().messages[0].id, first.messageId);
  eventFirst = true;
  const secondCommand = command(room.roomId, '先收到事件');
  const sending = a.dispatch(secondCommand);
  await eventually(() => a.read().messages.length === 2 && releaseResponse);
  releaseResponse(); const second = await sending;
  assert.equal(a.read().messages[1].id, second.messageId);
  eventFirst = false;
  await a.dispatch(secondCommand);
  await eventually(() => b.read().messages.length === 2);
  assert.equal(new Set(a.read().messages.map(m => m.id)).size, 2);
  await assert.rejects(a.dispatch({ ...command(room.roomId, '执行'), mode: 'task' }), { code: 'unsupported' });
});

test('snapshot-to-subscribe gap and filtered checkpoints cannot lose or leak another room', async t => {
  const env = await setup(t), server = await env.start();
  const a = await server.create('A'), b = await server.create('B');
  const snapshot = (await server.call(`/rooms/${a.roomId}/snapshot`)).data;
  const expected = await server.send(a.roomId, '交界消息');
  const hidden = await server.send(b.roomId, '不能混入 A');
  const stream = await env.stream(server, a.roomId, snapshot.cursor);
  await eventually(() => stream.frames.some(f => f.type === 'checkpoint'));
  assert.deepEqual(stream.frames.filter(f => f.type === 'event').map(f => f.data.entityId), [expected.messageId]);
  assert.equal(JSON.stringify(stream.frames).includes(hidden.messageId), false);
  const checkpoint = stream.frames.filter(f => f.type === 'checkpoint').at(-1).cursor;
  assert.equal(checkpoint, (await server.call(`/rooms/${a.roomId}/snapshot`)).data.cursor);
  await stream.close();
  let inserted = false;
  const client = await env.client(() => server, a.roomId, { fetch: async (url, init) => {
    const res = await fetch(url, init);
    if (url.endsWith('/snapshot') && !inserted) { inserted = true; await server.send(a.roomId, '快照返回后提交'); }
    return res;
  } });
  await eventually(() => client.read().messages.length === 2);
  assert.deepEqual(client.read().messages.map(m => m.text), ['交界消息', '快照返回后提交']);
});

test('disconnect plus real backend restart resumes cursor without replacing the preserved projection', async t => {
  const env = await setup(t); let server = await env.start();
  const room = await server.create();
  let snapshots = 0;
  const client = await env.client(() => server, room.roomId, { fetch: (url, init) => { if (url.endsWith('/snapshot')) snapshots++; return fetch(url, init); } });
  await server.send(room.roomId, '重启前'); await eventually(() => client.read().messages.length === 1);
  const databaseId = client.read().databaseId, instanceId = client.read().instanceId;
  await server.stop(); await eventually(() => client.read().connection !== 'live');
  server = await env.start(); await server.send(room.roomId, '断线期间');
  await eventually(() => client.read().connection === 'live' && client.read().messages.length === 2);
  assert.equal(client.read().databaseId, databaseId); assert.notEqual(client.read().instanceId, instanceId);
  assert.equal(snapshots, 1);
});

test('COMMIT before wakeup and response loss survive process kill; reload checks original command without resending', async t => {
  const env = await setup(t); let server = await env.start();
  const room = await server.create(), storage = fileStorage(path.join(env.directory, 'journal'));
  let posts = 0;
  const options = { storage, fetch: (url, init) => { if (init.method === 'POST') posts++; return fetch(url, init); } };
  const writer = await env.client(() => server, room.roomId, options);
  const observer = await env.client(() => server, room.roomId);
  const original = command(room.roomId, '已提交未唤醒');
  await server.arm('after_commit');
  const faulted = waitMessage(server.child, 'fault');
  const sending = writer.dispatch(original).catch(error => error);
  await faulted; await server.stop();
  assert.equal((await sending).outcome, 'unknown');
  assert.equal(writer.read().pendingOperations.length, 1);
  assert.ok(storage.dump().includes(original.text));
  assert.equal(storage.dump().includes(server.ready.token), false);
  writer.close(); server = await env.start();
  const reloaded = await env.client(() => server, room.roomId, { ...options, storage: fileStorage(path.join(env.directory, 'journal')) });
  await eventually(() => observer.read().messages.length === 1);
  assert.equal(reloaded.read().messages.length, 1); assert.equal(reloaded.read().pendingOperations.length, 0);
  assert.equal(reloaded.read().messages[0].id, observer.read().messages[0].id);
  assert.equal(posts, 1);
});

test('known not-found submission is never replayed on reconnect; explicit same-key retry is allowed', async t => {
  const env = await setup(t), server = await env.start(), room = await server.create(), storage = memoryStorage();
  let fail = true, posts = 0;
  const options = { storage, fetch: (url, init) => { if (init.method === 'POST') { posts++; if (fail) throw new Error('response path lost before submit'); } return fetch(url, init); } };
  const first = await env.client(() => server, room.roomId, options), send = command(room.roomId, '显式重试');
  await assert.rejects(first.dispatch(send), { outcome: 'unknown' }); first.close();
  const second = await env.client(() => server, room.roomId, options);
  assert.equal(second.read().pendingOperations[0].outcome, 'not_found'); assert.equal(posts, 1);
  assert.equal(second.read().messages.length, 0);
  await assert.rejects(second.dispatch({ ...send, text: '改变内容' }), { code: 'idempotency_conflict' });
  fail = false; await second.dispatch(send);
  await eventually(() => second.read().messages.length === 1);
  assert.equal(posts, 2); assert.equal(second.read().pendingOperations.length, 0);
});

test('database change clears projection and cannot send old unknown commands; journals isolate backend and local user', async t => {
  const env = await setup(t); let server = await env.start();
  const room = await server.create(), storage = memoryStorage();
  let posts = 0;
  const options = { storage, fetch: (url, init) => { if (init.method === 'POST') { posts++; throw new Error('lost'); } return fetch(url, init); } };
  const client = await env.client(() => server, room.roomId, options);
  await server.send(room.roomId, '旧库消息'); await eventually(() => client.read().messages.length === 1);
  await assert.rejects(client.dispatch(command(room.roomId, '未知')), { outcome: 'unknown' });
  const otherUser = await env.client(() => server, room.roomId, { ...options, localUserId: 'another-user' });
  assert.equal(otherUser.read().pendingOperations.length, 0); otherUser.close();
  const otherBackend = await env.client(() => server, room.roomId, { ...options, backendId: 'another-backend' });
  assert.equal(otherBackend.read().pendingOperations.length, 0); otherBackend.close();
  await server.stop(); server = await env.start(path.join(env.directory, 'new-db'));
  await client.open({ roomId: room.roomId });
  assert.equal(client.read().messages.length, 0); assert.equal(client.read().databaseChanged, true);
  assert.equal(client.read().pendingOperations.length, 0); assert.equal(posts, 1);
  assert.equal((await server.call('/rooms?' + new URLSearchParams({ workspaceId: server.boot.workspace.id }))).data.length, 0);
});

test('room switch and close abort streams and ignore late snapshot responses', async t => {
  const env = await setup(t), server = await env.start(), a = await server.create('A'), b = await server.create('B');
  await server.send(a.roomId, 'A 消息'); await server.send(b.roomId, 'B 消息');
  let held = false, release, waiting;
  const reached = new Promise(resolve => { waiting = resolve; });
  const signals = [];
  const client = await env.client(() => server, a.roomId, { fetch: async (url, init) => {
    if (url.includes('/events?')) signals.push(init.signal);
    const res = await fetch(url, init);
    if (held && url.includes(`/rooms/${a.roomId}/snapshot`)) { waiting(); await new Promise(resolve => { release = resolve; }); }
    return res;
  } });
  await client.open({ roomId: b.roomId });
  held = true; const opening = client.open({ roomId: a.roomId }); await reached;
  await client.open({ roomId: b.roomId }); release(); await opening;
  assert.deepEqual(client.read().messages.map(m => m.text), ['B 消息']);
  assert.ok(signals.slice(0, -1).every(signal => signal.aborted));
  client.close(); assert.ok(signals.every(signal => signal.aborted));
  await server.send(b.roomId, '关闭后'); await pause(100);
  assert.equal(client.read().messages.length, 1); assert.equal(client.read().connection, 'offline');
});

test('SSE authenticates scope and rejects malformed, foreign-database and ahead cursors', async t => {
  const env = await setup(t), server = await env.start(), a = await server.create('A'), b = await server.create('B');
  const snapshot = (await server.call(`/rooms/${a.roomId}/snapshot`)).data;
  const url = after => '/events?' + new URLSearchParams({ roomId: a.roomId, after });
  assert.equal((await server.call(url(snapshot.cursor), undefined, undefined, { Authorization: '' })).status, 401);
  assert.equal((await server.call(url(snapshot.cursor), undefined, undefined, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await server.call(url('bad'))).data.code, 'invalid_cursor');
  assert.equal((await server.call('/events?' + new URLSearchParams({ roomId: b.roomId, after: snapshot.cursor }))).data.code, 'resync_required');
  assert.equal((await server.call('/events?' + new URLSearchParams({ roomId: 'missing', after: snapshot.cursor }))).status, 404);
  const parts = JSON.parse(Buffer.from(snapshot.cursor, 'base64url'));
  parts[3] += 10;
  assert.equal((await server.call(url(Buffer.from(JSON.stringify(parts)).toString('base64url')))).data.code, 'invalid_cursor');
  parts[1] = randomUUID(); parts[3] = 0;
  assert.equal((await server.call(url(Buffer.from(JSON.stringify(parts)).toString('base64url')))).data.code, 'resync_required');
});

test('backlog-to-wait insertion and missed wakeup both arrive from the same durable log loop', async t => {
  const env = await setup(t);
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  let runtime, inserted = false, enabled = false, suppressWake = false;
  runtime = await createApplicationRuntime({ directory: env.directory, fault(point) {
    if (point === 'before_wait' && enabled && !inserted) { inserted = true; runtime.execute({ type: 'sendDiscussion', workspaceId: boot.workspace.id, roomId: room.roomId, text: '交界', key: randomUUID() }, runtime.owner); }
    if (point === 'after_commit' && suppressWake) throw new Error('Simulate lost notification after successful commit');
  } });
  const http = await startPersistenceHttp({ runtime });
  env.disposers.push(async () => { await http.close(); runtime.close(); });
  const boot = runtime.query({ type: 'bootstrap' }, runtime.owner);
  const room = runtime.execute({ type: 'createRoom', workspaceId: boot.workspace.id, title: '间隙', key: randomUUID() }, runtime.owner);
  const snapshot = runtime.query({ type: 'snapshot', roomId: room.roomId }, runtime.owner);
  enabled = true;
  const stream = await env.stream({ ready: http }, room.roomId, snapshot.cursor);
  await eventually(() => stream.frames.some(f => f.data?.payload?.text === '交界'));
  suppressWake = true;
  assert.throws(() => runtime.execute({ type: 'sendDiscussion', workspaceId: boot.workspace.id, roomId: room.roomId, text: '漏通知', key: randomUUID() }, runtime.owner), { outcome: 'unknown' });
  const started = Date.now();
  await eventually(() => stream.frames.some(f => f.data?.payload?.text === '漏通知'), 1500);
  assert.ok(Date.now() - started < 1500, 'One-second fallback scan must recover missed wakeup');
  await stream.close();
});

test('duplicate SSE delivery and receipt-first order keep one projection; cursor never leads applied data', async t => {
  const env = await setup(t), server = await env.start(), room = await server.create();
  let release, hold = true;
  const queued = [];
  const client = await env.client(() => server, room.roomId, { decorateTransport: transport => ({ ...transport,
    synchronize(scope, emit, resume) { return transport.synchronize(scope, event => {
      if (event.type === 'persistence.frame' && event.data.type === 'event') {
        const deliver = () => { emit(event); emit(event); };
        if (hold) queued.push(deliver); else deliver();
      } else if (event.type === 'persistence.frame' && hold) queued.push(() => emit(event));
      else emit(event);
    }, resume); },
  }) });
  const before = client.read().cursor;
  const receipt = await client.dispatch(command(room.roomId, '回执先到'));
  assert.equal(client.read().messages.length, 0); assert.equal(client.read().cursor, before);
  await eventually(() => queued.length > 0);
  client.subscribe(() => { if (client.read().cursor === receipt.cursor) assert.equal(client.read().messages[0]?.id, receipt.messageId); });
  hold = false; for (release of queued) release();
  await eventually(() => client.read().messages.length === 1);
  assert.equal(client.read().messages[0].id, receipt.messageId);
  assert.equal(client.read().messages.length, 1);
});

test('journal failure rejects before sending and independent command records survive two windows', async t => {
  const env = await setup(t), server = await env.start(), room = await server.create();
  const storage = memoryStorage(); let posts = 0;
  const fetcher = (url, init) => { if (init.method === 'POST') { posts++; throw new Error('offline after explicit submit'); } return fetch(url, init); };
  const a = await env.client(() => server, room.roomId, { storage, fetch: fetcher });
  const b = await env.client(() => server, room.roomId, { storage, fetch: fetcher });
  await Promise.all([assert.rejects(a.dispatch(command(room.roomId, 'A')), { outcome: 'unknown' }), assert.rejects(b.dispatch(command(room.roomId, 'B')), { outcome: 'unknown' })]);
  a.close(); b.close();
  const c = await env.client(() => server, room.roomId, { storage, fetch: fetcher });
  assert.equal(c.read().pendingOperations.length, 2); assert.equal(posts, 2);
  storage.setItem = () => { throw new Error('quota exhausted'); };
  await assert.rejects(c.dispatch(command(room.roomId, '不能发送')), { code: 'journal_unavailable', outcome: 'rejected' });
  assert.equal(posts, 2);
});

test('slow real socket is disconnected at the bounded SSE write backlog and releases its watcher', async t => {
  const env = await setup(t);
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const runtime = await createApplicationRuntime({ directory: env.directory });
  const http = await startPersistenceHttp({ runtime });
  env.disposers.push(async () => { await http.close(); runtime.close(); });
  const boot = runtime.query({ type: 'bootstrap' }, runtime.owner);
  const room = runtime.execute({ type: 'createRoom', workspaceId: boot.workspace.id, title: '慢连接', key: randomUUID() }, runtime.owner);
  const snapshot = runtime.query({ type: 'snapshot', roomId: room.roomId }, runtime.owner);
  for (let i = 0; i < 500; i++) runtime.execute({ type: 'sendDiscussion', workspaceId: boot.workspace.id, roomId: room.roomId, text: 'x'.repeat(16000), key: randomUUID() }, runtime.owner);
  const watch = runtime.watch; let released = false, framesRead = 0;
  runtime.watch = (...args) => {
    const stream = watch(...args);
    args[2].signal.addEventListener('abort', () => { released = true; });
    return { close: () => stream.close(), async *[Symbol.asyncIterator]() { for await (const frame of stream) { framesRead++; yield frame; } } };
  };
  const url = new URL(http.origin), socket = require('node:net').connect(Number(url.port), '127.0.0.1');
  socket.on('error', () => {}); env.disposers.unshift(() => socket.destroy());
  await once(socket, 'connect'); socket.pause();
  socket.write(`GET /api/v1/events?${new URLSearchParams({ roomId: room.roomId, after: snapshot.cursor })} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${http.token}\r\n\r\n`);
  await eventually(() => released, 3000);
  assert.ok(framesRead < 500, 'Server must disconnect instead of buffering the full slow backlog');
  assert.equal(runtime.query({ type: 'snapshot', roomId: room.roomId }, runtime.owner).roomSequenceUpperBound, 500);
});

test('a healthy client resumes a backlog larger than the buffer limit without discarding messages', async t => {
  const env = await setup(t), server = await env.start(), room = await server.create();
  let snapshots = 0;
  const client = await env.client(() => server, room.roomId, { fetch: (url, init) => { if (url.endsWith('/snapshot')) snapshots++; return fetch(url, init); } });
  client.close();
  for (let i = 0; i < 120; i++) await server.send(room.roomId, String(i) + '文'.repeat(15990));
  await client.open({ roomId: room.roomId });
  await eventually(() => client.read().messages.length === 120);
  assert.equal(snapshots, 1);
  assert.deepEqual(client.read().messages.map(m => m.sequence), Array.from({ length: 120 }, (_, i) => i + 1));
});
