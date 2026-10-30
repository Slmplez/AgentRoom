import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openStorage(directory, busyTimeoutMs) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('Persistent backend requires Node.js 24.4.1 or newer with node:sqlite.'); }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && (minor < 4 || (minor === 4 && patch < 1)))) throw new Error('Persistent backend requires Node.js >= 24.4.1.');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'application.sqlite'));
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    if (version > 2) throw new Error('Database schema is newer than this backend; upgrade the backend.');
    if ((version !== 0 || applicationId !== 0) && applicationId !== 1095911217) throw new Error('Not an AgentRoom persistence database.');
    if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw new Error('Refusing to initialize an existing unrecognized database.');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Database integrity check failed.');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (version === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE database_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, global_event_position INTEGER NOT NULL DEFAULT 0, pruned_through INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='human'), display_name TEXT NOT NULL);
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, title TEXT NOT NULL);
          CREATE TABLE rooms (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, last_message_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_message_sequence>=0), revision INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE room_members (room_id TEXT NOT NULL REFERENCES rooms(id), principal_id TEXT NOT NULL REFERENCES principals(id), role TEXT NOT NULL, PRIMARY KEY(room_id,principal_id));
          CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), sequence INTEGER NOT NULL CHECK(sequence>0), author_id TEXT NOT NULL REFERENCES principals(id), author_kind TEXT NOT NULL CHECK(author_kind='human'), author_name_snapshot TEXT NOT NULL, text TEXT NOT NULL, reply_to_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(room_id,sequence), UNIQUE(room_id,id), FOREIGN KEY(room_id,reply_to_id) REFERENCES messages(room_id,id));
          CREATE TABLE command_receipts (operation_id TEXT PRIMARY KEY, caller_id TEXT NOT NULL REFERENCES principals(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), command_type TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_schema_version INTEGER NOT NULL, receipt_json TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id), message_id TEXT REFERENCES messages(id), created_at TEXT NOT NULL, UNIQUE(caller_id,workspace_id,command_type,idempotency_key));
          CREATE TABLE events (position INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, type TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), room_id TEXT NOT NULL REFERENCES rooms(id), entity_id TEXT NOT NULL, entity_revision INTEGER NOT NULL, operation_id TEXT NOT NULL REFERENCES command_receipts(operation_id) DEFERRABLE INITIALLY DEFERRED, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL);
          CREATE INDEX events_room_position ON events(room_id,position);
          PRAGMA application_id=1095911217;
          PRAGMA user_version=1;
        `);
        const ownerId = randomUUID(), workspaceId = randomUUID();
        db.prepare('INSERT INTO principals VALUES (?, ?, ?)').run(ownerId, 'human', '本机用户');
        db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(workspaceId, '持久讨论');
        db.prepare('INSERT INTO database_meta(singleton,database_id,owner_id,workspace_id) VALUES(1,?,?,?)').run(randomUUID(), ownerId, workspaceId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    if (version < 2) {
      db.exec('BEGIN IMMEDIATE');
      try { db.exec('CREATE TABLE local_tasks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), state_json TEXT NOT NULL); PRAGMA user_version=2;'); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const meta = db.prepare('SELECT * FROM database_meta WHERE singleton=1').get();
    if (!meta || !db.prepare('SELECT id FROM principals WHERE id=?').get(meta.owner_id) || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(meta.workspace_id)) throw new Error('Incomplete persistence database.');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Database foreign key check failed.');
    return db;
  } catch (error) { db.close(); throw error; }
}
