// Called only by openStorage, before the ApplicationRuntime accepts commands.
export function migrateAgentMemory(db) {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE command_receipts_v4 (operation_id TEXT PRIMARY KEY, caller_id TEXT NOT NULL REFERENCES principals(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), command_type TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_schema_version INTEGER NOT NULL, receipt_json TEXT NOT NULL, room_id TEXT REFERENCES rooms(id), message_id TEXT REFERENCES messages(id), created_at TEXT NOT NULL, UNIQUE(caller_id,workspace_id,command_type,idempotency_key), CHECK(room_id IS NOT NULL OR command_type IN ('editAgentSoul','saveExplicitMemory','correctExplicitMemory','forgetExplicitMemory')));
      INSERT INTO command_receipts_v4 SELECT * FROM command_receipts;
      CREATE TABLE events_v4 (position INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, type TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), room_id TEXT REFERENCES rooms(id), entity_id TEXT NOT NULL, entity_revision INTEGER NOT NULL, operation_id TEXT NOT NULL REFERENCES command_receipts(operation_id) DEFERRABLE INITIALLY DEFERRED, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, CHECK(room_id IS NOT NULL OR type IN ('soul.updated','memory.updated')));
      INSERT INTO events_v4 SELECT * FROM events;
      DROP TABLE events; DROP TABLE command_receipts;
      ALTER TABLE command_receipts_v4 RENAME TO command_receipts;
      ALTER TABLE events_v4 RENAME TO events;
      CREATE INDEX events_room_position ON events(room_id,position);
      CREATE TABLE agent_souls (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), content_json TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES principals(id), updated_at TEXT NOT NULL);
      CREATE TABLE soul_revisions (agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), content_json TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL, PRIMARY KEY(agent_id,revision));
      CREATE TABLE memory_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('owner-note','message')), text TEXT NOT NULL, content_hash TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES principals(id), occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, room_id TEXT REFERENCES rooms(id), message_id TEXT REFERENCES messages(id), message_revision INTEGER, recorded_by TEXT NOT NULL REFERENCES principals(id), UNIQUE(message_id,message_revision));
      CREATE TABLE explicit_memories (id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL CHECK(scope_kind IN ('agent','room')), scope_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('active','deleted')));
      CREATE INDEX memories_scope_status ON explicit_memories(scope_kind,scope_id,status,id);
      CREATE TABLE memory_revisions (memory_id TEXT NOT NULL REFERENCES explicit_memories(id), revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('active','deleted')), text TEXT NOT NULL, source_ids_json TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision));
      CREATE TABLE memory_source_links (scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES memory_sources(id), memory_id TEXT NOT NULL REFERENCES explicit_memories(id), PRIMARY KEY(scope_kind,scope_id,source_id));
      CREATE TABLE memory_source_tombstones (scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES memory_sources(id), memory_id TEXT NOT NULL REFERENCES explicit_memories(id), deleted_revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope_kind,scope_id,source_id));
      PRAGMA user_version=4;
    `);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Agent memory migration integrity failure.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
