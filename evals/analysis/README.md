# Analysis golden fixtures

This directory contains project-generated, redistributable evaluation material for the Cat Analysis Engine.

Each fixture must include an immutable source, explicit expectations, a SHA-256 manifest, and a license marker. Golden expectations describe required coverage and forbidden claims; they are not model output snapshots. Real-provider evaluations must record provider, model, prompt/schema versions, latency, token usage, cost, and the fixture commit.

Do not add user documents, secrets, provider responses, or copyrighted third-party samples here.

## Bounded real learning quality regression

`npm run quality:plan` reads the current local saved connection and prints the fixed public sample hashes, model and budget; it makes no provider calls. `npm run quality:live` explicitly runs the real saved provider against the original public biology and search-algorithm samples in `qualityCorpus.ts`. There is no synthetic-provider fallback in these commands.

The batch cap is 16 transport calls and 100000 tokens, with at most 8 calls and 180 seconds per execution, and at most 4096 output tokens per call. Prices are unknown; this is a token budget, not a currency spending cap. Settled, fully known usage replaces its forecast in admission accounting; uncertain outcomes retain their reservations and stop continuation. Reports are saved outside this fixture directory under `../reports/quality-regression-<UUID>`.

After inspecting failures, `node scripts/continue-quality-regression.mjs <directory-basename> <public-sample-id>` attempts missing categories within the ORIGINAL batch cap. It reads the real ledger, refuses unknown outcomes and profile changes, saves an in-flight checkpoint before dispatch and never automatically retries after interruption. It preserves original results. `node scripts/diagnose-quality-regression.mjs <directory-basename>` is a read-only local ledger inspection, with no provider calls. `node scripts/render-quality-report.mjs <directory-basename>` refreshes the Markdown execution record without calling a model.

`node scripts/verify-public-quality-fix.mjs <directory-basename>` is an optional one-call, source-grounded revision proposal for the public biology sample after review. It consumes the SAME batch budget and records a real invocation; its proposal is separate from production artifacts and cannot establish a full-pipeline pass. It must be independently reviewed. None of these commands modifies the saved connection or user documents.

Evaluate exact quotation ranges, clause-level support, key omissions, hierarchy, every answer and scoring criterion, uncertainty, and separation of inference from source facts. `modelQualityApproved=false` stays false until user review; structural checks and synthetic unit tests cannot approve model semantics. Sample coverage across separate runs cannot be represented as a single successful five-artifact run.
