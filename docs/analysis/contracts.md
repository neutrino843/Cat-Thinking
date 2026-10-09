# Analysis contracts and client boundary

The analysis feature is split between Cat-Thinking and an independently deployable Cat Analysis Engine. This repository currently contains the shared v1 contracts and the browser-side protocol foundation; it does not contain a production model provider or a browser API key.

## Ownership

- Cat-Thinking owns source documents, user confirmation, the editable map, long-term run metadata, and validated artifacts.
- The Analysis Engine owns authoritative chunking, evidence, provider routing, retry, cost control, and durable execution.
- Complete evidence digests, prompts, provider responses, and provider credentials never enter browser persistence or project exports.

## Contract rules

- Import schemas and types from `@cat-thinking/analysis-contracts`; do not duplicate them in `src/types.ts`.
- Decode every network payload before using it. TypeScript types alone are not a trust boundary.
- Versioned objects are strict: unknown fields fail instead of being silently discarded.
- Character ranges use JavaScript UTF-16 offsets over normalized `SourceDocument.text`.
- Content and part hashes are lowercase SHA-256 over UTF-8 bytes.
- `requestKey` identifies stable user intent: document, ordered source identities/ranges, requested artifacts, options, and the negotiated engine capability version. Provider/model/prompt versions belong to the engine's separate execution/cache key.
- SSE events are ordered by a run-global `sequence`; `eventId` is used for reconnect and `runRevision` prevents stale workers from overwriting newer state.
- TTL expiration is an explicit terminal `run.expired` event; content deletion and the expiration revision are atomic in the durable store.
- A run can be partial. One failed artifact must not erase successful siblings.
- `acceptsRuns` is authoritative. A client must not create a run while it is false and should surface `degradedReasons` instead of treating a reachable service as an operational AI engine.

## Browser client rules

- `HttpAnalysisEngineClient` has a fixed same-origin `/api/analysis/v1` prefix. Do not add a request-level `baseUrl` or Authorization passthrough.
- JSON and individual SSE events have byte limits before contract decoding.
- `Last-Event-ID`, run IDs, source IDs, expected revisions, and request bodies are validated before transport.
- Connection loss is not a terminal run failure. Reconnect and reconcile the server snapshot before deciding that a run is interrupted.
- `MockAnalysisEngineClient` is for deterministic unit/E2E replay only and must never appear as a production AI capability.

## Service boundary

- The compiled contracts package is the runtime dependency for both browser and service artifacts; production Node processes do not execute workspace TypeScript source.
- Production service authentication is gateway-to-service. The trusted same-origin gateway injects `Authorization` and overwrites `X-Cat-Tenant-Id`; provider or service credentials are never shipped to the browser.
- CORS origins are exact HTTP(S) origins. Wildcards, paths, credentials, and request-provided upstream URLs are rejected.
- `/health` and `/ready` are unauthenticated probes. Analysis API routes use authentication, origin enforcement, body limits, rate limits, stable error envelopes, and metadata-only logs.
- AI-1 advertises `acceptsRuns: false` until AI-2 supplies durable job and event persistence. Reaching the capabilities endpoint alone is not proof that model execution is available.

## Quality commands

```text
npm run check:contracts
npm run coverage:check
npm run verify:fixtures
npm run lint:ci
npm run build
npm run typecheck:service
npm run test:service
npm run build:service
```

On Windows systems whose PowerShell execution policy blocks `npm.ps1`, use `npm.cmd` for the same commands. Playwright must be allowed to spawn Chromium; a sandbox `spawn EPERM` is an environment failure, not a product assertion failure.

The LibreOffice DOCX render check is intentionally isolated in the Ubuntu CI job because local Word/LibreOffice availability is not a reproducible project dependency.

## Change protocol

1. Add or change schemas and positive/negative fixtures together.
2. Keep v1 decoders compatible; breaking changes require a new contract version and capability negotiation.
3. Update the golden evaluation manifest when source bytes change.
4. Add reducer and transport replay tests before consuming a new event in UI code.
5. Run the complete quality gates and both dependency audits before merging.
