const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const iris = { kind: 'agent', agentId: 'iris' }, ember = { kind: 'agent', agentId: 'ember' };
const parseInput = prompt => JSON.parse(prompt.split('\n').at(-1));
const merge = inputs => ({ summaries: [{ inputs: inputs.map(i => i.key), text: inputs.map(i => i.text).join('；').slice(0, 1024), reason: '综合本轮明确记录，保留限定条件。' }], archives: [] });
async function setup(t, options = {}) {
  const { openStorage } = await import('../lib/application-runtime/storage.mjs');
  const { createMemoryCurator } = await import('../lib/application-runtime/memory-curation.mjs');
  const { agentMemory } = await import('../lib/application-runtime/agent-memory.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'ar-curation-'));
  const db = await openStorage(directory, 5000);
  const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  let now = 1800000000000, starts = 0;
  const actor = { id: db.prepare('SELECT owner_id FROM database_meta').get().owner_id };
  const memories = agentMemory(db);
  const engine = options.unconfigured ? null : { agentId: 'memory-curator', model: 'test-fixture', inspectStopped: async () => options.inspected !== false, createEngine() {
    starts++;
    return { onQuestion() {}, async start() {}, async prompt(prompt) { const { inputs, scope } = parseInput(prompt); return options.reply ? options.reply(inputs, scope, prompt) : { outcome: 'complete', text: JSON.stringify(merge(inputs)) }; },
      async close() {}, isStopped: () => options.stopped !== false };
  } };
  const factory = () => createMemoryCurator({ db, atomic, engine, allowedScope: options.allowedScope || (() => true), clock: () => now, executionMs: options.executionMs || 120000, checkpoint: options.checkpoint });
  let curator = factory();
  t.after(() => { curator.shutdown(); db.close(); });
  function apply(command) { return atomic(() => memories.apply(command, actor, new Date(now).toISOString())); }
  // Test fixture supports the future unbounded source ledger without changing
  // the existing application contract's 16-record limit in this isolated slice.
  function seed(text, scope = iris) {
    const id = randomUUID(), source = randomUUID(), date = new Date(now).toISOString();
    atomic(() => {
      db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(source, 'owner-note', text, createHash('sha256').update(text).digest('hex'), actor.id, date, date, null, null, null, actor.id);
      db.prepare('INSERT INTO explicit_memories VALUES(?,?,?,?,?)').run(id, scope.kind, scope.agentId || scope.roomId, 1, 'active');
      db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run(id, 1, 'active', text, JSON.stringify([source]), actor.id, date);
      db.prepare('INSERT INTO memory_source_links VALUES(?,?,?,?)').run(scope.kind, scope.agentId || scope.roomId, source, id);
    }); return id;
  }
  return { db, atomic, seed, apply, directory, actor, get curator() { return curator; }, starts: () => starts, advance: (n = 600000) => { now += n; },
    restart() { curator.shutdown(); curator = factory(); curator.recover(); return curator; },
    correct: (id, text, revision = 1, scope = iris) => apply({ type: 'correctExplicitMemory', scope, memoryId: id, expectedRevision: revision, text }),
    forget: (id, revision = 1, scope = iris) => apply({ type: 'forgetExplicitMemory', scope, memoryId: id, expectedRevision: revision }),
  };
}

test('a full-provenance summary is deferred whole when a fresh record consumes the remaining context budget', async t => {
  const s = await setup(t), refs = [], scopeKey = JSON.stringify(['agent', 'iris']);
  s.curator.configure(iris, { enabled: false, expectedRevision: 0 });
  s.atomic(() => {
    const source = s.db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const memory = s.db.prepare('INSERT INTO explicit_memories VALUES(?,?,?,?,?)');
    const revision = s.db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)');
    const link = s.db.prepare('INSERT INTO memory_source_links VALUES(?,?,?,?)');
    const seen = s.db.prepare('INSERT INTO memory_curation_seen VALUES(?,?,?)');
    for (let i=0;i<10000;i++) {
      const id = `memory-${i}`, sid = `source-${i}`, date = new Date(1800000000000).toISOString();
      source.run(sid,'owner-note','Evidence',createHash('sha256').update('Evidence').digest('hex'),s.actor.id,date,date,null,null,null,s.actor.id);
      memory.run(id,'agent','iris',1,'active'); revision.run(id,1,'active','Evidence',JSON.stringify([sid]),s.actor.id,date);
      link.run('agent','iris',sid,id);seen.run(scopeKey,id,1);refs.push({id,revision:1});
    }
    const head = JSON.stringify([{ id:'summary-full',runId:'run-full',text:'Evidence summary',reason:'All original references retained',refs }]);
    s.db.prepare('UPDATE memory_curation_scopes SET head_json=?,head_hash=?,head_revision=1 WHERE scope_key=?').run(head,createHash('sha256').update(head).digest('hex'),scopeKey);
  });
  assert.equal(s.curator.context(iris).items[0].refs.length,10000);
  const fresh = s.seed('Fresh evidence');
  const context = s.curator.context(iris);
  const { memoryContextSchema } = await import('../contracts/run-context.mjs');
  assert.ok(memoryContextSchema.safeParse(context).success);
  assert.equal(context.deferred,1);assert.equal(context.items.length,1);assert.equal(context.items[0].refs[0].id,fresh);
  assert.equal(s.curator.status(iris).summaries[0].refs.length,10000,'The summary and its original provenance were not truncated or deleted');
  s.atomic(()=>{s.db.prepare('INSERT INTO rooms(id,workspace_id,title) VALUES(?,?,?)').run('context-room',s.db.prepare('SELECT workspace_id FROM database_meta').get().workspace_id,'Room');});
  const {agentMemory}=await import('../lib/application-runtime/agent-memory.mjs');
  const snapshot=s.atomic(()=>agentMemory(s.db,{curationContext:scope=>s.curator.context(scope)}).createRunContextSnapshot({id:'budget-task',runId:'budget-run',roomId:'context-room',ownerAgentId:'iris',goal:'Still starts'},new Date().toISOString(),{persist:false}));
  assert.equal(snapshot.memoryContexts[0].deferred,1);
});

