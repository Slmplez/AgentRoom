const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const until = async read => { const end = Date.now() + 5000; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 20)); } throw Error('Timed out waiting for local task'); };
async function setup(directory, options = {}) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const { createPiQuestionEngine } = await import('../lib/local-question-engine.mjs');
  const runtime = await createApplicationRuntime({ directory, execution: { agentId: 'local-pi', createEngine: () => createPiQuestionEngine({ directory, env: process.env, command: { command: process.execPath, args: [path.resolve(__dirname, 'fixtures/local-question-pi.cjs')] } }) }, ...options });
  const http = await startPersistenceHttp({ runtime });
  const request = async (route, input, key) => {
    const response = await fetch(http.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${http.token}`, ...(input ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const data = await response.json(); return { status: response.status, data };
  };
  const bootstrap = (await request('/bootstrap')).data;
  return { runtime, http, request, bootstrap, close: async () => { await http.close(); runtime.close(); } };
}
test('authenticated HTTP native question answer continues original pipe task; retries and access preserve identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-question-')); const s = await setup(directory);
  try {
    const workspaceId = s.bootstrap.workspace.id;
    const roomId = (await s.request('/rooms', { workspaceId, title: '本机任务' }, 'room')).data.roomId;
    const route = `/rooms/${roomId}/local-tasks`, input = { workspaceId, ownerAgentId: 'local-pi', goal: '检查接口兼容' };
    const created = await s.request(route, input, 'task'); assert.equal(created.status, 200); const taskId = created.data.taskId;
    assert.equal((await s.request(route, input, 'task')).data.taskId, taskId);
    assert.equal((await s.request(route, { ...input, goal: 'changed' }, 'task')).status, 409);
    const read = async () => (await s.request(`${route}/${taskId}`)).data;
    const waiting = await until(async () => { const t = await read(); return t.phase === 'awaiting_input' && t; });
    assert.equal(waiting.question.title, '旧接口兼容期限？'); assert.equal(JSON.stringify(waiting).includes('native-input'), false);
    const answer = { workspaceId, questionId: waiting.question.id, expectedRevision: 0, optionIds: [], text: '保留两周' };
    assert.equal((await s.request(`${route}/${taskId}/answers`, { ...answer, expectedRevision: 8 }, 'stale')).status, 409);
    assert.equal((await s.request(`${route}/${taskId}/answers`, { ...answer, optionIds: ['invalid'] }, 'bad')).status, 400);
    const receipt = await s.request(`${route}/${taskId}/answers`, answer, 'answer'); assert.equal(receipt.status, 200);
    assert.deepEqual((await s.request(`${route}/${taskId}/answers`, answer, 'answer')).data, receipt.data);
    const done = await until(async () => { const t = await read(); return t.phase === 'reviewing' && t; });
    assert.equal(done.result, '已继续：保留两周'); assert.equal(done.question.response.authorId, s.bootstrap.user.id);
    assert.equal(done.delivery, 'submitted'); assert.notEqual(done.phase, 'completed');
    assert.equal((await s.request(`/operations?workspaceId=${workspaceId}&commandType=answerLocalQuestion&key=answer`)).data.taskId, taskId);
    assert.equal((await s.request(route, { ...input, command: 'evil' }, 'forged')).status, 400);
    const other = (await s.request('/rooms', { workspaceId, title: 'other' }, 'room2')).data.roomId;
    assert.equal((await s.request(`/rooms/${other}/local-tasks/${taskId}`)).status, 404);
    assert.throws(() => s.runtime.query({ type: 'localTasks', roomId }, { principalId: 'forged' }), { code: 'forbidden' });
    const events = (await s.request(`/rooms/${roomId}/events`)).data.events;
    const { persistenceEventSchema } = await import('../contracts/persistence.mjs'); for (const e of events) assert.equal(persistenceEventSchema.safeParse(e).success, true);
  } finally { await s.close(); }
});
test('restart preserves native question and marks original execution unknown without dispatching again', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-restart-')); let s = await setup(directory);
  const workspaceId = s.bootstrap.workspace.id;
  const roomId = (await s.request('/rooms', { workspaceId, title: '恢复' }, 'r')).data.roomId;
  const route = `/rooms/${roomId}/local-tasks`, input = { workspaceId, ownerAgentId: 'local-pi', goal: '等待输入' };
  const taskId = (await s.request(route, input, 'task')).data.taskId;
  await until(async () => (await s.request(`${route}/${taskId}`)).data.phase === 'awaiting_input');
  await s.close(); let starts = 0;
  s = await setup(directory, { execution: { agentId: 'local-pi', createEngine() { starts++; throw Error('must not replay'); } } });
  try {
    const t = (await s.request(`${route}/${taskId}`)).data;
    assert.equal(t.phase, 'unknown'); assert.equal(t.question.status, 'expired'); assert.equal(starts, 0);
    assert.equal((await s.request(route, { ...input, goal: 'another' }, 'new')).status, 409);
    assert.equal((await s.request(`${route}/${taskId}/answers`, { workspaceId, questionId: t.question.id, expectedRevision: 0, optionIds: [], text: '晚到答复' }, 'late')).status, 409);
    assert.equal((await s.request(route, input, 'task')).data.taskId, taskId);
  } finally { await s.close(); }
});
test('schema 1 discussion data migrates intact and default mode never enables local execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-migration-')); let s = await setup(directory, { execution: null });
  const workspaceId = s.bootstrap.workspace.id;
  const roomId = (await s.request('/rooms', { workspaceId, title: '已有讨论' }, 'room')).data.roomId;
  const original = (await s.request(`/rooms/${roomId}/messages`, { workspaceId, text: '迁移前的消息' }, 'message')).data;
  assert.equal(s.bootstrap.capabilities.localExecution, false); assert.equal(s.bootstrap.capabilities.tasks, false);
  assert.equal((await s.request(`/rooms/${roomId}/local-tasks`, { workspaceId, goal: 'must not run', ownerAgentId: 'local-pi' }, 'disabled')).status, 422);
  await s.close();
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path.join(directory, 'application.sqlite'));
  // Remove later tables/columns to exercise discussion-only data migration.
  db.exec('DROP TABLE memory_source_tombstones; DROP TABLE memory_source_links; DROP TABLE memory_revisions; DROP TABLE explicit_memories; DROP TABLE memory_sources; DROP TABLE soul_revisions; DROP TABLE agent_souls; DROP TABLE artifact_versions; DROP TABLE local_tasks; ALTER TABLE messages DROP COLUMN artifact_refs_json; PRAGMA user_version=1;'); db.close();
  s = await setup(directory, { execution: null });
  try {
    assert.equal((await s.request(`/rooms/${roomId}/messages`)).data.messages[0].text, '迁移前的消息');
    assert.deepEqual((await s.request(`/rooms/${roomId}/messages`, { workspaceId, text: '迁移前的消息' }, 'message')).data, original);
    assert.equal((await s.request(`/rooms/${roomId}/local-tasks`)).data.length, 0);
  } finally { await s.close(); }
});
for (const point of ['after_receipt', 'after_commit', 'before_local_answer', 'after_local_answer']) test(`process kill at ${point} preserves answer atomicity without native replay`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-crash-'));
  const wait = (child, type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(`Timed out: ${type}`)), 8000);
    const message = m => { if (m.type === type) finish(null, m); };
    const exit = () => finish(Error('Backend exited'));
    function finish(e, m) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); e ? reject(e) : resolve(m); }
    child.on('message', message); child.on('exit', exit);
  });
  const start = async () => {
    const child = fork(path.join(__dirname, 'fixtures/local-execution-process.cjs'), [directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.stderr.resume();
    const ready = await wait(child, 'ready');
    const request = async (route, input, key) => {
      const response = await fetch(ready.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${ready.token}`, ...(input ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    return { child, request, kill: async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } } };
  };
  let s = await start();
  try {
    const workspaceId = (await s.request('/bootstrap')).data.workspace.id;
    const roomId = (await s.request('/rooms', { workspaceId, title: 'crash' }, 'room')).data.roomId;
    const route = `/rooms/${roomId}/local-tasks`;
    const taskId = (await s.request(route, { workspaceId, ownerAgentId: 'local-pi', goal: 'input' }, 'task')).data.taskId;
    const q = await until(async () => { const t = (await s.request(`${route}/${taskId}`)).data; return t.phase === 'awaiting_input' && t.question; });
    let armed = wait(s.child, 'armed'); s.child.send({ type: 'arm', point }); await armed;
    const fault = wait(s.child, 'fault');
    const answer = s.request(`${route}/${taskId}/answers`, { workspaceId, questionId: q.id, expectedRevision: 0, optionIds: [], text: 'durable-answer' }, 'answer').catch(() => null);
    await fault; await s.kill(); await answer;
    await new Promise(r => setTimeout(r, 100));
    const before = await fs.readFile(path.join(directory, 'native.log'), 'utf8');
    s = await start();
    const recovered = (await s.request(`${route}/${taskId}`)).data;
    assert.equal(recovered.phase, 'unknown');
    const receipt = await s.request(`/operations?workspaceId=${workspaceId}&commandType=answerLocalQuestion&key=answer`);
    if (point === 'after_receipt') { assert.equal(recovered.question.response, null); assert.equal(receipt.status, 404); }
    else { assert.equal(recovered.question.response.text, 'durable-answer'); assert.equal(receipt.status, 200); assert.equal(recovered.delivery, 'unknown'); }
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await fs.readFile(path.join(directory, 'native.log'), 'utf8'), before, 'Restart cannot launch or answer another native process');
    assert.ok(before.split('answer').length <= 2, 'At most one native answer');
  } finally { await s.kill(); }
});
