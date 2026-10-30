const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');

function wait(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Child timeout: ' + type)), 10000);
    const message = value => { if (value.type === type) finish(null, value); };
    const exit = () => finish(Error('Backend exited'));
    function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
    child.on('message', message); child.on('exit', exit);
  });
}
async function start(directory) {
  const child = fork(path.join(__dirname, 'fixtures/agent-memory-process.cjs'), [directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.stderr.resume();
  const ready = await wait(child, 'ready');
  const request = async (route, input, key) => {
    const response = await fetch(ready.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${ready.token}`, ...(input ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { child, request, async kill() { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } } };
}
for (const action of ['save', 'correct', 'forget']) for (const point of ['after_entity', 'after_event', 'after_receipt', 'after_commit']) {
  test(`${action}: process kill at ${point} preserves all facts or none, with recoverable receipt`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-memory-kill-'));
    let s = await start(directory);
    try {
      const workspaceId = (await s.request('/bootstrap')).data.workspace.id;
      const roomId = (await s.request('/rooms', { workspaceId, title: 'durability' }, 'room')).data.roomId;
      const sourceMessage = (await s.request(`/rooms/${roomId}/messages`, { workspaceId, text: 'original evidence' }, 'source')).data;
      const scope = { kind: 'room', roomId };
      const save = { type: 'saveExplicitMemory', workspaceId, scope, text: 'explicit fact', source: { kind: 'message', messageId: sourceMessage.messageId, revision: 1 } };
      const first = action !== 'save' ? (await s.request('/agent-memory/commands', save, 'initial')).data : null;
      const input = action === 'save' ? save : { type: action === 'correct' ? 'correctExplicitMemory' : 'forgetExplicitMemory', workspaceId, scope, memoryId: first.entityId, expectedRevision: 1, ...(action === 'correct' ? { text: 'corrected fact' } : {}) };
      const armed = wait(s.child, 'armed'); s.child.send({ type: 'arm', point }); await armed;
      const fault = wait(s.child, 'fault');
      const writing = s.request('/agent-memory/commands', input, 'operation').catch(() => null);
      await fault; await s.kill(); await writing;
      s = await start(directory);
      const receipt = await s.request(`/operations?workspaceId=${workspaceId}&commandType=${input.type}&key=operation`);
      const committed = point === 'after_commit'; assert.equal(receipt.status, committed ? 200 : 404);
      const listing = (await s.request('/agent-memory/query', { type: 'explicitMemories', workspaceId, scope })).data.memories;
      assert.equal(listing.length, action === 'save' ? Number(committed) : action === 'forget' && committed ? 0 : 1);
      if (action === 'correct') assert.equal(listing[0].text, committed ? 'corrected fact' : 'explicit fact');
      if (first) {
        const h = (await s.request('/agent-memory/query', { type: 'explicitMemoryHistory', workspaceId, scope, memoryId: first.entityId })).data;
        assert.equal(h.revisions.length, committed ? 2 : 1);
        assert.equal(h.sources.length, committed && action === 'correct' ? 2 : 1);
        if (action === 'forget' && committed) assert.equal((await s.request('/agent-memory/commands', save, 'replay')).data.code, 'memory_deleted');
      }
      const retried = await s.request('/agent-memory/commands', input, 'operation'); assert.equal(retried.status, 200);
      if (committed) assert.deepEqual(retried.data, receipt.data);
      const history = (await s.request('/agent-memory/query', { type: 'explicitMemoryHistory', workspaceId, scope, memoryId: retried.data.entityId })).data;
      assert.equal(history.revisions.length, action === 'save' ? 1 : 2);
    } finally { await s.kill(); }
  });
}

test('authentic v3 database migrates with discussion, task, report, receipts and event cursors unchanged', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-memory-v3-'));
  let db = new DatabaseSync(path.join(directory, 'application.sqlite'));
  db.exec(await fs.readFile(path.join(__dirname, 'fixtures/persistence-v3.sql'), 'utf8')); db.close();
  const expected = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/persistence-v3-expected.json'), 'utf8'));
  const runtime = await createApplicationRuntime({ directory, knownAgents: ['fixture-agent'] }); t.after(() => runtime.close());
  const actor = runtime.owner, { roomId, workspaceId } = expected;
  assert.deepEqual(runtime.query({ type: 'events', roomId }, actor), expected.events);
  const snapshot = runtime.query({ type: 'snapshot', roomId }, actor);
  delete snapshot.instanceId; delete expected.snapshot.instanceId;
  assert.deepEqual(snapshot, expected.snapshot);
  for (const receipt of [expected.messageReceipt, expected.taskReceipt, expected.artifactReceipt]) assert.deepEqual(runtime.query({ type: 'operation', operationId: receipt.operationId }, actor), receipt);
  assert.equal(runtime.query({ type: 'artifact', roomId, artifactId: expected.artifactReceipt.artifactId, version: 1 }, actor).spec.elements.r.props.description, 'Preserved through migration');
  const saved = runtime.execute({ type: 'saveExplicitMemory', workspaceId, key: 'memory', scope: { kind: 'room', roomId }, text: 'Original source', source: { kind: 'message', messageId: expected.messageReceipt.messageId, revision: 1 } }, actor);
  assert.equal(saved.revision, 1);
  const events = runtime.query({ type: 'events', roomId, after: expected.events.cursor }, actor);
  assert.deepEqual(events.events, []); assert.notEqual(events.cursor, expected.events.cursor, 'Hidden memory event still advances the durable cursor');
  db = new DatabaseSync(path.join(directory, 'application.sqlite'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); db.close();
});

test('migration integrity failure rolls back the new schema without discarding legacy data', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-memory-bad-v3-'));
  const db = new DatabaseSync(path.join(directory, 'application.sqlite'));
  db.exec(await fs.readFile(path.join(__dirname, 'fixtures/persistence-v3.sql'), 'utf8'));
  db.exec("PRAGMA foreign_keys=OFF; UPDATE command_receipts SET message_id='missing-message' WHERE command_type='sendDiscussion';");
  const count = db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get().n; db.close();
  await assert.rejects(createApplicationRuntime({ directory }), /migration integrity failure/);
  const after = new DatabaseSync(path.join(directory, 'application.sqlite'));
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM command_receipts').get().n, count);
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='agent_souls'").get(), undefined); after.close();
});
