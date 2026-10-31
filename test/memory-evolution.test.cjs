const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const scope = { kind: 'agent', agentId: 'iris' };
async function setup(t, { directory, execution } = {}) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  directory ||= await fs.mkdtemp(join(tmpdir(), 'ar-memory-evolution-'));
  const runtime = await createApplicationRuntime({ directory, knownAgents: ['iris', 'ember'], execution });
  const db = new DatabaseSync(join(directory, 'application.sqlite'));
  const actor = runtime.owner, workspaceId = runtime.query({ type: 'bootstrap' }, actor).workspace.id;
  let i = 0;
  const execute = command => runtime.execute({ workspaceId, key: 'command-' + i++, ...command }, actor);
  t.after(() => { runtime.close(); db.close(); });
  return { directory, runtime, db, workspaceId, actor, execute,
    query: q => runtime.query(q.type === 'taskContextSnapshot' ? q : { workspaceId, ...q }, actor),
    save: text => execute({ type: 'saveExplicitMemory', scope, text, source: { kind: 'owner-note' } }),
  };
}

test('more than sixteen long records persist and paginate without a storage ceiling or duplicate pages', async t => {
  const s = await setup(t), ids = [];
  ids.push(s.save('😀'.repeat(2048)).entityId);
  for (let i = 1; i < 55; i++) ids.push(s.save('Record-' + i).entityId);
  assert.throws(() => s.save('😀'.repeat(2049)), { code: 'invalid_request' });
  const seen = []; let afterId;
  do {
    const page = s.query({ type: 'explicitMemories', scope, limit: 7, ...(afterId ? { afterId } : {}) });
    assert.equal(page.total, 55); assert.equal(page.limits.perScope, null); assert.equal(page.limits.text, 2048);
    assert.ok(page.memories.length <= 7); seen.push(...page.memories.map(m => m.id)); afterId = page.afterId;
  } while (afterId);
  assert.deepEqual(seen, ids.sort());
  const first = s.query({ type: 'explicitMemories', scope, limit: 7 });
  s.execute({ type: 'forgetExplicitMemory', scope, memoryId: first.afterId, expectedRevision: 1 });
  const second = s.query({ type: 'explicitMemories', scope, limit: 7, afterId: first.afterId });
  assert.equal(second.total, 54); assert.ok(second.memories.every(m => m.id > first.afterId));
  assert.deepEqual(s.query({ type: 'explicitMemories', scope: { kind: 'agent', agentId: 'ember' }, afterId: first.afterId }).memories, []);
});

test('unconfigured curator gives actual task dispatch a bounded v2 snapshot with deferred counts', async t => {
  let prompt;
  const s = await setup(t, { execution: { agentId: 'iris', createEngine() { return { onQuestion() {}, async start() {}, async prompt(text) { prompt = text; return { outcome: 'complete', text: 'done' }; }, isStopped: () => true, async close() {} }; } } });
  for (let i = 0; i < 25; i++) s.save(String(i).padStart(2, '0') + '😀'.repeat(2046));
  const roomId = s.execute({ type: 'createRoom', title: 'Evolution' }).roomId;
  const taskId = s.execute({ type: 'createLocalTask', roomId, ownerAgentId: 'iris', goal: 'UNMODIFIED_GOAL' }).taskId;
  for (let i = 0; i < 100 && !prompt; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(prompt);
  const snapshot = s.query({ type: 'taskContextSnapshot', roomId, taskId }).snapshot;
  assert.equal(snapshot.formatVersion, 2); assert.equal(snapshot.memories.length, 4);
  assert.equal(snapshot.memoryContexts[0].characters, 8192); assert.equal(snapshot.memoryContexts[0].deferred, 21);
  assert.equal(snapshot.prompt, prompt); assert.ok(prompt.endsWith('UNMODIFIED_GOAL'));
  assert.equal(s.query({ type: 'explicitMemories', scope }).total, 25);
  s.execute({ type: 'forgetExplicitMemory', scope, memoryId: snapshot.memories[0].id, expectedRevision: 1 });
  assert.deepEqual(s.query({ type: 'taskContextSnapshot', roomId, taskId }).snapshot, snapshot);
});

test('v1 database fixture replays its original receipt/hash and reads its original snapshot byte-for-byte', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const expected = JSON.parse(await fs.readFile(join(__dirname, 'fixtures/memory-v1-expected.json'), 'utf8'));
  const directory = await fs.mkdtemp(join(tmpdir(), 'ar-memory-legacy-'));
  const initial = new DatabaseSync(join(directory, 'application.sqlite'));
  initial.exec(await fs.readFile(join(__dirname, 'fixtures/memory-v1.sql'), 'utf8')); initial.close();
  const s = await setup(t, { directory });
  assert.deepEqual(s.runtime.execute(expected.command, s.actor), expected.receipt);
  assert.deepEqual(s.query({ type: 'taskContextSnapshot', roomId: expected.roomId, taskId: expected.taskId }).snapshot, expected.snapshot);
  assert.deepEqual({ ...s.db.prepare('SELECT * FROM run_context_snapshots WHERE task_id=?').get(expected.taskId) }, expected.snapshotRow);
  assert.equal(s.db.prepare('SELECT request_hash FROM command_receipts WHERE operation_id=?').get(expected.receipt.operationId).request_hash, expected.requestHash);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM explicit_memories').get().n, 1);
});

