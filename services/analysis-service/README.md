# Cat Analysis Service

Independent server-side execution boundary for Cat-Thinking analysis. AI-1 intentionally exposes health, readiness, degraded capabilities, authentication, exact-origin CORS, request limits, rate limits, safe errors, and structured metadata-only logging without calling a model provider.

Production startup requires `ANALYSIS_AUTH_MODE=service-token`, a token of at least 32 UTF-8 bytes, and at least one exact `ANALYSIS_CORS_ORIGINS` value. The service token is intended to be injected by a trusted same-origin gateway; the gateway must overwrite `Authorization` and `X-Cat-Tenant-Id` instead of forwarding browser-supplied values.

Run `npm run build:contracts`, `npm run build:service`, and `npm run test:service` from the repository root. Provider credentials, source text, prompts, responses, cookies, and authorization headers must never be logged.

Copy `.env.example` into deployment secret/configuration management; do not commit a real `.env`. `ANALYSIS_TRUST_PROXY_HOPS` must equal the number of trusted reverse-proxy hops and defaults to zero so arbitrary forwarded IP headers are not trusted. `/health` and `/ready` are probe endpoints; analysis API routes require authentication in production. Capabilities deliberately return `acceptsRuns: false` until AI-2 provides a durable JobStore.
