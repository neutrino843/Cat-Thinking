# @cat-thinking/analysis-contracts

Private workspace package containing the only supported runtime schemas and TypeScript types for Cat-Thinking analysis requests, runs, events, sources, evidence, errors, and five artifact kinds.

The package intentionally has no model-provider SDK, storage adapter, UI dependency, or service configuration. Zod is pinned exactly because these decoders form a security and persistence boundary.

Fixtures under `fixtures/` include accepted and deliberately rejected payloads. Project-generated semantic evaluation material lives under `evals/analysis/` so contract fixtures and quality fixtures remain separate concerns.
