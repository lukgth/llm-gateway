# WebSocket API reference

This document is the protocol reference for the admin UI's WebSocket
connection — connection/auth, the topic-based subscribe/push cycle behind
"Live gateway telemetry," the one-shot request/response pattern, and batch
key testing. It complements the REST docs rather than repeating them:

- [`docs/key-management.md`](./key-management.md) — the REST key CRUD/batch
  endpoints this doc's batch-test message pair sits alongside.
- [`docs/wire-types.md`](./wire-types.md) — request/response body shapes for
  the gateway's own `/v1/*` proxy endpoints (unrelated to this admin channel).

**Quick links:** [where the types live](#where-the-types-live) ·
[connection and auth](#connection-and-auth) ·
[topics: subscribe / push / invalidate](#topics-subscribe--push--invalidate) ·
[one-shot request/response](#one-shot-requestresponse) ·
[heartbeat](#heartbeat) ·
[batch key testing](#batch-key-testing)

---

## Where the types live

```
src/ws/
  schema.ts   — the single source of truth for every message shape (server side)
  server.ts   — upgrade handling, auth, per-connection message dispatch
  hub.ts      — WsHub: client/subscription state, push timers, mutation
                broadcasts, request/response, batch-test orchestration
  topics.ts   — fetchTopic(db, topic, params) — same repo functions the REST
                routes use, so a topic's pushed data always matches what the
                equivalent GET would return
  batch-test.ts — runBatchTest(): validation + concurrency-limited execution
                  behind the "batch-test" message (see below)
web/src/
  lib/ws-types.ts   — hand-maintained frontend mirror of src/ws/schema.ts
  hooks/use-ws.tsx  — WsProvider context + useWsSubscription/useWsStatus/
                      useWsRequest/useWsBatchTest hooks
```

`src/ws/schema.ts` and `web/src/lib/ws-types.ts` must be kept in sync by
hand — there's no code generation step. If you add a message type, add it to
both files.

---

## Connection and auth

```
GET /ws?token=<admin-token>
```

(or `Authorization: Bearer <token>` on the upgrade request — the query
param is what the browser client actually uses, since `WebSocket` can't set
custom headers). Same HMAC-signed admin token as the REST API
(`verifyToken`, `src/auth/admin-auth.ts`). An invalid/missing token gets a
`401` on the upgrade and the socket is destroyed before it ever becomes a
WS connection.

The frontend client (`web/src/hooks/use-ws.tsx`'s `WsProvider`) reconnects
automatically on close with exponential backoff (1s → 30s cap), and
re-subscribes to every topic that still has an active listener once the new
connection opens. Every 30s the server sends `{"type":"ping"}`; the client
must reply `{"type":"pong"}` or the connection is terminated as dead (see
[Heartbeat](#heartbeat)).

---

## Topics: subscribe / push / invalidate

The dashboard's "Live gateway telemetry" feed and friends are built on a
small closed set of topics:

```ts
type WsTopic =
  | "overview" | "usage" | "usage:breakdown" | "request-logs"
  | "providers" | "models" | "keys" | "users" | "settings";
```

**Subscribe** (client → server):

```json
{ "type": "subscribe", "topic": "overview", "params": { "days": 7 } }
```

The server immediately pushes the current data for that topic, then again
whenever it changes:

```json
{ "type": "push", "topic": "overview", "data": { /* same shape as the REST endpoint */ } }
```

Some topics also auto-refresh on a timer regardless of mutations
(`PUSH_INTERVALS` in `src/ws/schema.ts`): `overview` every 15s,
`request-logs` every 10s, `usage`/`usage:breakdown` every 20s. Topics not
listed there only push when a mutating REST route calls `broadcast()`.

**Unsubscribe:**

```json
{ "type": "unsubscribe", "topic": "overview" }
```

**Invalidate** — sent to every client subscribed to an affected topic right
before its refreshed `push`, so the UI can show a brief "updating…" cue
before new data lands:

```json
{ "type": "invalidate", "topics": ["providers"], "source": "provider:update" }
```

---

## One-shot request/response

For a single ad-hoc read that doesn't need a standing subscription:

```json
{ "type": "request", "id": "<uuid>", "endpoint": "overview", "params": {} }
```

```json
{ "type": "response", "id": "<uuid>", "data": { /* ... */ } }
```

or, on failure:

```json
{ "type": "response", "id": "<uuid>", "error": { "message": "unknown endpoint: foo" } }
```

`endpoint` must be one of the `WsTopic` values — `handleRequest` reuses the
same `fetchTopic()` the push cycle uses. The frontend's `useWsRequest()`
hook wraps this in a promise with a 10s client-side timeout.

---

## Heartbeat

Every 30s the server pings all connected clients and expects a `pong`
within the next 30s cycle; a client that misses one heartbeat is terminated
and removed. This reaps dead connections (network drop without a clean
close) without relying on TCP-level timeouts alone.

---

## Batch key testing

Tests many provider keys' connectivity in one job, streamed back over the
existing connection instead of one `POST /providers/:id/test` per key. This
is the mechanism behind the Keys tab's "Test active" button
(`ProviderKeyManager`) when the socket is connected — it falls back to
individual REST calls only if the WebSocket isn't up yet.

Unlike topics/requests, this is a **parallel message family**, not a
subscribe/push cycle or a single request/response — the server streams one
progress event per completed key (in whatever order they finish) followed
by a single terminal `done`.

**Request** (client → server):

```json
{
  "type": "batch-test",
  "id": "<uuid>",
  "providerId": "openai-prod",
  "keyIds": ["a1b2c3d4", "e5f6a7b8", "c9d0e1f2"]
}
```

- `id` is caller-chosen and scopes every progress/done/error event that
  follows to this one run — use a fresh id per batch (concurrent or
  repeated batches on the same connection are fine as long as ids don't
  collide; a duplicate id while one is already running under it is rejected
  with `batch-test-error`).
- `keyIds` are `ProviderKey.id` values (stable per-key ids — see
  [`docs/key-management.md`](./key-management.md#provider-key-schema)), not
  raw credentials, and must all belong to `providerId`.
- Max **200** keys per batch, run at concurrency **5** in-flight tests —
  both server-enforced constants (`MAX_BATCH_KEYS` / `BATCH_CONCURRENCY` in
  `src/ws/batch-test.ts`) to bound how much upstream traffic and outbound
  connection use a single batch can generate, independent of whatever the
  client requests.

**Progress** (server → client, one per completed key, as results land):

```json
{
  "type": "batch-test-progress",
  "id": "<uuid>",
  "index": 1,
  "keyId": "e5f6a7b8",
  "result": { "ok": true, "status": 200, "ms": 143, "keyMask": "sk-ab…wxyz" }
}
```

`index` is the key's position in the request's `keyIds` array — stable
regardless of completion order, so a client can always place a result back
into its original request without waiting for the whole batch (the "returned
with an index" contract). `keyId` is included alongside it as a more direct
join key. `result` is the same `ProviderTestResult` shape
`POST /providers/:id/test` returns.

**Done** (server → client, exactly once, after every key has settled):

```json
{ "type": "batch-test-done", "id": "<uuid>", "total": 3, "ok": 2 }
```

**Error** (server → client, only for a *fatal setup* failure — unknown
provider, a `keyId` that doesn't resolve or belongs to a different provider,
an empty or oversized `keyIds`, or a duplicate `id` already running; NOT
sent when an individual key's test simply fails, which is a normal
`batch-test-progress` with `result.ok === false`):

```json
{ "type": "batch-test-error", "id": "<uuid>", "message": "key not found on this provider: xyz" }
```

If the connection drops mid-batch, the server-side job's `isCancelled()`
check stops it from dispatching further tests (already in-flight requests
are allowed to finish and their results discarded, rather than aborted mid-
flight) — no orphaned worker pool keeps running for a client that's gone.

### Frontend usage

```ts
const { startBatchTest, status } = useWsBatchTest();

const { total, ok } = await startBatchTest(
  providerId,
  keyIds, // string[] of ProviderKey.id
  ({ index, keyId, result }) => {
    // update per-row UI state as each result streams in
  },
);
```

`startBatchTest` resolves with the same `{ total, ok }` shape as the `done`
message, or rejects on a `batch-test-error` / socket close.