test('optional curation context freezes summaries and exact provenance; later deletion only affects later snapshots', async t => {
  const s = await setup(t);
  const { agentMemory } = await import('../lib/application-runtime/agent-memory.mjs');
  const { createMemoryCurator } = await import('../lib/application-runtime/memory-curation.mjs');
  const atomic = fn => { s.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); s.db.exec('COMMIT'); return value; } catch (e) { s.db.exec('ROLLBACK'); throw e; } };
  const a = s.save('偏好结论优先'), b = s.save('依据随后解释');
  const roomId = s.execute({ type: 'createRoom', title: 'Summary scope' }).roomId;
  const curator = createMemoryCurator({ db: s.db, atomic, allowedScope: () => true, engine: { agentId: 'memory-curator', model: 'local-fixture', createEngine() { return {
    async start() {}, isStopped: () => true, async close() {}, async prompt(prompt) {
      const { inputs } = JSON.parse(prompt.split('\n').at(-1)); return { outcome: 'complete', text: JSON.stringify({ summaries: [{ inputs: inputs.map(i => i.key), text: '先给结论，再说明依据。', reason: '合并互补的表达偏好' }], archives: [] }) };
    },
  }; } } });
  await curator.tick();
  const memories = agentMemory(s.db, { curationContext: value => curator.context(value) });
  const task = { id: randomUUID(), runId: randomUUID(), ownerAgentId: 'iris', roomId, goal: 'Read frozen context' };
  atomic(() => s.db.prepare('INSERT INTO local_tasks VALUES(?,?,?)').run(task.id, roomId, '{}'));
  const snapshot = atomic(() => memories.createRunContextSnapshot(task, new Date().toISOString()));
  task.contextSnapshotId = snapshot.snapshotId;
  assert.equal(snapshot.formatVersion, 2); assert.equal(snapshot.memories.length, 0);
  assert.equal(snapshot.memoryContexts[0].items[0].kind, 'summary');
  assert.deepEqual(new Set(snapshot.memoryContexts[0].items[0].refs.map(r => r.id)), new Set([a.entityId, b.entityId]));
  assert.ok(snapshot.prompt.includes('先给结论，再说明依据。'));
  s.execute({ type: 'forgetExplicitMemory', scope, memoryId: a.entityId, expectedRevision: 1 });
  assert.deepEqual(memories.taskContextSnapshot(task).snapshot, snapshot);
  const next = atomic(() => memories.createRunContextSnapshot({ ...task, id: randomUUID(), runId: randomUUID() }, new Date().toISOString(), { persist: false }));
  assert.equal(next.memoryContexts[0].stale, 1); assert.equal(next.memoryContexts[0].items[0].kind, 'record');
  assert.equal(next.memories[0].id, b.entityId); assert.doesNotMatch(next.prompt, /偏好结论优先|先给结论，再说明依据/);
  const malicious = agentMemory(s.db, { curationContext: () => snapshot.memoryContexts[0] });
  assert.throws(() => atomic(() => malicious.createRunContextSnapshot(task, new Date().toISOString(), { persist: false })), { code: 'context_unavailable' });
  curator.shutdown();
});

test('snapshot validation rejects malformed v2 provenance/counts without weakening v1 constraints', async () => {
  const { runContextSnapshotSchema } = await import('../contracts/run-context.mjs');
  const expected = JSON.parse(await fs.readFile(join(__dirname, 'fixtures/memory-v1-expected.json'), 'utf8'));
  assert.deepEqual(runContextSnapshotSchema.parse(expected.snapshot), expected.snapshot);
  const oversized = structuredClone(expected.snapshot); oversized.memories[0].text = 'x'.repeat(257);
  assert.equal(runContextSnapshotSchema.safeParse(oversized).success, false);
  const invalid = { ...expected.snapshot, formatVersion: 2, memoryContexts: [] };
  assert.equal(runContextSnapshotSchema.safeParse(invalid).success, false);
});
