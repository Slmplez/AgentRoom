import { createMemoryCurator } from './memory-curation.mjs';
import { persistenceError } from '../../contracts/persistence.mjs';

// Owns scheduling and durable inspection requests; the model module owns its
// execution ledger. Public command receipts are committed by ApplicationRuntime.
export function memoryCurationRuntime({ db, atomic, engine, allowedScope, clock, checkpoint }) {
  const curator = createMemoryCurator({ db, atomic, engine, allowedScope, clock, checkpoint });
  let closed = false, scheduled = false, inspecting = null;
  function invoke(action) {
    try { return action(); }
    catch (error) {
      if (error.code) throw persistenceError(error.code, error.message, error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409);
      throw error;
    }
  }
  function inspectPending() {
    if (closed || inspecting) return inspecting || Promise.resolve();
    inspecting = (async () => {
      for (const row of db.prepare('SELECT * FROM memory_curation_inspections WHERE completed=0').all()) {
        if (closed) return;
        await curator.inspect(JSON.parse(row.scope_json), row.run_id);
        if (!closed) atomic(() => db.prepare('UPDATE memory_curation_inspections SET completed=1 WHERE operation_id=?').run(row.operation_id));
      }
    })().finally(() => { inspecting = null; });
    return inspecting;
  }
  function schedule() {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closed) return;
      // A failed tick is recorded by the module, never replayed by this scheduler.
      void inspectPending().then(() => closed ? undefined : curator.tick()).catch(() => {});
    });
  }
  return {
    recover() { curator.recover(); schedule(); }, schedule,
    context: scope => invoke(() => curator.context(scope)),
    query: q => invoke(() => q.type === 'memoryCurationStatus' ? curator.status(q.scope) : curator.history(q.scope, q)),
    apply(c, operationId) {
      return invoke(() => {
        if (c.type === 'configureMemoryCuration') return { type: c.type, ...curator.configure(c.scope, c) };
        const run = db.prepare('SELECT * FROM memory_curation_runs WHERE id=?').get(c.runId);
        if (!allowedScope(c.scope) || !run || run.scope_key !== JSON.stringify(c.scope.kind === 'agent' ? ['agent', c.scope.agentId] : ['room', c.scope.roomId])) throw persistenceError('not_found', '整理记录不可访问。', 404);
        if (run.status === 'running') throw persistenceError('busy', '整理仍在运行。', 409);
        db.prepare('INSERT INTO memory_curation_inspections(operation_id,scope_json,run_id) VALUES(?,?,?)').run(operationId, JSON.stringify(c.scope), c.runId);
        return { type: c.type, scope: c.scope, runId: c.runId };
      });
    },
    async inspected() { try { await inspectPending(); } catch {} },
    shutdown() { closed = true; curator.shutdown(); },
  };
}
