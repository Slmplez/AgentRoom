const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fixture = path.join(__dirname, 'fixtures/persistence-process.cjs');
const running = new Map();

function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), 15000);
    const onMessage = msg => { if (msg.type === type) finish(null, msg); };
    const onExit = () => finish(new Error(`Backend exited before ${type}`));
    function finish(error, value) { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(value); }
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
async function start(directory, script = fixture) {
  const args = script === fixture ? [directory] : ['--data-dir', directory];
  const child = fork(script, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  if (!running.has(directory)) running.set(directory, new Set());
  running.get(directory).add(child);
  child.once('exit', () => running.get(directory)?.delete(child));
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  let ready;
  try { ready = await waitMessage(child, 'ready'); } catch (e) { child.kill(); throw new Error(e.message + ': ' + output); }
  const call = async (route, data, key, headers = {}) => {
    const response = await fetch(ready.origin + '/api/v1' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + ready.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key || randomUUID() }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json() };
  };
  const boot = (await call('/bootstrap')).data;
  return { child, ready, call, boot, output: () => output,
    async stop(hard = false) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); hard ? child.kill('SIGKILL') : child.send({ type: 'shutdown' }); await exited; },
    async arm(point) { const waiting = waitMessage(child, 'armed'); child.send({ type: 'arm', point }); await waiting; },
    create(title = '讨论', key) { return call('/rooms', { workspaceId: boot.workspace.id, title }, key); },
    send(roomId, text, key, rest = {}) { return call(`/rooms/${roomId}/messages`, { workspaceId: boot.workspace.id, text, ...rest }, key); },
    receipt(key, commandType = 'sendDiscussion') { return call('/operations?' + new URLSearchParams({ workspaceId: boot.workspace.id, commandType, key })); },
  };
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-persistence-'));
  t.after(async () => {
    for (const child of running.get(dir) || []) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    running.delete(dir);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('agentroom-persistence-'));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

test('real HTTP clients persist rooms/messages, concurrent retries and receipt identity across restart', async t => {
  const dir = await directory(t); let server = await start(dir); t.after(() => server.stop(true));
  const roomKey = randomUUID(), room = (await server.create('中文讨论', roomKey)).data;
  assert.deepEqual((await server.create('中文讨论', roomKey)).data, room);
  assert.equal((await server.create('改名', roomKey)).status, 409);
  const key = randomUUID();
  const replies = await Promise.all(Array.from({ length: 20 }, () => server.send(room.roomId, '你好 @Agent 不执行', key)));
  for (const r of replies) { assert.equal(r.status, 200); assert.deepEqual(r.data, replies[0].data); }
  assert.equal(replies[0].data.sequence, 1);
  const other = (await server.create('另一个房间')).data;
  for (const changed of [await server.send(room.roomId, '改文', key), await server.send(other.roomId, '你好 @Agent 不执行', key), await server.send(room.roomId, '你好 @Agent 不执行', key, { replyToId: replies[0].data.messageId })]) assert.equal(changed.data.code, 'idempotency_conflict');
  assert.equal((await server.send(other.roomId, '引用', randomUUID(), { replyToId: replies[0].data.messageId })).data.code, 'invalid_reply');
  const second = (await server.send(room.roomId, '你好 @Agent 不执行', randomUUID())).data;
  assert.equal(second.sequence, 2);
  const secondRoomMessage = (await server.send(other.roomId, '独立序号')).data; assert.equal(secondRoomMessage.sequence, 1);
  const messages = (await server.call(`/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(messages.length, 2); assert.equal(messages[0].authorId, server.boot.user.id);
  assert.equal((await server.call(`/rooms/${room.roomId}/events`)).data.events.filter(e => e.type === 'message.created').length, 2);
  assert.deepEqual((await server.receipt(key)).data, replies[0].data);
  const oldBoot = server.boot; await server.stop(); server = await start(dir);
  assert.equal(server.boot.databaseId, oldBoot.databaseId); assert.equal(server.boot.user.id, oldBoot.user.id); assert.notEqual(server.boot.instanceId, oldBoot.instanceId);
  assert.deepEqual((await server.send(room.roomId, '你好 @Agent 不执行', key)).data, replies[0].data);
  assert.deepEqual((await server.call(`/operations/${second.operationId}`)).data, second);
  assert.equal((await server.send(room.roomId, '重启后')).data.sequence, 3);
  assert.equal(server.output().includes(server.ready.token), false);
});

for (const point of ['after_entity', 'after_event', 'after_receipt', 'after_commit']) {
  test(`actual process kill at ${point} preserves atomic message/counter/event/receipt outcome`, async t => {
    const dir = await directory(t); let server = await start(dir); t.after(() => server.stop(true));
    const room = (await server.create()).data, key = randomUUID();
    await server.arm(point);
    const faulted = waitMessage(server.child, 'fault');
    const request = server.send(room.roomId, '崩溃恢复', key).catch(() => null);
    await faulted; await server.stop(true); await request;
    server = await start(dir);
    const committed = point === 'after_commit';
    const before = (await server.call(`/rooms/${room.roomId}/messages`)).data.messages;
    assert.equal(before.length, committed ? 1 : 0);
    const original = await server.receipt(key); assert.equal(original.status, committed ? 200 : 404);
    assert.equal((await server.call(`/rooms/${room.roomId}/events`)).data.events.filter(e => e.type === 'message.created').length, committed ? 1 : 0);
    const retry = await server.send(room.roomId, '崩溃恢复', key); assert.equal(retry.status, 200); assert.equal(retry.data.sequence, 1);
    if (committed) assert.deepEqual(retry.data, original.data);
    assert.equal((await server.send(room.roomId, '下一条')).data.sequence, 2);
  });
}

test('room creation response loss is recoverable without duplicating room or owner membership', async t => {
  const dir = await directory(t); let server = await start(dir); t.after(() => server.stop(true));
  const key = randomUUID(); await server.arm('after_commit');
  const faulted = waitMessage(server.child, 'fault'), request = server.create('可恢复房间', key).catch(() => null);
  await faulted; await server.stop(true); await request; server = await start(dir);
  const original = (await server.receipt(key, 'createRoom')).data;
  assert.deepEqual((await server.create('可恢复房间', key)).data, original);
  assert.equal((await server.call('/rooms?' + new URLSearchParams({ workspaceId: server.boot.workspace.id }))).data.length, 1);
  assert.equal((await server.send(original.roomId, '可用')).status, 200);
});

test('authentication, caller forgery, unsupported tasks and invalid inputs fail closed', async t => {
  const dir = await directory(t), server = await start(dir); t.after(() => server.stop(true));
  assert.equal((await server.call('/bootstrap', undefined, undefined, { Authorization: '' })).status, 401);
  assert.equal((await server.call('/bootstrap', undefined, undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    require('node:http').get(server.ready.origin + '/api/v1/bootstrap', { headers: { Host: 'attacker.invalid', Authorization: 'Bearer ' + server.ready.token } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const room = (await server.create()).data;
  assert.equal((await server.send(room.roomId, '伪造', undefined, { authorId: 'another-user' })).status, 400);
  assert.equal((await server.send(room.roomId, '执行', undefined, { mode: 'task' })).data.code, 'unsupported');
  assert.equal((await server.send(room.roomId, '')).status, 400);
  assert.equal((await server.send(room.roomId, 'x'.repeat(16001))).status, 400);
  assert.equal((await server.send('missing-room', '不能写入')).status, 404);
  assert.equal((await server.call(`/rooms/${room.roomId}/messages?limit=201`)).status, 400);
  assert.equal((await server.call(`/rooms/${room.roomId}/events?after=invalid`)).data.code, 'invalid_cursor');
  assert.equal((await server.call(`/rooms/${room.roomId}/messages`)).data.messages.length, 0);
  const { createApplicationRuntime } = await import(pathToFileURL(path.join(__dirname, '../lib/application-runtime/index.mjs')));
  await server.stop(); const runtime = await createApplicationRuntime({ directory: dir });
  try { assert.throws(() => runtime.query({ type: 'operation', operationId: room.operationId }, { principalId: 'another-user' }), e => e.code === 'forbidden'); }
  finally { runtime.close(); }
});

test('database contention returns rejected/unavailable, and the same key succeeds after lock release', async t => {
  const dir = await directory(t), server = await start(dir); t.after(() => server.stop(true));
  const { DatabaseSync } = require('node:sqlite');
  const lock = new DatabaseSync(path.join(dir, 'application.sqlite'));
  const room = (await server.create()).data, key = randomUUID();
  try {
    lock.exec('BEGIN IMMEDIATE'); const busy = await server.send(room.roomId, '锁后重试', key);
    assert.equal(busy.status, 503); assert.equal(busy.data.outcome, 'rejected'); assert.equal(busy.data.code, 'unavailable');
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal((await server.receipt(key)).status, 404);
  assert.equal((await server.send(room.roomId, '锁后重试', key)).data.sequence, 1);
});

test('newer, corrupt, foreign and inaccessible databases are not replaced by an empty database', async t => {
  const root = await directory(t);
  const { createApplicationRuntime } = await import(pathToFileURL(path.join(__dirname, '../lib/application-runtime/index.mjs')));
  const { DatabaseSync } = require('node:sqlite');
  const newer = path.join(root, 'newer'); let runtime = await createApplicationRuntime({ directory: newer }); runtime.close();
  let db = new DatabaseSync(path.join(newer, 'application.sqlite')); db.exec('PRAGMA user_version=99'); db.close();
  await assert.rejects(createApplicationRuntime({ directory: newer }), /newer/);
  db = new DatabaseSync(path.join(newer, 'application.sqlite')); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99); db.close();
  const corrupt = path.join(root, 'corrupt'); await fs.mkdir(corrupt); const bytes = Buffer.from('This is not a SQLite database'); await fs.writeFile(path.join(corrupt, 'application.sqlite'), bytes);
  await assert.rejects(createApplicationRuntime({ directory: corrupt })); assert.deepEqual(await fs.readFile(path.join(corrupt, 'application.sqlite')), bytes);
  const foreign = path.join(root, 'foreign'); await fs.mkdir(foreign); db = new DatabaseSync(path.join(foreign, 'application.sqlite')); db.exec('CREATE TABLE important_data(value TEXT)'); db.close();
  await assert.rejects(createApplicationRuntime({ directory: foreign }), /unrecognized/);
  const inaccessible = path.join(root, 'not-a-directory'); await fs.writeFile(inaccessible, 'keep');
  await assert.rejects(createApplicationRuntime({ directory: inaccessible })); assert.equal(await fs.readFile(inaccessible, 'utf8'), 'keep');
});

test('production launcher uses private IPC credentials and independent data directory', async t => {
  const dir = await directory(t), server = await start(dir, path.join(__dirname, '../scripts/start-persistence-server.cjs')); t.after(() => server.stop(true));
  assert.equal((await server.create('实际入口')).status, 200);
  assert.equal(server.boot.capabilities.tasks, false); assert.equal(server.boot.capabilities.eventStream, false);
  await server.stop(); assert.equal(server.output().includes(server.ready.token), false);
});

test('interleaved rooms keep independent sequences; canonical key order and bounded reads preserve identity', async t => {
  const dir = await directory(t), server = await start(dir); t.after(() => server.stop(true));
  const a = (await server.create('A')).data, b = (await server.create('B')).data;
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => server.send(n % 2 ? a.roomId : b.roomId, `消息 ${n}`)));
  assert.ok(results.every(r => r.status === 200));
  for (const room of [a, b]) {
    const rows = (await server.call(`/rooms/${room.roomId}/messages`)).data.messages;
    assert.deepEqual(rows.map(r => r.sequence), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.ok(rows.every(r => r.roomId === room.roomId));
  }
  const key = randomUUID(), text = ' 保留原文 e\u0301 ';
  const original = await server.send(a.roomId, text, key);
  const reordered = await server.call(`/rooms/${a.roomId}/messages`, { replyToId: null, text, workspaceId: server.boot.workspace.id }, key);
  assert.deepEqual(reordered.data, original.data);
  assert.equal((await server.send(a.roomId, text.normalize('NFC'), key)).status, 409);
  const page = (await server.call(`/rooms/${a.roomId}/messages?limit=2`)).data;
  assert.deepEqual(page.messages.map(m => m.sequence), [10, 11]); assert.equal(page.messages[1].text, text);
  const older = (await server.call(`/rooms/${a.roomId}/messages?limit=2&beforeSequence=${page.beforeSequence}&upperBound=${page.roomSequenceUpperBound}`)).data;
  assert.deepEqual(older.messages.map(m => m.sequence), [8, 9]);
  assert.equal((await server.call(`/rooms/${b.roomId}/events?after=${encodeURIComponent(page.cursor)}`)).data.code, 'resync_required');
});
