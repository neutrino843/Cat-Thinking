import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = []
function collect(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(item.name)) continue
    const path = resolve(dir, item.name)
    if (item.isDirectory()) collect(path)
    else if (/\.(?:ts|tsx|js|css|json|mjs)$/.test(item.name)) files.push(path)
  }
}
for (const path of ['src', 'packages/analysis-contracts/src', 'services/analysis-service/src', 'e2e', 'scripts']) collect(resolve(root, path))
for (const item of readdirSync(root, { withFileTypes: true })) if (item.isFile() && /\.(?:ts|js|mjs|json|html|css)$/.test(item.name)) files.push(resolve(root, item.name))
const hash = createHash('sha256'); for (const path of files.sort()) { hash.update(relative(root, path).replaceAll('\\', '/')); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0') }
console.log(JSON.stringify({ files: files.length, sha256: hash.digest('hex') }))
