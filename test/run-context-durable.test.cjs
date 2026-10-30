const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');

function wait(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Backend timeout: ' + type)), 10000);
    const message = value => { if (value.type === type) finish(null, value); };
    const exit = () => finish(Error('Backend exited'));
    function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
    child.on('message', message); child.on('exit', exit);
  });
}
async function start(directory) {
  const child = fork(path.join(__dirname, 'fixtures/local-execution-process.cjs'), [directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.stderr.resume();
  const ready = await wait(child, 'ready');
  const request = async (route, input, key) => {
    const response = await fetch(ready.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${ready.token}`, ...(input ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { child, request, async kill() { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } } };
}
for (const point of ['before_context', 'after_context_snapshot', 'after_context_commit']) test(`kill at ${point}: startup snapshot and dispatching commit together; restart never dispatches`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-kill-')); let s = await start(directory);
  try {
    const workspaceId = (await s.request('/bootstrap')).data.workspace.id;
    const roomId = (await s.request('/rooms', { workspaceId, title: 'snapshot crash' }, 'room')).data.roomId;
    await s.request('/agent-memory/commands', { type: 'saveExplicitMemory', workspaceId, scope: { kind: 'agent', agentId: 'local-pi' }, text: 'must be frozen', source: { kind: 'owner-note' } }, 'memory');
    const armed = wait(s.child, 'armed'); s.child.send({ type: 'arm', point }); await armed;
    const fault = wait(s.child, 'fault');
    const command = { workspaceId, ownerAgentId: 'local-pi', goal: 'Original durable goal' };
    const creating = s.request(`/rooms/${roomId}/local-tasks`, command, 'task').catch(() => null);
    await fault; await s.kill(); await creating;
    s = await start(directory);
    const receipt = await s.request(`/operations?workspaceId=${workspaceId}&commandType=createLocalTask&key=task`); assert.equal(receipt.status, 200);
    const route = `/rooms/${roomId}/local-tasks/${receipt.data.taskId}`;
    const task = (await s.request(route)).data, context = (await s.request(route + '/context')).data;
    if (point === 'after_context_commit') {
      assert.equal(task.phase, 'unknown'); assert.equal(context.status, 'available');
      assert.equal(task.contextSnapshotId, context.snapshot.snapshotId);
      assert.equal(context.snapshot.memories[0].text, 'must be frozen');
    } else {
      assert.equal(task.phase, 'paused'); assert.equal(task.contextSnapshotId, undefined); assert.equal(context.status, 'not_started');
    }
    assert.deepEqual((await s.request(`/rooms/${roomId}/local-tasks`, command, 'task')).data, receipt.data);
    assert.equal(await fs.readFile(path.join(directory, 'native.log'), 'utf8').catch(() => ''), '');
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path.join(directory, 'application.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n, point === 'after_context_commit' ? 1 : 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined); db.close();
  } finally { await s.kill(); }
});

test('native input interruption keeps original snapshot after memory edits and does not resume old CLI', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-native-')); let s = await start(directory);
  try {
    const workspaceId = (await s.request('/bootstrap')).data.workspace.id;
    const roomId = (await s.request('/rooms', { workspaceId, title: 'native context' }, 'room')).data.roomId;
    const scope = { kind: 'agent', agentId: 'local-pi' };
    const memory = (await s.request('/agent-memory/commands', { type: 'saveExplicitMemory', workspaceId, scope, text: 'old context', source: { kind: 'owner-note' } }, 'memory')).data;
    const taskId = (await s.request(`/rooms/${roomId}/local-tasks`, { workspaceId, ownerAgentId: 'local-pi', goal: 'Native question' }, 'task')).data.taskId;
    const route = `/rooms/${roomId}/local-tasks/${taskId}`;
    let task;
    for (let i = 0; i < 200; i++) { task = (await s.request(route)).data; if (task.phase === 'awaiting_input') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(task.phase, 'awaiting_input');
    const snapshot = (await s.request(route + '/context')).data;
    await s.request('/agent-memory/commands', { type: 'forgetExplicitMemory', workspaceId, scope, memoryId: memory.entityId, expectedRevision: 1 }, 'forget');
    await s.kill(); const before = await fs.readFile(path.join(directory, 'native.log'), 'utf8');
    s = await start(directory);
    const recovered = (await s.request(route)).data; assert.equal(recovered.phase, 'unknown'); assert.equal(recovered.question.status, 'expired');
    assert.deepEqual((await s.request(route + '/context')).data, snapshot);
    assert.deepEqual((await s.request('/agent-memory/query', { type: 'explicitMemories', workspaceId, scope })).data.memories, []);
    assert.equal((await s.request(route + '/answers', { workspaceId, questionId: task.question.id, expectedRevision: 0, optionIds: [], text: 'late answer' }, 'late')).status, 409);
    assert.equal(await fs.readFile(path.join(directory, 'native.log'), 'utf8'), before);
  } finally { await s.kill(); }
});
