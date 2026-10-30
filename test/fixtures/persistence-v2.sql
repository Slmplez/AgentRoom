-- Frozen v2 schema from commit 40999b8 for migration compatibility.
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

CREATE TABLE local_tasks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), state_json TEXT NOT NULL);
PRAGMA user_version=2;

