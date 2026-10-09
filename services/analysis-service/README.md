# Cat Analysis Service

Independent server-side execution boundary for Cat-Thinking analysis. AI-1 established the secure HTTP boundary. AI-2 adds tenant-scoped durable runs, encrypted source parts, revision compare-and-swap, persisted SSE replay, cancellation, worker leases, and TTL cleanup without calling a model provider.

Production startup requires `ANALYSIS_AUTH_MODE=service-token`, a token of at least 32 UTF-8 bytes, and at least one exact `ANALYSIS_CORS_ORIGINS` value. The service token is intended to be injected by a trusted same-origin gateway; the gateway must overwrite `Authorization` and `X-Cat-Tenant-Id` instead of forwarding browser-supplied values.

Run `npm run build:contracts`, `npm run build:service`, and `npm run test:service` from the repository root. PostgreSQL integration and adapter coverage run with `ANALYSIS_TEST_DATABASE_URL=... npm run coverage:postgres`. Provider credentials, database URLs, encryption keys, source text, prompts, responses, cookies, and authorization headers must never be logged.

Copy `.env.example` into deployment secret/configuration management; do not commit a real `.env`. `ANALYSIS_TRUST_PROXY_HOPS` must equal the number of trusted reverse-proxy hops and defaults to zero so arbitrary forwarded IP headers are not trusted. `/health` is process liveness. `/ready` also checks PostgreSQL when the durable store is enabled. Analysis API routes require authentication in production.

`ANALYSIS_JOB_STORE=disabled` preserves the AI-1 degraded mode. `ANALYSIS_JOB_STORE=postgres` requires a PostgreSQL URL and a canonical base64 32-byte AES key; production additionally requires database TLS. Migrations use a PostgreSQL advisory lock and refuse schemas newer than the service supports.

Capabilities deliberately keep `acceptsRuns: false` until a real Provider and orchestrator are configured in AI-3. With PostgreSQL ready, `supportsSse` and `supportsCancellation` become true and only `provider.not-configured` remains degraded. Existing persisted runs can be inspected/replayed while new production runs remain fail-closed.