test('automatic merge preserves raw source versions and Souls; queries and unchanged ticks do not call model', async t => {
  const s = await setup(t); const a = s.seed('偏好先给结论'), b = s.seed('再解释依据');
  s.apply({ type: 'editAgentSoul', agentId: 'iris', expectedRevision: 0, personality: '独立个性', expression: '简洁', workStyle: '核实' });
  const before = s.db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id').all();
  for (let i = 0; i < 10; i++) s.curator.status(iris);
  assert.equal(s.starts(), 0);
  await s.curator.tick();
  const status = s.curator.status(iris);
  const { curationStatusSchema, curationHistorySchema } = await import('../contracts/memory-curation-view.mjs');
  assert.equal(curationStatusSchema.safeParse(status).success, true);
  assert.equal(curationHistorySchema.safeParse(s.curator.history(iris)).success, true);
  assert.equal(status.latestRun.status, 'applied'); assert.equal(status.pending, 0);
  assert.equal(status.summaries.length, 1); assert.deepEqual(new Set(status.summaries[0].refs.map(r => r.id)), new Set([a, b]));
  assert.deepEqual(s.db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id').all(), before);
  assert.equal(JSON.parse(s.db.prepare('SELECT content_json FROM agent_souls').get().content_json).personality, '独立个性');
  s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
  assert.equal(s.curator.history(iris).runs[0].output.summaries[0].reason, '综合本轮明确记录，保留限定条件。');
  s.restart(); assert.equal(s.curator.context(iris).items[0].text, status.summaries[0].text);
});

test('scopes remain isolated and global cooldown serializes work', async t => {
  const inputsSeen = [];
  const s = await setup(t, { reply(inputs, scope) { inputsSeen.push({ scope, inputs }); return { outcome: 'complete', text: JSON.stringify(merge(inputs)) }; } });
  s.seed('IRIS', iris); s.seed('EMBER', ember);
  await Promise.all([s.curator.tick(), s.curator.tick(), s.curator.tick()]); assert.equal(s.starts(), 1);
  await s.curator.tick(); assert.equal(s.starts(), 1);
  s.advance(); await s.curator.tick(); assert.equal(s.starts(), 2);
  assert.ok(inputsSeen.every(x => x.inputs.every(i => i.text === x.scope.agentId.toUpperCase())));
  assert.match(s.curator.context(iris).items[0].text, /IRIS/);
  assert.doesNotMatch(s.curator.context(iris).items[0].text, /EMBER/);
});

test('archive is traceable and does not erase or resurrect its source; explicit correction is new evidence', async t => {
  const s = await setup(t, { reply(inputs) { return { outcome: 'complete', text: JSON.stringify({ summaries: [], archives: [{ inputs: inputs.map(i => i.key), reason: '明确过期的临时安排' }] }) }; } });
  const id = s.seed('昨天的临时安排'); await s.curator.tick();
  assert.deepEqual(s.curator.context(iris).items, []); assert.equal(s.curator.status(iris).pending, 0);
  assert.equal(s.curator.history(iris).runs[0].output.archives[0].reason, '明确过期的临时安排');
  s.correct(id, '经更正确认的新安排'); assert.equal(s.curator.context(iris).items[0].text, '经更正确认的新安排');
  s.forget(id, 2); assert.deepEqual(s.curator.context(iris).items, []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memory_source_tombstones').get().n, 2);
});

test('manual correction/deletion invalidates entire dependent summary immediately and rebuilds remaining evidence', async t => {
  const s = await setup(t), a = s.seed('旧结论'), b = s.seed('有效条件'); await s.curator.tick();
  s.correct(a, '新结论');
  assert.equal(s.curator.status(iris).stale, 1);
  assert.deepEqual(new Set(s.curator.context(iris).items.map(i => i.text)), new Set(['新结论', '有效条件']));
  s.forget(a, 2); s.advance(); await s.curator.tick();
  assert.equal(s.curator.status(iris).latestRun.status, 'applied');
  assert.equal(s.curator.context(iris).items[0].text, '有效条件');
  assert.deepEqual(s.curator.context(iris).items[0].refs, [{ id: b, revision: 1 }]);
  assert.equal(s.db.prepare('SELECT status FROM explicit_memories WHERE id=?').get(a).status, 'deleted');
});

test('model response based on concurrent edits or pause is rejected atomically', async t => {
  let release;
  const s = await setup(t, { reply(inputs) { return new Promise(resolve => { release = () => resolve({ outcome: 'complete', text: JSON.stringify(merge(inputs)) }); }); } });
  const id = s.seed('before'); const flight = s.curator.tick();
  while (!release) await new Promise(r => setImmediate(r));
  s.correct(id, 'after'); release(); await flight;
  assert.equal(s.curator.status(iris).latestRun.status, 'stale'); assert.equal(s.curator.status(iris).summaries.length, 0);
  assert.equal(s.curator.context(iris).items[0].text, 'after');
  s.advance(); release = null; const second = s.curator.tick(); while (!release) await new Promise(r => setImmediate(r));
  s.curator.configure(iris, { enabled: false, expectedRevision: s.curator.status(iris).revision }); release(); await second;
  assert.equal(s.curator.status(iris).latestRun.status, 'stale'); assert.equal(s.curator.status(iris).enabled, false);
});

test('forged, duplicate, omitted and oversized model outputs cannot change the projection', async t => {
  for (const make of [
    inputs => ({ summaries: [{ inputs: ['foreign'], text: 'bad', reason: 'bad' }], archives: [] }),
    inputs => ({ summaries: [{ inputs: [inputs[0].key, inputs[0].key], text: 'bad', reason: 'bad' }], archives: [] }),
    () => ({ summaries: [], archives: [] }),
    inputs => ({ summaries: [{ inputs: inputs.map(i => i.key), text: '😀'.repeat(1025), reason: 'bad' }], archives: [] }),
  ]) {
    const s = await setup(t, { reply: inputs => ({ outcome: 'complete', text: JSON.stringify(make(inputs)) }) }); s.seed('source'); await s.curator.tick();
    assert.equal(s.curator.status(iris).latestRun.status, 'failed'); assert.equal(s.curator.context(iris).items[0].text, 'source');
    s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1, 'invalid output is not a retry loop');
  }
});

test('unconfirmed stop and interrupted execution retain global lease and do not replay after restart', async t => {
  const s = await setup(t, { stopped: false, inspected: false }); s.seed('source'); await s.curator.tick();
  assert.equal(s.curator.status(iris).latestRun.status, 'unknown'); assert.equal(s.curator.status(iris).latestRun.leaseHeld, 1);
  s.seed('other', ember); s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
  assert.throws(() => s.curator.configure(iris, { enabled: true, expectedRevision: 1 }), { code: 'busy' });
  assert.equal(await s.curator.inspect(iris, s.curator.status(iris).latestRun.id), false);
  s.restart(); s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
});

test('unknown reply remains blocked even when stopped; explicit fresh policy may resume', async t => {
  const s = await setup(t, { reply: () => { throw Error('connection lost after dispatch'); } }); s.seed('source'); await s.curator.tick();
  assert.equal(s.curator.status(iris).latestRun.status, 'unknown'); assert.equal(s.curator.status(iris).latestRun.leaseHeld, 0);
  s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
  s.curator.configure(iris, { enabled: true, expectedRevision: 1 }); await s.curator.tick(); assert.equal(s.starts(), 2);
});

test('transaction failure cannot partially acknowledge inputs or commit projection', async t => {
  const s = await setup(t, { checkpoint(point) { if (point === 'curation_projection') throw Error('commit fixture'); } }); s.seed('source'); await s.curator.tick();
  assert.equal(s.curator.status(iris).summaries.length, 0); assert.equal(s.curator.status(iris).pending, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memory_curation_seen').get().n, 0);
  assert.equal(s.curator.status(iris).latestRun.status, 'unknown');
});

test('corrupt sources and history fail closed, without model calls', async t => {
  const s = await setup(t); s.seed('source'); await s.curator.tick();
  s.db.prepare("UPDATE memory_sources SET text='tampered'").run();
  assert.throws(() => s.curator.context(iris), { code: 'memory_unavailable' });
  s.advance(); assert.throws(() => s.curator.tick(), { code: 'memory_unavailable' }); assert.equal(s.starts(), 1);
  s.db.prepare("UPDATE memory_curation_runs SET input_json='{}'").run();
  assert.throws(() => s.curator.history(iris), { code: 'curation_unavailable' });
});

test('batches and deterministic context remain bounded beyond sixteen source records', async t => {
  const s = await setup(t); for (let i = 0; i < 40; i++) { s.seed('record-' + i); s.advance(1); }
  const before = s.curator.context(iris); assert.equal(before.items.length, 16); assert.equal(before.deferred, 24);
  await s.curator.tick(); const run = s.curator.history(iris).runs[0];
  assert.equal(run.input.selected.length, 32); assert.equal(s.curator.status(iris).pending, 8);
  assert.ok(Buffer.byteLength(run.input.prompt) <= 65536);
  s.advance(); await s.curator.tick(); assert.equal(s.curator.status(iris).pending, 0);
  assert.equal(s.curator.context(iris).items[0].refs.length, 40);
});

test('missing host engine is visible and never synthesizes a successful background run', async t => {
  const s = await setup(t, { unconfigured: true }); s.seed('source'); await s.curator.tick();
  assert.equal(s.curator.status(iris).configured, false); assert.equal(s.curator.status(iris).latestRun, null);
  assert.throws(() => s.curator.configure(iris, { enabled: true, expectedRevision: 0 }), { code: 'unconfigured' });
});

test('rolling daily budget persists across restart and stops otherwise eligible new work', async t => {
  const s = await setup(t); const id = s.seed('note-0');
  for (let i = 0; i < 24; i++) {
    if (i) s.correct(id, 'note-' + i, i);
    await s.curator.tick(); s.advance();
  }
  assert.equal(s.starts(), 24);
  s.correct(id, 'next-day', 24); s.restart(); await s.curator.tick(); assert.equal(s.starts(), 24);
  s.advance(86400000); await s.curator.tick(); assert.equal(s.starts(), 25);
});

test('deadline and shutdown fence late output; stopped jobs are not silently retried', async t => {
  let resolve, inputs;
  const s = await setup(t, { executionMs: 10, reply(items) { inputs = items; return new Promise(r => { resolve = r; }); } });
  s.seed('source');
  // Keep the test process alive while the production timer remains unref'ed.
  const keepAlive = setTimeout(() => {}, 30000); t.after(() => clearTimeout(keepAlive));
  await s.curator.tick(); assert.equal(s.curator.status(iris).latestRun.status, 'unknown');
  resolve({ outcome: 'complete', text: JSON.stringify(merge(inputs)) }); await new Promise(r => setImmediate(r));
  assert.equal(s.curator.status(iris).summaries.length, 0); s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
  s.curator.configure(iris, { enabled: true, expectedRevision: 1 });
  resolve = null; const flight = s.curator.tick(); while (!resolve) await new Promise(r => setImmediate(r));
  s.curator.shutdown(); resolve({ outcome: 'complete', text: JSON.stringify(merge(inputs)) }); await flight;
  assert.equal(s.curator.status(iris).latestRun.status, 'unknown'); assert.equal(s.curator.status(iris).summaries.length, 0);
});

test('host scope authorization applies to read/configuration/history and scheduler discovery', async t => {
  const s = await setup(t, { allowedScope: scope => scope.kind === 'agent' && scope.agentId === 'iris' });
  s.seed('allowed'); s.seed('not registered', ember); await s.curator.tick(); s.advance(); await s.curator.tick(); assert.equal(s.starts(), 1);
  for (const fn of [() => s.curator.status(ember), () => s.curator.context(ember), () => s.curator.history(ember), () => s.curator.configure(ember, { enabled: true, expectedRevision: 0 })]) assert.throws(fn, { code: 'not_found' });
});

test('Room message provenance cannot cross Room or Agent scope and deletion keeps the original tombstone', async t => {
  const s = await setup(t), workspace = s.db.prepare('SELECT workspace_id FROM database_meta').get().workspace_id;
  const roomA = { kind: 'room', roomId: randomUUID() }, roomB = { kind: 'room', roomId: randomUUID() }, messageId = randomUUID();
  s.atomic(() => {
    for (const scope of [roomA, roomB]) s.db.prepare('INSERT INTO rooms(id,workspace_id,title) VALUES(?,?,?)').run(scope.roomId, workspace, scope.roomId);
    s.db.prepare('INSERT INTO messages(id,room_id,sequence,author_id,author_kind,author_name_snapshot,text,created_at) VALUES(?,?,?,?,?,?,?,?)').run(messageId, roomA.roomId, 1, s.actor.id, 'human', 'Owner', 'Room A 原始决策', new Date().toISOString());
  });
  const a = s.apply({ type: 'saveExplicitMemory', scope: roomA, text: 'ROOM_A', source: { kind: 'message', messageId, revision: 1 } }).entityId;
  s.seed('ROOM_B', roomB);
  await s.curator.tick(); s.advance(); await s.curator.tick();
  assert.equal(s.curator.context(roomA).items[0].text, 'ROOM_A'); assert.equal(s.curator.context(roomB).items[0].text, 'ROOM_B');
  assert.deepEqual(s.curator.context(iris).items, []);
  // A valid text hash does not excuse a forged source Room.
  s.db.prepare('UPDATE memory_sources SET room_id=? WHERE message_id=?').run(roomB.roomId, messageId);
  assert.throws(() => s.curator.context(roomA), { code: 'memory_unavailable' });
  s.db.prepare('UPDATE memory_sources SET room_id=? WHERE message_id=?').run(roomA.roomId, messageId);
  s.forget(a, 1, roomA); assert.deepEqual(s.curator.context(roomA).items, []);
  assert.throws(() => s.apply({ type: 'saveExplicitMemory', scope: roomA, text: 'ROOM_A', source: { kind: 'message', messageId, revision: 1 } }), { code: 'memory_deleted' });
  assert.equal(s.curator.context(roomB).items[0].text, 'ROOM_B');
});

test('SQLite crash recovery keeps reservation, projection and acknowledgements at durable boundaries', async t => {
  const { spawnSync } = require('node:child_process');
  const { openStorage } = await import('../lib/application-runtime/storage.mjs');
  const { createMemoryCurator } = await import('../lib/application-runtime/memory-curation.mjs');
  for (const point of ['curation_reserved', 'curation_before_engine', 'curation_projection', 'after_commit']) {
    const directory = await mkdtemp(join(tmpdir(), 'ar-curation-crash-'));
    const child = spawnSync(process.execPath, [join(__dirname, 'fixtures/memory-curation-crash.cjs'), directory, point], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(child.status, 86, child.stderr || child.error?.message);
    const db = await openStorage(directory, 5000);
    try {
      const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
      let calls = 0;
      const curator = createMemoryCurator({ db, atomic, allowedScope: () => true, engine: { agentId: 'memory-curator', model: 'test-fixture', createEngine() { calls++; throw Error('must not replay'); } } }); curator.recover();
      const state = curator.status(iris);
      if (point === 'curation_reserved') { assert.equal(state.latestRun, null); assert.equal(state.pending, 1); }
      else if (point === 'after_commit') { assert.equal(state.latestRun.status, 'applied'); assert.equal(state.summaries.length, 1); assert.equal(state.pending, 0); }
      else { assert.equal(state.latestRun.status, 'unknown'); assert.equal(state.latestRun.leaseHeld, 1); assert.equal(state.summaries.length, 0); assert.equal(state.pending, 1); await curator.tick(); assert.equal(calls, 0); }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n, 1);
      curator.shutdown();
    } finally { db.close(); }
  }
});
