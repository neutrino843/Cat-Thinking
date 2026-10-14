import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AesGcmContentCipher } from '../services/analysis-service/dist/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js'
import { QualityProfileReader } from '../services/analysis-service/dist/operations/qualityProfileReader.js'
import { verifyPersonalQualitySample } from '../services/analysis-service/dist/operations/personalProviderVerification.js'
import { evaluatePublicQuality } from '../services/analysis-service/dist/operations/qualityEvaluation.js'
import { qualitySample } from '../services/analysis-service/dist/operations/qualityCorpus.js'
import { writeQualityReport } from './render-quality-report.mjs'
const [name, sampleId] = process.argv.slice(2)
if (process.argv.length !== 4 || !/^quality-regression-[0-9a-f-]{36}$/u.test(name ?? '')) throw new Error('Expected execution directory and public sample ID')
qualitySample(sampleId)
const root = resolve(import.meta.dirname, '..'); const directory = join(root, '..', 'reports', name)
const path = join(directory, 'results.json'); const batch = JSON.parse(await readFile(path, 'utf8'))
if (!['completed', 'stopped', 'partial'].includes(batch.status) || batch.inFlight || batch.unresolvedCount > 0) throw new Error('Incomplete or unknown paid results cannot be continued')
const config = JSON.parse(await readFile(join(root, '..', '.cat-thinking-postgres', 'secrets', 'database.json'), 'utf8'))
if (config.version !== 1 || config.host !== '127.0.0.1' || config.port !== 55432 || config.databases?.local?.name !== 'cat_analysis_local') throw new Error('local_quality_database_configuration_invalid')
const local = config.databases.local
const database = { mode: 'postgres', connectionString: `postgresql://${local.user}:${encodeURIComponent(local.password)}@${config.host}:${config.port}/${local.name}`,
  ssl: 'disable', poolMax: 3, connectTimeoutMs: 5000 }
const cipher = new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64'))
const store = await PostgresJobStore.connect({ ...database, cipher, schemaPolicy: 'require-current' })
const profiles = new QualityProfileReader(database, cipher, store)
const controller = new AbortController(); process.once('SIGINT', () => controller.abort())
try {
  const entries = [...batch.results, ...(batch.followups ?? []), ...(batch.remediations ?? [])]
  const state = await profiles.readState()
  const snapshot = state.profileId ? await profiles.getSnapshot(state.profileId) : undefined
  if (!snapshot || !state.enabled || snapshot.settings.modelId !== batch.model || snapshot.settings.providerId !== batch.provider) throw new Error('Model changed')
  let used = 0; let tokens = 0
  for (const entry of entries) {
    const original = await store.getRun(entry.result.tenantId, entry.result.runId)
    if (original?.request.providerProfileId !== state.profileId) throw new Error('Profile changed')
    const ledger = await store.getRunLedgerUsage(entry.result.tenantId, entry.result.runId)
    if (!ledger || ledger.unresolvedCount > 0) throw new Error('Unknown invocation outcome')
    used += ledger.invocationCount; tokens += ledger.usage.inputTokens + ledger.usage.outputTokens
  }
  const remainingCalls = 16 - used; const remainingTokens = 100000 - tokens
  if (remainingCalls < 2 || remainingTokens < 1) throw new Error('Quality execution budget consumed')
  const covered = new Set(entries.filter((entry) => entry.sample.id === sampleId).flatMap((entry) => Object.keys(entry.result.artifacts)))
  // Missing categories only; all old results retain their original runs and source identity.
  let kinds = ['summary', 'outline', 'quiz', 'knowledge', 'mindmap'].filter((kind) => !covered.has(kind))
  if (!kinds.length) throw new Error('All categories already covered')
  if (kinds.includes('mindmap') && !kinds.includes('outline')) kinds.unshift('outline')
  kinds = kinds.slice(0, remainingCalls - 1)
  await copyFile(path, join(directory, `before-followup-${entries.length}.json`))
  const build = JSON.parse(await readFile(join(root, 'services', 'analysis-service', 'dist', 'release-build.json'), 'utf8'))
  batch.inFlight = { sampleId, kinds, remainingCalls, remainingTokens, executionBuild: build, qualityProfile: 'high-quality', startedAt: new Date().toISOString() }
  await writeFile(path, JSON.stringify(batch, null, 2))
  console.log(JSON.stringify({ sampleId, kinds, remainingCalls, tokenReservation: Math.min(50000, remainingTokens) }))
  const result = await verifyPersonalQualitySample({ store, profiles, signal: controller.signal,
    requestLimit: Math.min(8, remainingCalls), maxRunTokens: Math.min(50000, remainingTokens) }, sampleId, kinds)
  const sample = qualitySample(sampleId)
  batch.followups ??= []; batch.followups.push({ sample: { id: sample.id, title: sample.title, text: sample.text }, result,
    quality: evaluatePublicQuality(sampleId, result), executionBuild: build, requestedKinds: kinds, qualityProfile: 'high-quality', promptPolicy: 'coverage-and-fair-rubric-v2' })
  batch.callsUsed = used + result.callsUsed; batch.inputTokens += result.usage.inputTokens; batch.outputTokens += result.usage.outputTokens
  batch.unresolvedCount += result.unresolvedCount; delete batch.inFlight; batch.status = 'partial'
  batch.categoryCoverage = batch.samples.map((entry) => ({ sampleId: entry.id,
    kinds: [...new Set([...batch.results, ...batch.followups].filter((item) => item.sample.id === entry.id).flatMap((item) => Object.keys(item.result.artifacts)))] }))
  batch.categoryCoverageComplete = batch.categoryCoverage.every((entry) => entry.kinds.length === 5) && batch.unresolvedCount === 0
  await writeFile(path, JSON.stringify(batch, null, 2))
  console.log(JSON.stringify({ outcome: result.outcome, totalCallsUsed: batch.callsUsed, inputTokens: batch.inputTokens,
    outputTokens: batch.outputTokens, categoryCoverage: batch.categoryCoverage, unresolvedCount: batch.unresolvedCount }))
  await writeQualityReport(directory, batch)
  if (result.outcome !== 'passed') process.exitCode = 1
} catch { console.error('quality_followup_stopped; budget or outcome requires inspection; no automatic retry'); process.exitCode = 1 }
finally { await profiles.close(); await store.close() }
