import { spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { writeProtectedJson } from './protected-file.mjs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOutsideCheckout, protectedPathIdentity } from './protected-path-identity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const blocked = []
const argumentsList = process.argv.slice(2)
if (argumentsList.some((argument) => argument !== '--preflight-only') || argumentsList.length > 1) blocked.push('unsupported command arguments')
const nonce = process.env.ANALYSIS_TARGET_VALIDATION_EXECUTION_ID
const optIn = 'I_ACKNOWLEDGE_BILLABLE_NONDESTRUCTIVE_TARGET_VALIDATION'
if (process.env.ANALYSIS_TARGET_VALIDATION !== optIn) blocked.push('explicit billable target validation opt-in')
if (!/^[a-f0-9]{32}$/u.test(nonce ?? '')) blocked.push('explicit reusable execution nonce')
const integer = (name, maximum) => {
  const text = process.env[name]
  const value = Number(text)
  if (!text || !/^[1-9][0-9]*$/u.test(text) || !Number.isSafeInteger(value) || value > maximum) blocked.push(name)
  return value
}
const budget = {
  maxEstimatedTokens: integer('ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_TOKENS', 200000),
  maxEstimatedCostMicros: integer('ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_COST_MICROS', 1000000),
  timeoutMs: 120000,
}
const paths = Object.fromEntries([
  'ANALYSIS_CI_PREREQUISITES_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH', 'ANALYSIS_RELEASE_SIGNING_KEY_PATH',
  'ANALYSIS_RELEASE_ATTESTATION_PATH', 'ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH',
].map((name) => {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) blocked.push(name)
  return [name, value ? resolve(value) : undefined]
}))
if (new Set(Object.values(paths).filter(Boolean).map((path) => protectedPathIdentity(path))).size !== 5) blocked.push('distinct protected evidence/key/output paths')
for (const name of ['ANALYSIS_RELEASE_SIGNING_KEY_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH',
  'ANALYSIS_RELEASE_ATTESTATION_PATH', 'ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH']) {
  const path = paths[name]
  if (path) {
    if (!isOutsideCheckout(root, path)) blocked.push('keys and output paths outside the checkout')
  }
}
const cleanCommit = () => {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (status.error || status.status !== 0 || status.stdout.trim() || head.error || head.status !== 0
    || !/^[a-f0-9]{40}$/u.test(head.stdout.trim())) throw new Error('clean_versioned_checkout_required')
  return head.stdout.trim()
}
let commit
try { commit = cleanCommit() } catch { blocked.push('clean versioned checkout') }
let modules
let config
let build
let ci
let privateKey
let publicKey
let configDigest
let checkpoint
try {
  modules = await Promise.all([
    import('../services/analysis-service/dist/config.js'),
    import('../services/analysis-service/dist/release/buildIdentity.js'),
    import('../services/analysis-service/dist/release/ciPrerequisites.js'),
    import('../services/analysis-service/dist/release/releaseAttestation.js'),
    import('../services/analysis-service/dist/release/targetValidation.js'),
    import('../services/analysis-service/dist/release/targetAttestation.js'),
  ])
  config = modules[0].loadAnalysisServiceConfig(process.env)
  modules[4].assertTargetValidationConfiguration(config, budget)
  build = await modules[1].loadVerifiedBuildIdentity(root)
  if (build.commit !== commit || build.serviceVersion !== config.serviceVersion) throw new Error('build_identity_mismatch')
  configDigest = modules[3].configurationHash(config)
} catch { blocked.push('verified current build and held exact PostgreSQL/Provider configuration with maxAttempts=1 and price bounds') }
if (modules && build) {
  try {
    const read = modules[1].readBoundedFile
    publicKey = await read(paths.ANALYSIS_RELEASE_PUBLIC_KEY_PATH, 4096)
    privateKey = createPrivateKey(await read(paths.ANALYSIS_RELEASE_SIGNING_KEY_PATH, 8192))
    const trusted = createPublicKey(publicKey)
    if (privateKey.asymmetricKeyType !== 'ed25519' || trusted.asymmetricKeyType !== 'ed25519'
      || modules[3].publicKeyId(createPublicKey(privateKey)) !== modules[3].publicKeyId(trusted)) throw new Error('invalid_trust_root')
    const decision = modules[2].verifyCiPrerequisites({ value: JSON.parse(await read(paths.ANALYSIS_CI_PREREQUISITES_PATH, 32768)),
      publicKey, build, now: Date.now() })
    if (!decision.ready) throw new Error('trusted_current_ci_required')
    ci = decision.body
    try {
      const text = await read(paths.ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH, 32768)
      checkpoint = modules[5].verifyTargetCheckpoint({ value: JSON.parse(text), publicKey, build,
        configurationHash: configDigest, executionId: nonce, now: Date.now() })
      if (!checkpoint) throw new Error('invalid_checkpoint')
    } catch (error) { if (error?.code !== 'ENOENT') throw new Error('checkpoint_verification_failed', { cause: error }) }
  } catch { blocked.push('matching protected Ed25519 trust root, fresh signed Ubuntu/security prerequisites and valid optional checkpoint') }
}
if (blocked.length) {
  console.error(`Target Provider validation blocked before network access: ${[...new Set(blocked)].join('; ')}`)
  process.exitCode = 2
} else if (argumentsList.includes('--preflight-only')) {
  console.log('Protected target configuration and evidence preflight passed. No database, Provider request or output write occurred.')
} else {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('target_validation_interrupted'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const [storeModule, cipherModule, providerModule, costModule] = await Promise.all([
      import('../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js'),
      import('../services/analysis-service/dist/infrastructure/contentCipher.js'),
      import('../services/analysis-service/dist/providers/configuredProvider.js'),
      import('../services/analysis-service/dist/providers/configuredCostEstimator.js'),
    ])
    const provider = providerModule.createConfiguredModelProvider(config.provider)
    const estimateCostMicros = costModule.configuredCostEstimator(config.provider)
    if (!provider?.isReady() || !estimateCostMicros) throw new Error('provider_not_ready')
    const canExecute = async () => {
      if (controller.signal.aborted || process.env.ANALYSIS_TARGET_VALIDATION !== optIn || cleanCommit() !== commit
        || ci.expiresAt <= Date.now() || modules[3].configurationHash(modules[0].loadAnalysisServiceConfig(process.env)) !== configDigest) return false
      const currentBuild = await modules[1].loadVerifiedBuildIdentity(root)
      if (JSON.stringify(currentBuild) !== JSON.stringify(build)) return false
      const decision = modules[2].verifyCiPrerequisites({ value: JSON.parse(await modules[1].readBoundedFile(paths.ANALYSIS_CI_PREREQUISITES_PATH, 32768)),
        publicKey: await modules[1].readBoundedFile(paths.ANALYSIS_RELEASE_PUBLIC_KEY_PATH, 4096), build, now: Date.now() })
      return decision.ready && JSON.stringify(decision.body) === JSON.stringify(ci)
    }
    const validation = await modules[4].validateTargetDeployment({ config, build, executionId: nonce, budget, provider,
      connect: () => storeModule.PostgresJobStore.connect({ ...config.jobStore, schemaPolicy: 'require-current',
        cipher: new cipherModule.AesGcmContentCipher(cipherModule.decodeContentEncryptionKey(config.jobStore.encryptionKey)) }),
      estimateCostMicros, canExecute, signal: controller.signal, resumeCheckpoint: checkpoint,
      saveCheckpoint: (value) => writeProtectedJson(paths.ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH, modules[5].signTargetCheckpoint(value, privateKey)),
    })
    if (!await canExecute()) throw new Error('prerequisites_changed')
    const body = modules[5].targetReleaseBody({ validation, ci, now: Date.now() })
    const receipt = modules[3].signReleaseAttestation(body, privateKey)
    await writeProtectedJson(paths.ANALYSIS_RELEASE_ATTESTATION_PATH, receipt)
    console.log(JSON.stringify({ version: 1, event: 'analysis.target.validation.completed', executionId: nonce,
      configurationHash: configDigest, invocationCount: validation.checkpoint.ledger.invocationCount,
      usage: validation.checkpoint.ledger.usage, unresolvedCount: 0, recovery: 'passed', cleanup: 'passed',
      attestationIssued: true, admissionHeld: true }))
  } catch {
    console.error('Target validation failed or interrupted. No new release proof was issued; keep admission held and reuse the same nonce/checkpoint.')
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
}
