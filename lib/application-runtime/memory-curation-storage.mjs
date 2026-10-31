// Called by the future application migration inside its existing transaction.
// This isolated slice deliberately does not assign PRAGMA user_version: #38/#39
// own the pending shared migration sequence.
export function installMemoryCurationSchema(db) {
  db.exec(`
    CREATE TABLE memory_curation_scopes (
      scope_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      policy_revision INTEGER NOT NULL DEFAULT 1, head_revision INTEGER NOT NULL DEFAULT 0,
      head_json TEXT NOT NULL, head_hash TEXT NOT NULL
    );
    CREATE TABLE memory_curation_queue (
      scope_key TEXT NOT NULL REFERENCES memory_curation_scopes(scope_key),
      memory_id TEXT NOT NULL REFERENCES explicit_memories(id), PRIMARY KEY(scope_key,memory_id)
    );
    CREATE TABLE memory_curation_seen (
      scope_key TEXT NOT NULL REFERENCES memory_curation_scopes(scope_key),
      memory_id TEXT NOT NULL REFERENCES explicit_memories(id), revision INTEGER NOT NULL,
      PRIMARY KEY(scope_key,memory_id)
    );
    CREATE TABLE memory_curation_runs (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL REFERENCES memory_curation_scopes(scope_key),
      policy_revision INTEGER NOT NULL, head_revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','applied','failed','stale','unknown')),
      lease_held INTEGER NOT NULL CHECK(lease_held IN (0,1)), execution_tag TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
      output_json TEXT, output_hash TEXT, note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX memory_curation_runs_scope ON memory_curation_runs(scope_key,position);
    CREATE INDEX memory_curation_runs_lease ON memory_curation_runs(lease_held);
    CREATE INDEX memory_curation_runs_started ON memory_curation_runs(started_at);
  `);
}
