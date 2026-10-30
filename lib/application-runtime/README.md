# G2a persistent discussion backend

This is the standalone #13–#15 discussion backend, with opt-in #26/#28 local
Agent question support. By default it does not replace the existing desktop
service or load hcom, an agent CLI, a model gateway, or the React client.
It supports authenticated HTTP/SSE and the public AgentRoomClient. Production discussion UI
integration was delivered in #16. History paging and event expiry are available through
the existing public client; no additional chat UI or store is introduced.

The explicit `--agent-workspace` trusted-host option enables one local owner,
one read-only Pi execution and native question answers through the same runtime.
The task UI uses the same Client/journal/SSE. See
[local Agent API and UI](../../docs/LOCAL-AGENT-QUESTIONS.md) for startup,
schema-2 migration, failure recovery, real CLI evidence and current limits.

Requires Node.js >= 24.4.1 with `node:sqlite` (experimental in the validated
24.4.1 runtime). Use a separate local data directory. Do not point this service
at an existing hcom database or a network share. One backend owns the directory.
No additional npm dependency is needed; the shared message DTO uses existing Zod.

## Launch from a trusted local host

```js
const { fork } = require('node:child_process');
const backend = fork('scripts/start-persistence-server.cjs', [
  '--data-dir', '/absolute/path/to/persistent-discussions',
], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
backend.on('message', async message => {
  if (message.type !== 'ready') return;
  // Keep token in host memory; never log it, put it in a URL or browser storage.
  const headers = { Authorization: `Bearer ${message.token}` };
  const bootstrap = await fetch(`${message.origin}/api/v1/bootstrap`, { headers }).then(r => r.json());
  // Pass authenticated requests through your restricted local host integration.
});
// backend.send({ type: 'shutdown' });
```

Direct CLI launch also works:
`node scripts/start-persistence-server.cjs --data-dir <directory> [--port 0]`.
Its trusted parent must send one JSON line containing a cryptographically random
32-byte hex `token` through stdin. The token must not be supplied on the command
line or printed. The process logs only the loopback URL. Closing a client does
not shut down the backend; the host owns its lifecycle. Host disconnect revokes
the service's in-memory token by shutting it down. Restart creates a new token;
the persisted owner and database identity remain unchanged.

## HTTP contract

All endpoints require an Authorization bearer token, exact loopback Host and,
when supplied, same-origin Origin. No CORS is enabled. Writes use JSON plus an
`Idempotency-Key` header. The server derives the author from the authenticated
local session; caller/author fields in the JSON body are rejected.

| Endpoint | Body or parameters |
| --- | --- |
| GET /api/v1/bootstrap | Database/process identities, local owner, workspace, capabilities |
| POST /api/v1/rooms | `{workspaceId, title}` |
| GET /api/v1/rooms | `workspaceId`; bounded to 200 rooms |
| POST /api/v1/rooms/:id/messages | `{workspaceId, text, replyToId?}`; empty `mentions` only |
| GET /api/v1/rooms/:id/messages | `limit` (1–200), `beforeSequence?`, `upperBound?` |
| GET /api/v1/rooms/:id/snapshot | Room and latest 100 messages with a cursor from the same read transaction |
| GET /api/v1/rooms/:id/events | Bounded committed-event query, `after?`, `limit?`; **not SSE** |
| GET /api/v1/events | SSE using authorization header, `roomId`, `after` cursor |
| GET /api/v1/operations/:id | Original accessible receipt |
| GET /api/v1/operations | `workspaceId`, `commandType`, original `key` |

The new schema is `contracts/persistence.mjs`; legacy chat schemas are not
changed. Repeated same-key/same-content commands return the original receipt.
Changed content under the same scoped key returns 409 `idempotency_conflict`.
Do not trim or normalize text before retrying. Receipts do not expire in G2a.
After lost responses, query the original key and retry it only against the same
database identity. A new key represents a new message even with identical text.

SQLite stores the room counter, message, committed event and receipt in one
transaction. A crash before commit rolls them all back; a crash after commit
leaves all queryable after restart. Queries authorize before reading each scope.
Unknown schemas, foreign databases and initialization failures fail explicitly;
there is no reset-to-empty recovery. Messages and receipts do not expire.

## History and event expiry (#15)

`await client.loadOlderMessages({ limit: 100 })` loads the next older page into
the existing projection and returns the number of messages read. The default is
100 and maximum is 200. A second concurrent load rejects with `busy`; legacy
transports without history return `unsupported`. `client.read()` exposes:

- `beforeSequence`: exclusive next-page boundary, or `null` when history is exhausted.
- `roomSequenceUpperBound`: snapshot's fixed history window; live events do not move it.
- `historyLoading`: whether the current scope has a history request in progress.
- `syncNotice`: a recovery notice after an expired/unavailable cursor required a new snapshot.

