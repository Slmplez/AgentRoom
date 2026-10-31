// Called inside the schema migration transaction. This table installer does not
// assign user_version; migrateMemoryCuration owns the versioned migration.
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
// Keep old receipt/event bytes and hashes; only extend the nullable-room checks.
export function migrateMemoryCuration(db) {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const [table, column, extra] of [
      ['command_receipts', 'command_type', "'configureMemoryCuration','inspectMemoryCuration'"],
      ['events', 'type', "'memoryCuration.updated'"],
    ]) {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
      const constraint = new RegExp(`CHECK\\(room_id IS NOT NULL OR ${column} IN \\(([^)]+)\\)\\)`);
      if (!constraint.test(original)) throw Error('Unrecognized command storage schema.');
      const sql = original.replace(/^CREATE TABLE\s+\S+\s*\(/i, `CREATE TABLE ${table}_v9 (`)
        .replace(constraint, `CHECK(room_id IS NOT NULL OR ${column} IN ($1,${extra}))`);
      db.exec(sql);
      db.exec(`INSERT INTO ${table}_v9 SELECT * FROM ${table}`);
      db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_v9 RENAME TO ${table}`);
    }
    db.exec('CREATE INDEX events_room_position ON events(room_id,position)');
    installMemoryCurationSchema(db);
    db.exec(`CREATE TABLE memory_curation_inspections (operation_id TEXT PRIMARY KEY REFERENCES command_receipts(operation_id) DEFERRABLE INITIALLY DEFERRED, scope_json TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES memory_curation_runs(id), completed INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=9;`);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('Memory curation migration integrity failure.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
