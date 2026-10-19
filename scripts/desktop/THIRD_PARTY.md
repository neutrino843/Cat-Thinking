# Runtime notices

V3 packages must additionally include the complete verified standalone Ollama Windows distribution (CLI and applicable GPU libraries), its `LICENSE`, and all third-party notices supplied in that distribution under `runtime/ollama`. Pass an explicitly prepared `--ollama-root` directory to the package builder. The builder records the engine version and hashes every payload file; that checks payload integrity, not original vendor provenance or publisher signing. Model weights are downloaded separately by the user, retain their model-specific license requirements, and are not included in course backups. No Ollama binary or model weight was added to this source repository by this change.

Node.js 24.13.1 license and bundled-library notices: `licenses/NODE-LICENSE.txt`, obtained from the Node.js project tag at https://raw.githubusercontent.com/nodejs/node/v24.13.1/LICENSE.

PostgreSQL 18 copyright and distribution permission: `licenses/POSTGRESQL-COPYRIGHT.txt`, from https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/COPYRIGHT. Native binary provenance is the existing verified EDB Windows PostgreSQL 18.6 bundle, archive SHA-256 `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2`.

Runtime npm dependencies retain their own package metadata and license/notice files. The builder excludes development tools and tests. The prototype currently has no publisher signature; runtime hash/provenance and clean Windows prerequisites need release verification before broad distribution.