History pages merge by message identity into the same message list and never
advance the applied SSE cursor. Scope changes, reconnect and close invalidate
late pages. An empty new client always starts from the bounded latest snapshot;
older messages remain available through this API after event-log expiry.

Events are eligible for deletion strictly after seven days. The runtime checks
at startup and every minute. Only a contiguous expired prefix is deleted, in the
same write transaction that advances `pruned_through`; clock rollback cannot
cause an old-timestamp suffix to jump over a fresh prefix. This does not delete
messages or idempotency receipts, nor reset/reuse global event positions.

Resume below the floor returns `resync_required`; equality is valid. A replay
overtaken by pruning receives an explicit SSE error and closes, including when
part of a page was already delivered. The client clears its old resume cursor,
loads a fresh bounded snapshot, and subscribes from its matching cursor. It does
not change the room scope or own/clear UI drafts. #16 must keep using the same
room-keyed draft state when rendering the recovery notice and history button;
this backend slice does not claim a separate UI draft acceptance run.

Clock and maintenance scheduling injection are trusted runtime/test seams only;
HTTP cannot change retention, invoke deletion or set the clock. The test fixture
uses IPC to control time and kill a real process before prune commit. A failed
periodic cleanup rolls back and is retried; startup cleanup failure is explicit.

## Public client integration

```js
import { createAgentRoomClient } from '../../renderer/client/client.mjs';
import { createPersistentTransport } from '../../renderer/client/persistent.mjs';

const client = createAgentRoomClient(createPersistentTransport({
  // Trusted host supplies the current loopback origin/token, including after restart.
  session: () => host.getPersistenceSession(),
  backendId: host.stableBackendId,
  localUserId: host.localUserId,
  storage: localStorage,
}));
await client.open({ roomId });
await client.dispatch({
  type: 'send', key: crypto.randomUUID(), roomId, text: '你好',
  mode: 'discussion', ownerAgentId: null, mentions: [],
});
// client.read(), client.subscribe(listener), client.checkOperation(originalKey)
// client.close() aborts HTTP/SSE and scheduled reconnection, not the backend.
```

This example assumes the host selected/created a discussion room through the
authenticated HTTP API. It is not a second UI entry point. The adapter requires a
room scope. It negotiates schema v1 and `persistentMessages`, `idempotentSend`,
`eventStream` before syncing. The existing legacy and Mock transports retain their
snapshot protocol. The optional internal `synchronize(scope, emit, resume)` seam
delivers validated identities, snapshots, frames and connection state to the one
AgentRoomClient projection; the transport holds no message projection.

The client keeps an applied cursor only with its in-memory projection. A new
client always gets a snapshot; reconnect of the same client/database resumes its
cursor even when the process instance changes. Snapshot and applied cursor are
published together. Message identity/revision deduplicates replay; receipts never
advance the applied cursor or insert an optimistic second message. Scope changes
and close invalidate late callbacks using the existing client generation.

The persistent event log is also the outbox. `watch` registers a wakeup before
reading and uses the same query loop for backlog and live data, with a one-second
fallback scan. Filtered streams send checkpoint frames without exposing other
rooms. Fifteen-second SSE heartbeats keep idle connections active. Per-response
pending writes are capped at 1 MiB; excess disconnects the peer, which resumes
from the last applied cursor. The HTTP loop gives socket I/O time to drain during
large backlogs. Watchers and heartbeat timers are released on connection close.

Submitted-command journals require Storage-compatible durable storage
(`getItem`, `setItem`, `removeItem`, `key`, `length`). No volatile fallback is
provided. The host's stable backend/user identities must not be a port or bearer
token. Keys additionally include the database ID and authenticated principal;
individual command records avoid unrelated windows overwriting one shared list.
Only explicitly dispatched commands are saved, before the HTTP write. Records
contain the original command text for exact retry, but never the session token;
the public pending-operation state exposes identifiers/outcomes only. Apply the
same local data protections as other user chat content.

On reload/reconnect, existing records are queried, never posted. `not_found`
permits an explicit dispatch of the unchanged original command/key; a known
receipt clears the record. A changed database clears the old projection, sets
`databaseChanged`, and never loads or submits the previous database's journal.
Old records are retained under their original database key. This is not an
offline execution queue or multi-user login implementation.

## Validation

Run `node --test test/persistence-durable.test.cjs test/persistence-stream.test.cjs
test/persistence-history.test.cjs test/client.test.cjs test/client-sync.test.cjs`. Tests use real SQLite, HTTP/SSE,
two public clients, a disk-backed command journal, and child processes, including
forced termination before and after commit. Streaming tests cover snapshot and
backlog boundaries, missed wakeups, checkpoint filtering, duplicate events,
both receipt/event orders, database switching, cursor/auth rejection, stale
responses, a paused TCP reader and a healthy large-backlog reader.
The crash injector is only assembled by `test/fixtures/persistence-process.cjs`;
the production launcher never reads a crash setting from HTTP or environment.
