# Analysis service foundation

AI-1 added `services/analysis-service` as an independently compiled Node service. AI-2 builds durable jobs on that boundary while preserving its fail-closed defaults. See `docs/analysis/durable-jobs.md` for the current persistence and recovery design.

## Topology

```text
Browser -> trusted same-origin gateway -> Cat Analysis Service -> future approved providers
```

The browser only calls `/api/analysis/v1`. The gateway authenticates the user, removes any browser-supplied `Authorization` and `X-Cat-Tenant-Id`, injects its service Bearer token and authoritative tenant ID, then proxies to the service. The analysis service must not be publicly reachable around that gateway.

## AI-1 endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `GET /health` | none | process liveness |
| `GET /ready` | none | HTTP boundary readiness |
| `GET /api/analysis/v1/capabilities` | production service token | version and degraded capability negotiation |
| `POST /api/analysis/v1/runs` | production service token | remains 503 until the AI-3 provider/evidence path is ready |

With no JobStore, capabilities report `acceptsRuns: false`, `supportsSse: false`, and the reasons `provider.not-configured` and `job-store.not-configured`. With PostgreSQL ready, SSE/cancellation are true and only the provider reason remains. This is deliberate fail-closed behavior.

## Production configuration

Production startup fails unless all of these conditions hold:

- `ANALYSIS_AUTH_MODE=service-token`;
- `ANALYSIS_SERVICE_TOKEN` contains at least 32 UTF-8 bytes;
- `ANALYSIS_CORS_ORIGINS` contains at least one exact HTTP(S) origin;
- no origin contains a wildcard, credentials, path, query, or fragment.

Use `services/analysis-service/.env.example` as a field list, not as a secret file. Real values belong in deployment secret/configuration management. `.env` files are ignored by Git.

`ANALYSIS_TRUST_PROXY_HOPS` defaults to zero. Set it to the exact number of controlled proxy hops; an arbitrary forwarded IP header is not trusted by default. Rate limiting uses the patched IPv6-aware implementation and a `/64` default grouping.

## Logging and privacy

Default request logs contain only event name, trace ID, validated tenant ID, method, route template, status, and duration. They do not include raw URLs, query strings, headers, cookies, bodies, source text, prompts, model responses, or credentials. Pino redaction provides a second layer for authorization, cookie, token, and secret fields.

All client-visible failures use `AnalysisErrorResponseV1`. Raw framework errors and exception messages are not returned. Unknown failures get a trace ID and stable `internal_error` code.

## Build and test

```text
npm ci --ignore-scripts
npm run typecheck:service
npm run test:service
npm run build:service
npm run check:ci
```

The contracts workspace builds first and publishes JavaScript plus declarations into its ignored `dist` directory. This prevents production Node from relying on TypeScript stripping or source-workspace layout.

The Dockerfile uses an exact official Node 24.13.1 multi-platform digest, separate build and production-dependency stages, ignored build context, no lifecycle scripts, a non-root runtime user, no source maps, and an internal health check. CI builds and starts the image, probes health, authenticates capabilities, and checks that run acceptance remains disabled.

## AI-2/AI-3 handoff

AI-2 provides:

- a JobStore interface plus PostgreSQL durable implementation;
- request-key uniqueness and revision-checked state transitions;
- source receipt persistence and content TTL deletion;
- persisted SSE sequence/event IDs, reconnect replay and `run.expired`;
- cancellation, artifact retry and encrypted content cleanup state machines;
- lease expiry, process restart, stale worker, duplicate request, and late-result tests.

With the store ready, `supportsSse` and `supportsCancellation` may be true. `acceptsRuns` stays false until AI-3 supplies the controlled evidence/provider execution path; provider integration must not bypass the durable lifecycle.
