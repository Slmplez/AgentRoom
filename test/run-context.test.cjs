const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const until = async read => { for (let i = 0; i < 200; i++) { const result = await read(); if (result) return result; await new Promise(r => setTimeout(r, 5)); } throw Error('Context test timed out'); };

async function setup(t, options = {}) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-'));
  const runs = [], agentId = options.agentId || 'iris';
  const runtime = await createApplicationRuntime({ directory, knownAgents: ['iris', 'ember'], fault: options.fault,
    execution: { agentId, createEngine: engineOptions => {
      let listener, finish, release;
      const run = { engineOptions, prompt: null, answer: null, release: () => release?.(), finish: () => finish?.({ text: 'finished', outcome: 'complete' }), ask: () => listener({ id: 'native-input', title: 'Continue?', multiple: false, options: [] }) };
      const engine = { onQuestion(fn) { listener = fn; }, async start() {}, prompt(text) { run.prompt = text; return new Promise(resolve => { finish = resolve; }); }, async respond(id, answer) { run.answer = { id, answer }; run.finish(); }, isStopped: () => true, async close() { finish?.({ text: 'closed', outcome: 'unknown' }); } };
      runs.push(run);
      return options.gated ? new Promise(resolve => { release = () => resolve(engine); }) : engine;
    } },
  });
  const actor = runtime.owner, workspaceId = runtime.query({ type: 'bootstrap' }, actor).workspace.id;
  const http = await startPersistenceHttp({ runtime });
  let key = 0;
  const execute = input => runtime.execute({ workspaceId, key: 'cmd-' + key++, ...input }, actor);
  const room = title => execute({ type: 'createRoom', title }).roomId;
  const close = async () => { await http.close(); runtime.close(); }; t.after(close);
  const request = async (route, input, authenticated = true) => {
    const response = await fetch(http.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { ...(authenticated ? { authorization: `Bearer ${http.token}` } : {}), ...(input ? { 'content-type': 'application/json', 'idempotency-key': 'http-' + key++ } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { directory, runtime, workspaceId, actor, runs, execute, room, close, request,
    create: (roomId, goal = 'Original goal') => execute({ type: 'createLocalTask', roomId, ownerAgentId: agentId, goal }).taskId,
    task: (roomId, taskId) => runtime.query({ type: 'localTask', roomId, taskId }, actor),
    context: (roomId, taskId) => runtime.query({ type: 'taskContextSnapshot', roomId, taskId }, actor),
  };
}
const agentScope = agentId => ({ kind: 'agent', agentId });
const save = (scope, text) => ({ type: 'saveExplicitMemory', scope, text, source: { kind: 'owner-note' } });
const soul = (agentId, personality, expectedRevision = 0) => ({ type: 'editAgentSoul', agentId, expectedRevision, personality, expression: '简洁', workStyle: '核实来源' });

test('committed context is exactly the engine prompt; edits after capture affect only later tasks', async t => {
  const { taskContextResultSchema } = await import('../contracts/run-context.mjs');
  const s = await setup(t, { gated: true }), roomId = s.room('A'), otherRoom = s.room('B');
  s.execute(soul('iris', 'Iris original')); s.execute(soul('ember', 'OTHER AGENT SOUL'));
  const personal = s.execute(save(agentScope('iris'), 'old preference'));
  s.execute(save(agentScope('ember'), 'OTHER AGENT MEMORY'));
  s.execute(save({ kind: 'room', roomId: otherRoom }, 'OTHER ROOM MEMORY'));
  const message = s.execute({ type: 'sendDiscussion', roomId, text: 'RAW SOURCE MUST NOT BE INJECTED' });
  s.execute({ type: 'saveExplicitMemory', scope: { kind: 'room', roomId }, text: 'room summary', source: { kind: 'message', messageId: message.messageId, revision: 1 } });
  const taskId = s.create(roomId, '目标保持原文。');
  assert.equal(taskContextResultSchema.parse(s.context(roomId, taskId)).status, 'not_started');
  // The task is still queued: this correction commits before the startup microtask.
  s.execute({ type: 'correctExplicitMemory', scope: agentScope('iris'), memoryId: personal.entityId, expectedRevision: 1, text: 'before capture' });
  await until(() => s.runs.length === 1);
  const snapshot = taskContextResultSchema.parse(s.context(roomId, taskId)).snapshot;
  assert.equal(s.task(roomId, taskId).phase, 'dispatching');
  assert.equal(snapshot.soulRevision, 1); assert.equal(snapshot.memories.find(x => x.id === personal.entityId).revision, 2);
  assert.equal(snapshot.memories.length, 2);
  assert.doesNotMatch(snapshot.prompt, /OTHER AGENT|OTHER ROOM|RAW SOURCE/);
  assert.equal(snapshot.prompt.endsWith('目标保持原文。'), true);
  // Factory barrier: the snapshot is committed, but the engine has not started yet.
  s.execute(soul('iris', 'Iris edited after capture', 1));
  s.execute({ type: 'forgetExplicitMemory', scope: agentScope('iris'), memoryId: personal.entityId, expectedRevision: 2 });
  s.runs[0].release(); await until(() => s.runs[0].prompt);
  assert.equal(s.runs[0].prompt, snapshot.prompt);
  assert.equal(s.task(roomId, taskId).goal, '目标保持原文。');
  assert.deepEqual(Object.keys(s.runs[0].engineOptions), ['executionTag'], 'Memory text cannot enable publication or other engine capabilities');
  assert.match(s.runs[0].engineOptions.executionTag, /^[a-f0-9-]{36}$/);
  s.runs[0].ask();
  const waiting = s.task(roomId, taskId);
  assert.equal(waiting.phase, 'awaiting_input');
  const answer = await s.request(`/rooms/${roomId}/local-tasks/${taskId}/answers`, { workspaceId: s.workspaceId, questionId: waiting.question.id, expectedRevision: 0, optionIds: [], text: 'continue' });
  assert.equal(answer.status, 200);
  await until(() => s.task(roomId, taskId).phase === 'reviewing');
  assert.deepEqual(s.context(roomId, taskId).snapshot, snapshot);
  const route = `/rooms/${roomId}/local-tasks/${taskId}/context`;
  assert.deepEqual((await s.request(route)).data.snapshot, snapshot);
  assert.equal((await s.request(route, null, false)).status, 401);
  assert.equal((await s.request(`/rooms/${otherRoom}/local-tasks/${taskId}/context`)).status, 404);
  assert.throws(() => s.runtime.query({ type: 'taskContextSnapshot', roomId, taskId }, { principalId: 'ember' }), { code: 'forbidden' });
  const next = s.create(roomId); await until(() => s.runs.length === 2);
  const newSnapshot = s.context(roomId, next).snapshot;
  assert.equal(newSnapshot.soulRevision, 2); assert.equal(newSnapshot.memories.length, 1);
  assert.equal(newSnapshot.memories[0].text, 'room summary');
  assert.doesNotMatch(newSnapshot.prompt, /before capture/);
  s.runs[1].release(); await until(() => s.runs[1].prompt); s.runs[1].finish();
});

test('a before-context barrier observes a deletion committed before capture and never sends it', async t => {
  let s, memoryId, armed = false;
  s = await setup(t, { fault(point) {
    if (point === 'before_context' && armed) { armed = false; s.execute({ type: 'forgetExplicitMemory', scope: agentScope('iris'), memoryId, expectedRevision: 1 }); }
  } });
  const roomId = s.room('A'); memoryId = s.execute(save(agentScope('iris'), 'DELETE BEFORE START')).entityId;
  armed = true; const taskId = s.create(roomId); await until(() => s.runs[0]?.prompt);
  assert.deepEqual(s.context(roomId, taskId).snapshot.memories, []);
  assert.equal(s.runs[0].prompt, 'Original goal'); s.runs[0].finish();
});

test('loads budget-fitting records in deterministic update order without relevance search', async t => {
  const s = await setup(t), roomId = s.room('A');
  for (const scope of [agentScope('iris'), { kind: 'room', roomId }]) for (let i = 0; i < 16; i++) s.execute(save(scope, `note-${scope.kind}-${i}` + '😀'.repeat(220)));
  const taskId = s.create(roomId, 'Unrelated question'); await until(() => s.runs[0]?.prompt);
  const snapshot = s.context(roomId, taskId).snapshot;
  assert.equal(snapshot.memories.length, 32);
  for (const kind of ['agent', 'room']) {
    const selected = snapshot.memories.filter(row => row.scope.kind === kind);
    const scope = kind === 'agent' ? agentScope('iris') : { kind: 'room', roomId };
    const expected = s.runtime.query({ type: 'explicitMemories', workspaceId: s.workspaceId, scope }, s.actor).memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    assert.deepEqual(selected.map(row => row.id), expected.map(row => row.id));
    assert.equal(snapshot.memoryContexts.find(c => c.scope.kind === kind).deferred, 0);
    for (const row of selected) assert.ok(snapshot.prompt.includes(row.text));
  }
  assert.equal(s.runs[0].prompt, snapshot.prompt); s.runs[0].finish();
});

test('empty configuration preserves the original prompt and persists a real empty snapshot', async t => {
  const s = await setup(t), roomId = s.room('A'), taskId = s.create(roomId, 'No config');
  await until(() => s.runs[0]?.prompt);
  const snapshot = s.context(roomId, taskId).snapshot;
  assert.equal(snapshot.soul, null); assert.equal(snapshot.soulRevision, null); assert.deepEqual(snapshot.memories, []);
  assert.equal(snapshot.contextText, ''); assert.equal(snapshot.prompt, 'No config'); assert.equal(s.runs[0].prompt, 'No config');
  s.runs[0].finish();
});

test('two registered Agent identities load their own Souls across restart without cross-room memory', async t => {
  let s = await setup(t); const roomId = s.room('A');
  s.execute(soul('iris', 'IRIS')); s.execute(soul('ember', 'EMBER'));
  s.execute(save(agentScope('iris'), 'IRIS private')); s.execute(save(agentScope('ember'), 'EMBER private'));
  const first = s.create(roomId); await until(() => s.runs[0]?.prompt); s.runs[0].finish();
  await until(() => s.task(roomId, first).phase === 'reviewing');
  const firstSnapshot = s.context(roomId, first).snapshot, directory = s.directory; await s.close();
  s = await setup(t, { directory, agentId: 'ember' }); assert.equal(s.runs.length, 0);
  assert.deepEqual(s.context(roomId, first).snapshot, firstSnapshot);
  const second = s.create(roomId); await until(() => s.runs[0]?.prompt);
  assert.match(s.runs[0].prompt, /EMBER private/); assert.doesNotMatch(s.runs[0].prompt, /IRIS/);
  assert.equal(s.context(roomId, second).snapshot.soul.personality, 'EMBER'); s.runs[0].finish();
});

for (const corruption of ['oversized-memory', 'oversized-soul', 'source', 'tombstone']) test(`invalid ${corruption} prevents engine startup instead of omitting records`, async t => {
  const s = await setup(t), roomId = s.room('A'); s.execute(soul('iris', 'safe'));
  const saved = s.execute(save(agentScope('iris'), 'required context'));
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(path.join(s.directory, 'application.sqlite'));
  if (corruption === 'oversized-memory') db.prepare('UPDATE memory_revisions SET text=? WHERE memory_id=?').run('x'.repeat(2049), saved.entityId);
  if (corruption === 'oversized-soul') db.prepare('UPDATE agent_souls SET content_json=?').run(JSON.stringify({ personality: 'x'.repeat(2049), expression: '', workStyle: '' }));
  if (corruption === 'source') db.exec("UPDATE memory_sources SET text='tampered evidence'");
  if (corruption === 'tombstone') db.exec("INSERT INTO memory_source_tombstones SELECT scope_kind,scope_id,source_id,memory_id,2,'test' FROM memory_source_links");
  db.close();
  const taskId = s.create(roomId); await until(() => s.task(roomId, taskId).phase === 'failed');
  assert.equal(s.runs.length, 0); assert.equal(s.context(roomId, taskId).snapshot, null);
});

test('missing or damaged committed snapshot is reported as unavailable, never an invented empty context', async t => {
  const s = await setup(t), roomId = s.room('A'), taskId = s.create(roomId);
  await until(() => s.runs[0]?.prompt); s.runs[0].finish(); await until(() => s.task(roomId, taskId).phase === 'reviewing');
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(path.join(s.directory, 'application.sqlite'));
  db.prepare("UPDATE run_context_snapshots SET payload_json='{}' WHERE task_id=?").run(taskId);
  assert.throws(() => s.context(roomId, taskId), { code: 'context_unavailable' });
  db.prepare('DELETE FROM run_context_snapshots WHERE task_id=?').run(taskId);
  assert.throws(() => s.context(roomId, taskId), { code: 'context_unavailable' }); db.close();
});

test('legacy tasks expose missing historical context honestly; v4 memory survives the v5 migration', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-migration-'));
  let db = new DatabaseSync(path.join(directory, 'application.sqlite'));
  db.exec(await fs.readFile(path.join(__dirname, 'fixtures/persistence-v3.sql'), 'utf8')); db.close();
  const legacy = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/persistence-v3-expected.json'), 'utf8'));
  let s = await setup(t, { directory });
  assert.equal(s.context(legacy.roomId, legacy.taskReceipt.taskId).status, 'not_recorded');
  s.execute(soul('iris', 'migration soul')); s.execute(save(agentScope('iris'), 'migration fact')); await s.close();
  // No new task has run; removing later v5/v6 tables yields the unchanged v4 schema.
  db = new DatabaseSync(path.join(directory, 'application.sqlite')); db.exec('DROP TABLE memory_curation_inspections; DROP TABLE memory_curation_queue; DROP TABLE memory_curation_seen; DROP TABLE memory_curation_runs; DROP TABLE memory_curation_scopes; DROP TABLE form_responses; DROP TABLE form_waits; ALTER TABLE artifact_versions DROP COLUMN kind; DROP TABLE attachments; ALTER TABLE messages DROP COLUMN attachment_refs_json; DROP INDEX local_tasks_terminal_lease; DROP INDEX local_tasks_agent_phase; DROP TABLE consultation_jobs; DROP TABLE consultations; DROP TABLE run_context_snapshots; PRAGMA user_version=4;'); db.close();
  s = await setup(t, { directory });
  const taskId = s.create(legacy.roomId); await until(() => s.runs[0]?.prompt);
  const snapshot = s.context(legacy.roomId, taskId).snapshot;
  assert.equal(snapshot.soul.personality, 'migration soul'); assert.equal(snapshot.memories[0].text, 'migration fact');
  assert.equal(s.context(legacy.roomId, legacy.taskReceipt.taskId).status, 'not_recorded'); s.runs[0].finish();
});
