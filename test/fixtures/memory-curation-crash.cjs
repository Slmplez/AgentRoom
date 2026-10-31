const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
(async () => {
  const [directory, point] = process.argv.slice(2);
  const moduleAt = file => import(pathToFileURL(resolve(__dirname, '../../lib/application-runtime', file)));
  const { openStorage } = await moduleAt('storage.mjs');
  const { installMemoryCurationSchema } = await moduleAt('memory-curation-storage.mjs');
  const { agentMemory } = await moduleAt('agent-memory.mjs');
  const { createMemoryCurator } = await moduleAt('memory-curation.mjs');
  const db = await openStorage(directory, 5000); let exitAfterCommit = false;
  const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); if (exitAfterCommit) process.exit(86); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  atomic(() => installMemoryCurationSchema(db));
  const scope = { kind: 'agent', agentId: 'iris' }, actor = { id: db.prepare('SELECT owner_id FROM database_meta').get().owner_id };
  atomic(() => agentMemory(db).apply({ type: 'saveExplicitMemory', scope, text: '保留原始记录', source: { kind: 'owner-note' } }, actor, new Date().toISOString()));
  const curator = createMemoryCurator({ db, atomic, allowedScope: () => true, checkpoint(name) {
    if (name === point) process.exit(86);
    if (point === 'after_commit' && name === 'curation_applied') exitAfterCommit = true;
  }, engine: { agentId: 'memory-curator', model: 'test-fixture', createEngine() { return {
    async start() {}, async close() {}, isStopped: () => true,
    async prompt(prompt) { const { inputs } = JSON.parse(prompt.split('\n').at(-1)); return { outcome: 'complete', text: JSON.stringify({ summaries: [{ inputs: inputs.map(i => i.key), text: '保留原始记录', reason: '原文仍有效' }], archives: [] }) }; },
  }; } } });
  await curator.tick(); throw Error('Crash checkpoint was not reached.');
})().catch(e => { console.error(e); process.exitCode = 1; });
