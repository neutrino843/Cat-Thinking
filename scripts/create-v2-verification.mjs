import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fingerprint = () => {
  const result = spawnSync(process.execPath, ['scripts/v2-source-fingerprint.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error('source fingerprint failed')
  return JSON.parse(result.stdout)
}
const before = fingerprint()
const target = resolve(root, '../tmp', `v2-verification-${randomUUID()}`)
mkdirSync(target, { recursive: true }); mkdirSync(resolve(target, '../reports'), { recursive: true }); mkdirSync(resolve(target, '../output/desktop/verification'), { recursive: true })
const filter = (path) => !['node_modules', 'dist', '.git', 'coverage', 'test-results', '.codex', '.agents'].includes(basename(path)) && !basename(path).startsWith('.env')
for (const name of ['src', 'packages', 'services', 'e2e', 'evals', 'scripts', 'public', 'docs']) if (existsSync(resolve(root, name))) cpSync(resolve(root, name), resolve(target, name), { recursive: true, filter })
for (const item of readdirSync(root, { withFileTypes: true })) if (item.isFile() && /\.(?:ts|js|mjs|cjs|json|html|css|md)$/.test(item.name)) cpSync(resolve(root, item.name), resolve(target, item.name))
const after = fingerprint()
if (before.sha256 !== after.sha256) throw new Error('source changed during snapshot; snapshot retained but not valid for verification')
symlinkSync(resolve(root, 'node_modules'), resolve(target, 'node_modules'), 'junction')
for (const workspace of ['services/analysis-service', 'packages/analysis-contracts']) if (existsSync(resolve(root, workspace, 'node_modules'))) symlinkSync(resolve(root, workspace, 'node_modules'), resolve(target, workspace, 'node_modules'), 'junction')
const vitePath = resolve(target, 'vite.config.ts')
const allowedPaths = JSON.stringify([target, resolve(root, 'node_modules')])
const vite = readFileSync(vitePath, 'utf8').replace("import { basename }", "import { basename, resolve }").replace('export default defineConfig({', "export default defineConfig({\n  resolve: { alias: { '@cat-thinking/analysis-contracts': resolve(process.cwd(), 'packages/analysis-contracts/src/index.ts') } },").replace('server: { port:', `server: { fs: { allow: ${allowedPaths} }, port:`)
writeFileSync(vitePath, vite)
const vitestPath = resolve(target, 'vitest.config.ts')
writeFileSync(vitestPath, "import { resolve } from 'node:path'\n" + readFileSync(vitestPath, 'utf8').replace('export default defineConfig({', `export default defineConfig({\n  server: { fs: { allow: ${allowedPaths} } },\n  resolve: { alias: { '@cat-thinking/analysis-contracts': resolve(process.cwd(), 'packages/analysis-contracts/src/index.ts') } },`))
const playwrightPath = resolve(target, 'playwright.config.ts')
writeFileSync(playwrightPath, readFileSync(playwrightPath, 'utf8').replaceAll('5174', '5214').replace("'**/personal/**'", "'**/personal/**', '**/document-import.spec.ts', '**/perf-large-doc.spec.ts'"))
writeFileSync(resolve(target, 'verification-snapshot.json'), JSON.stringify({ source: before, port: 5214, contractResolution: 'snapshot-source', dependencyMode: 'shared-unchanged-node-modules', copiedAt: new Date().toISOString() }, null, 2))
console.log(JSON.stringify({ target, source: before, port: 5214 }))
