import { spawnSync } from 'node:child_process'
import { resolve, dirname, isAbsolute } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { isOutsideCheckout } from './protected-path-identity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = process.argv.slice(2)
let configPath
let reportPath
let invalidArguments = false
for (let index = 0; index < options.length; index += 2) {
  const [name, value] = options.slice(index, index + 2)
  if (!value || value.startsWith('--')) { invalidArguments = true; break }
  if (name === '--config' && !configPath) configPath = resolve(value)
  else if (name === '--report' && !reportPath) reportPath = resolve(value)
  else { invalidArguments = true; break }
}

try {
  if (invalidArguments || (configPath && configPath === reportPath)) throw new Error('invalid_arguments')
  const { readBoundedFile, loadVerifiedBuildIdentity } = await import('../services/analysis-service/dist/release/buildIdentity.js')
  const { prepareAnalysisProvider } = await import('../services/analysis-service/dist/operations/providerPreparation.js')
  let environment = process.env
  if (configPath) {
    const input = JSON.parse(await readBoundedFile(configPath, 65_536))
    if (!input || input.version !== 1 || typeof input.environment !== 'object' || input.environment === null
      || Array.isArray(input.environment) || Object.keys(input).some((name) => !['version', 'environment'].includes(name))
      || Object.entries(input.environment).some(([name, value]) => !/^(?:NODE_ENV|ANALYSIS_[A-Z0-9_]{1,100})$/u.test(name)
        || typeof value !== 'string' || value.length > 8192)) throw new Error('invalid_configuration_file')
    // A protected file is authoritative; never merge inherited Provider/release settings.
    environment = Object.fromEntries(Object.entries(input.environment))
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1_000_000 })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 })
  const checkout = status.status !== 0 ? 'unavailable' : status.stdout.trim() ? 'dirty' : 'clean'
  let build
  try {
    const { loadAnalysisServiceConfig } = await import('../services/analysis-service/dist/config.js')
    const identity = await loadVerifiedBuildIdentity(root)
    if (head.status !== 0 || identity.commit !== head.stdout.trim()
      || identity.serviceVersion !== loadAnalysisServiceConfig(environment).serviceVersion) throw new Error('current_build_mismatch')
    build = identity
  } catch { /* A changed, stale or missing build stays unverified. */ }
  let ciPrerequisites = 'missing'
  if (environment.ANALYSIS_CI_PREREQUISITES_PATH && environment.ANALYSIS_RELEASE_PUBLIC_KEY_PATH) {
    ciPrerequisites = 'invalid'
    try {
      if (build) {
        const { verifyCiPrerequisites } = await import('../services/analysis-service/dist/release/ciPrerequisites.js')
        const result = verifyCiPrerequisites({
          value: JSON.parse(await readBoundedFile(environment.ANALYSIS_CI_PREREQUISITES_PATH, 16_384)),
          publicKey: await readBoundedFile(environment.ANALYSIS_RELEASE_PUBLIC_KEY_PATH, 8192), build, now: Date.now(),
        })
        if (result.ready) ciPrerequisites = 'verified'
      }
    } catch { /* Do not leak file paths, keys or parser errors. */ }
  }
  let signingMaterial = 'missing'
  if (environment.ANALYSIS_RELEASE_SIGNING_KEY_PATH && environment.ANALYSIS_RELEASE_PUBLIC_KEY_PATH) {
    signingMaterial = 'invalid'
    try {
      for (const name of ['ANALYSIS_RELEASE_SIGNING_KEY_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH',
        'ANALYSIS_RELEASE_ATTESTATION_PATH', 'ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH']) {
        const path = environment[name]
        if (!path || !isAbsolute(path)) throw new Error('protected_path_invalid')
        if (!isOutsideCheckout(root, path)) throw new Error('protected_path_inside_checkout')
      }
      const privateKey = createPrivateKey(await readBoundedFile(environment.ANALYSIS_RELEASE_SIGNING_KEY_PATH, 8192))
      const publicKey = createPublicKey(await readBoundedFile(environment.ANALYSIS_RELEASE_PUBLIC_KEY_PATH, 4096))
      if (privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
        && createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) signingMaterial = 'verified'
    } catch { /* Never expose key bytes or credential-bearing parser errors. */ }
  }
  const report = prepareAnalysisProvider(environment, { checkout, build: build ? 'verified' : 'unverified', ciPrerequisites, signingMaterial })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  // Exclusive creation prevents accidentally overwriting protected configuration or proof files.
  if (reportPath) await writeFile(reportPath, serialized, { flag: 'wx', mode: 0o600 })
  process.stdout.write(serialized)
  if (report.status === 'blocked') process.exitCode = 2
} catch {
  console.error('Offline Provider preparation failed safely. Verify arguments/configuration and the existing service build; no network, database or Provider request was made.')
  process.exitCode = 2
}
