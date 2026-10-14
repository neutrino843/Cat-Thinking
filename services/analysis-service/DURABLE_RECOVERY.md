# Durable recovery and invocation facts

The authenticated v1 API exposes three additive, strict response contracts. They contain bounded metadata and confirmed token totals, never source parts, prompts, model responses, bearer tokens or Provider credentials.

| Route | Admission required | Semantics |
| --- | --- | --- |
| `GET /runs/by-request-key?requestKey=<sha256>` | No | Tenant-scoped `found` with the strict public run, `absent`, or `abandoned` with an optional run ID. This never creates or starts a run. |
| `POST /runs/abandon` | No | Version and immutable request key only. Establishes a durable barrier before clearing run content. A late create for that key is rejected. |
| `GET /runs/:runId/usage` | No | Versioned confirmed usage, reserved estimates, invocation count, unresolved count, and completeness. Unknown actual cost remains omitted. |

Create, start and explicit Artifact retry share the server admission policy. Hold does not prevent reading existing metadata or abandoning an intent. The local browser gateway allows only the lookup's single schema-valid query parameter and constructs its own trusted tenant/authentication headers.

## Transactions and lock order

PostgreSQL create/abandon acquires the advisory lock for `(tenant, requestKey)` before a run row. Provider reservation acquires its invocation advisory lock before a run row. Retry locks only the run row and reads snapshots/ledger there; it never acquires an invocation advisory/row lock after that row. Content checkpoint and deletion also lock the run row. Factual invocation completion only updates its invocation row and never creates content.

The retry guard validates revision, content deletion, expiry, complete source snapshots, Evidence graph identity, current Outline identity for MindMap, the failed/recoverable state, same-node unknown/running invocations, and remaining conservative budget. Admission is checked before entering the store transaction so callbacks cannot reenter a one-connection pool. Provider execution rechecks its release boundary immediately before transport; a gate closing after admission cannot authorize a new paid call.

Memory operations contain no await between their authoritative snapshot check and mutation. They implement the same semantic guards without pretending to survive a process restart. PostgreSQL row/advisory locks and transactions provide the durable implementation.

## Intent and billing retention

Schema 5 adds `analysis_abandoned_requests`, keyed by tenant/request key with optional run ID and timestamp only. Tombstones have no ordinary TTL. The request key has no authenticated validity epoch, so removing the barrier would allow a delayed create to revive an abandoned intent. Any future reclamation requires an explicit key-expiry protocol first. Database backups include this barrier.

Abandonment removes source parts, Evidence, cached cards no longer shared by another run, and Artifacts in one transaction. Active scheduling is cancelled; historical terminal status stays intact. Run metadata and the invocation ledger remain for reconciliation. Source, Artifact and lease checkpoints require live content and unexpired leases. Late valid usage can update a running/unknown invocation after deletion without restoring content.

Unknown actual usage is absent, rather than represented as a zero-cost result. Ledger aggregation returns the sum of known facts plus a distinct unresolved count and reserved bounds. PostgreSQL performs run existence and all invocation sums in one MVCC statement. A late known completion may resolve unknown; known terminal facts cannot be downgraded. Repeated unknown facts preserve known usage/transport metadata. The invocation ledger retains no raw Provider output, so an unknown/previously billed result does not get replayed to reconstruct missing content.

## Dependencies and connection readiness

Outline recovery updates a dependency-failed MindMap's retry eligibility in the same Artifact checkpoint. MindMap stays failed with its existing attempt. A separate explicit retry checks current source/graph/Outline and ledger facts before increasing the attempt. This never schedules an automatic paid dependent retry.

Pool idle-client errors have a listener registered before the first connection. Raw errors are not logged. Failed initialization closes the owned pool. A runtime pool error invalidates acquisition until a successful health query establishes recovery; renewals/watchdogs stop local work, and lease fencing governs later recovery. Execution readiness excludes dispatcher admission readiness, so the dispatcher can recover before enabling admission. Connection recovery does not clear release hold.

The PostgreSQL regression suite acquires the shared synthetic database mutex before destructive fixtures. Its fault injection terminates only same-user connections in the dedicated test database bearing a unique application name; it does not terminate the mutex connection or restart the business database. Memory and real PostgreSQL tests cover create/abandon orderings, reopening, retry rejection/CAS, dependency recovery and late usage. Production admission remains closed until the separate protected release procedure succeeds.
