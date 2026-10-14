import { execFileSync } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeArtifactDigest } from '../services/analysis-service/dist/release/buildIdentity.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let commit = process.env.ANALYSIS_BUILD_COMMIT
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* Unversioned builds remain closed. */ }
}
const path = resolve(root, 'services/analysis-service/dist/release-build.json')
if (!commit || !/^[a-f0-9]{40}$/u.test(commit)) {
  await rm(path, { force: true })
  console.log('Unversioned analysis build; release gate remains closed.')
} else {
  const { version } = JSON.parse(await readFile(resolve(root, 'services/analysis-service/package.json'), 'utf8'))
  await writeFile(path, JSON.stringify({ serviceVersion: version, commit, artifactDigest: await computeArtifactDigest(root) }) + '\n')
  console.log('Analysis build identity written.')
}
