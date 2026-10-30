# G2a persistent discussion backend

This is the standalone #13 backend. It does not replace the existing desktop
service or load hcom, an agent CLI, a model gateway, or the React client.
SSE and production UI integration remain #14 and #16 respectively.

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
| GET /api/v1/rooms/:id/events | Bounded committed-event query, `after?`, `limit?`; **not SSE** |
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
there is no reset-to-empty recovery. Event retention/cleanup is not enabled yet.

## Validation

Run `node --test test/persistence-durable.test.cjs`. Tests use real SQLite, HTTP
and child processes, including forced termination before and after commit.
The crash injector is only assembled by `test/fixtures/persistence-process.cjs`;
the production launcher never reads a crash setting from HTTP or environment.
