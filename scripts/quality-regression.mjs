import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AesGcmContentCipher } from '../services/analysis-service/dist/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js'
import { QualityProfileReader } from '../services/analysis-service/dist/operations/qualityProfileReader.js'
import { verifyPersonalQualitySample } from '../services/analysis-service/dist/operations/personalProviderVerification.js'
import { evaluatePublicQuality } from '../services/analysis-service/dist/operations/qualityEvaluation.js'
import { QUALITY_SAMPLES, QUALITY_CORPUS_VERSION, qualitySampleHash } from '../services/analysis-service/dist/operations/qualityCorpus.js'
import { writeQualityReport } from './render-quality-report.mjs'

const mode = process.argv[2]
if (process.argv.length !== 3 || !['--plan', '--run'].includes(mode)) throw new Error('Use quality-regression.mjs --plan or --run')
const root = resolve(import.meta.dirname, '..')
const executionId = randomUUID()
const directory = join(root, '..', 'reports', `quality-regression-${executionId}`)
const config = JSON.parse(await readFile(join(root, '..', '.cat-thinking-postgres', 'secrets', 'database.json'), 'utf8'))
if (config.version !== 1 || config.host !== '127.0.0.1' || config.port !== 55432 || config.databases?.local?.name !== 'cat_analysis_local') throw new Error('local_quality_database_configuration_invalid')
const local = config.databases.local
const connectionString = `postgresql://${local.user}:${encodeURIComponent(local.password)}@${config.host}:${config.port}/${local.name}`
const cipher = new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64'))
const database = { mode: 'postgres', connectionString, ssl: 'disable', poolMax: 3, connectTimeoutMs: 5000 }
const store = await PostgresJobStore.connect({ ...database, cipher, schemaPolicy: 'require-current', applicationName: 'cat-analysis-public-quality-regression' })
const profiles = new QualityProfileReader(database, cipher, store)
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  const state = await profiles.readState()
  const snapshot = state.profileId ? await profiles.getSnapshot(state.profileId) : undefined
  const build = JSON.parse(await readFile(join(root, 'services', 'analysis-service', 'dist', 'release-build.json'), 'utf8'))
  const plan = { version: 1, executionId, corpusVersion: QUALITY_CORPUS_VERSION, createdAt: new Date().toISOString(),
    executionBuild: { commit: build.commit, artifactDigest: build.artifactDigest, serviceVersion: build.serviceVersion, sourceMayHaveUncommittedChanges: true },
    provider: snapshot?.settings.providerId, model: snapshot?.settings.modelId, qualityProfile: 'high-quality', promptPolicy: 'coverage-and-fair-rubric-v2', ready: state.enabled && !!snapshot && !snapshot.revoked,
    samples: QUALITY_SAMPLES.map((sample) => ({ id: sample.id, title: sample.title, characters: sample.text.length, hash: qualitySampleHash(sample) })),
    budget: { maxCalls: 16, maxCallsPerSample: 8, maxOutputTokensPerCall: 4096, maxTotalReservedTokens: 100000, maxReservedTokensPerSample: 50000,
      deadlineMsPerSample: 180000, transportAttemptsPerInvocation: 1, pricingKnown: false },
    sourcePolicy: 'Fixed original public samples only; no user files, keys or endpoints in report',
  }
  if (mode === '--plan') { console.log(JSON.stringify(plan, null, 2)) }
  else {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan, null, 2))
    if (!plan.ready) throw new Error('quality_profile_not_enabled')
    const batch = { ...plan, status: 'running', pipelinePassed: false, semanticQualityApproved: false,
      callsUsed: 0, inputTokens: 0, outputTokens: 0, unresolvedCount: 0, results: [] }
    const persist = () => writeFile(join(directory, 'results.json'), JSON.stringify(batch, null, 2))
    await persist()
    for (const sample of QUALITY_SAMPLES) {
      if (controller.signal.aborted || batch.unresolvedCount > 0) break
      const remaining = plan.budget.maxTotalReservedTokens - batch.inputTokens - batch.outputTokens
      const callsLeft = plan.budget.maxCalls - batch.callsUsed
      if (remaining < 1 || callsLeft < 1) break
      console.log(`Real quality sample: ${sample.id}; remaining calls=${callsLeft}; token reservation=${Math.min(50000, remaining)}`)
      const result = await verifyPersonalQualitySample({ store, profiles, signal: controller.signal,
        requestLimit: Math.min(8, callsLeft), maxRunTokens: Math.min(50000, remaining) }, sample.id)
      const quality = evaluatePublicQuality(sample.id, result)
      batch.results.push({ sample: { id: sample.id, title: sample.title, text: sample.text }, result, quality })
      batch.callsUsed += result.callsUsed; batch.inputTokens += result.usage.inputTokens
      batch.outputTokens += result.usage.outputTokens; batch.unresolvedCount += result.unresolvedCount
      await persist()
      if (!result.profileStateUnchanged || !result.cleanupComplete || result.unresolvedCount > 0) break
    }
    batch.status = controller.signal.aborted ? 'interrupted' : batch.results.length === QUALITY_SAMPLES.length ? 'completed' : 'stopped'
    batch.pipelinePassed = batch.results.length === QUALITY_SAMPLES.length && batch.results.every((entry) => entry.quality.pipelinePassed && entry.quality.exactReferencesPassed)
    await persist()
    console.log(JSON.stringify({ reportDirectory: directory, status: batch.status, pipelinePassed: batch.pipelinePassed,
      callsUsed: batch.callsUsed, inputTokens: batch.inputTokens, outputTokens: batch.outputTokens, unresolvedCount: batch.unresolvedCount }))
    await writeQualityReport(directory, batch)
    if (!batch.pipelinePassed) process.exitCode = 1
  }
} catch (error) {
  console.error(['quality_profile_not_enabled'].includes(error?.message) ? error.message : 'quality_regression_failed; raw errors and credentials withheld')
  process.exitCode = 1
} finally { await profiles.close(); await store.close() }
