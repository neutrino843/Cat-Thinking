# Durable analysis runs and event recovery

AI-2 implements the persistence and recovery substrate for Cat-Thinking analysis. It does not generate model output. Production run acceptance remains disabled until the evidence/provider path exists.

## Persistence boundary

`RunService` owns lifecycle rules and depends only on the `JobStore` port. `InMemoryJobStore` is the deterministic reference used by unit and HTTP tests. `PostgresJobStore` is the durable implementation used by deployments and the dedicated database CI job.

The PostgreSQL schema stores:

- tenant-scoped run snapshots and unique request keys;
- encrypted source parts and completion receipts;
- run-global event sequences and event IDs;
- worker owner, attempt and lease expiry;
- content expiry and deletion markers.

Every database JSON value is decoded again through the shared v1 schemas when read. A database row is not trusted merely because the service wrote it earlier.

## Consistency rules

- `(tenantId, requestKey)` is unique. A repeated identical request reuses the run; a claimed key with different request data is a conflict.
- Run changes use expected revision compare-and-swap.
- A run state change and its event are committed in the same PostgreSQL transaction.
- Events have monotonically increasing run-global sequences. An unknown `Last-Event-ID` is a conflict rather than a silent replay from zero.
- Source parts are idempotent by run, source and part index. Changing an uploaded part is a conflict.
- The service recomputes both each part hash and the complete source UTF-8 SHA-256/byte count.
- Lease renew/release requires the current owner and attempt. An expired lease can be acquired with an incremented attempt, so a stale worker cannot act as the current owner.

## Source confidentiality and deletion

Source text is encrypted before it enters PostgreSQL with AES-256-GCM, a random 96-bit IV and authenticated context containing tenant, run, source and part identities. Production PostgreSQL mode requires `ANALYSIS_CONTENT_ENCRYPTION_KEY`, encoded as canonical base64 for exactly 32 bytes.

The active key never enters a response, database row or log. Rows carry only a non-secret key ID so a later production-hardening phase can add key rotation.

`DELETE /runs/:runId/content` deletes source rows without deleting run/event metadata. The periodic cleanup scans a bounded batch. For active expired runs, source deletion, the `expired` snapshot revision and `run.expired` event are one transaction. Terminal runs retain their terminal state while their source content is removed.

## SSE recovery

`GET /runs/:runId/events` first replays persisted events after the requested cursor, then waits for in-process notification with database polling as the cross-instance correctness fallback. Heartbeat comments prevent idle intermediary timeouts. Disconnecting removes the waiter and does not alter the run.

After a service restart, in-memory notifications are gone but PostgreSQL events remain. The client reconnects with `Last-Event-ID` and receives every later event in sequence. The authoritative run snapshot remains the final reconciliation source.

## Configuration

| Variable | Purpose |
|---|---|
| `ANALYSIS_JOB_STORE` | `disabled` or `postgres` |
| `ANALYSIS_DATABASE_URL` | PostgreSQL connection URL; treated as a secret |
| `ANALYSIS_DATABASE_SSL` | `require` in production PostgreSQL mode |
| `ANALYSIS_CONTENT_ENCRYPTION_KEY` | canonical base64 32-byte AES key |
| `ANALYSIS_DB_POOL_MAX` | bounded connection pool size |
| `ANALYSIS_DB_CONNECT_TIMEOUT_MS` | initial connection timeout |
| `ANALYSIS_SSE_HEARTBEAT_MS` | heartbeat interval |
| `ANALYSIS_SSE_POLL_MS` | cross-process database catch-up interval |
| `ANALYSIS_LEASE_MS` | default future worker lease duration |
| `ANALYSIS_CLEANUP_BATCH_SIZE` | maximum runs examined per cleanup pass |
| `ANALYSIS_CLEANUP_INTERVAL_MS` | cleanup scheduler interval |

Production startup fails if PostgreSQL mode lacks the URL/key or disables TLS. Startup acquires a PostgreSQL advisory lock, applies known forward migrations, and refuses a schema newer than the binary. `/ready` returns 503 if the configured store cannot answer a health query.

## Capability state

| Store | Provider | `acceptsRuns` | SSE/cancel | Degraded reasons |
|---|---|---:|---:|---|
| disabled | absent | false | false | provider + job store not configured |
| ready | absent | false | true | provider not configured |
| ready | future ready | true | true | none |

The second row is the AI-2 production state. The HTTP implementation is fully exercised with the reference store, while the production composition keeps run creation closed. AI-3 may open it only after an evidence pipeline and controlled provider are available.

## Quality gates

Core service code is covered by the normal 90% functions/lines and 85% branches gate. PostgreSQL code is not counted as zero on machines with no database; it has a separate real-PostgreSQL coverage gate at the same thresholds:

```text
npm run coverage
ANALYSIS_TEST_DATABASE_URL=postgresql://... npm run coverage:postgres
```

GitHub uses a digest-pinned official PostgreSQL 18.4 Bookworm image. Integration tests cover migration replay, encrypted storage, restart recovery, concurrent request-key creation, revision races, tenant isolation, event cursors, lease takeover, deletion and TTL expiration.

## AI-3 handoff

AI-3 should add planner/evidence workers through `JobStore` leases and revision checks. It must not bypass `RunService`, write unvalidated event JSON, log decrypted source text, or turn `acceptsRuns` on merely because a Provider SDK can answer one request.
