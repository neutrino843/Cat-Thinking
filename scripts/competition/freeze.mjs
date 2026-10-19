import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const destination = path.resolve(root, process.argv[2] || 'reports/competition-2026-10-19/baseline.json')
if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('快照仅写入当前项目。')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'packages/analysis-contracts/src', 'services/analysis-service/src', 'tokens.css', 'package.json', 'package-lock.json', 'vite.config.ts'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const hashes = {}
for (const name of [...new Set(files)].sort()) {
  try { hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex') }
  catch (error) { if (error.code !== 'ENOENT') throw error; hashes[name] = null }
}
const snapshot = { capturedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), scope: 'product source and dependency manifests; excludes personal data, secrets and generated build files', productSourceHashes: hashes }
await fs.mkdir(path.dirname(destination), { recursive: true })
await fs.writeFile(destination, JSON.stringify(snapshot, null, 2))
console.log(JSON.stringify({ snapshot: path.relative(root, destination), files: Object.keys(hashes).length, commit: snapshot.commit }))
