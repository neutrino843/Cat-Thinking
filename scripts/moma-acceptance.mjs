import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AesGcmContentCipher } from '../services/analysis-service/dist/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js'
import { QualityProfileReader } from '../services/analysis-service/dist/operations/qualityProfileReader.js'
import { verifyPersonalQualitySample } from '../services/analysis-service/dist/operations/personalProviderVerification.js'
import { evaluatePublicQuality } from '../services/analysis-service/dist/operations/qualityEvaluation.js'
import { qualitySample } from '../services/analysis-service/dist/operations/qualityCorpus.js'
import { createPinnedProviderFetch } from '../services/analysis-service/dist/providers/providerConnection.js'
import { createPersonalModelProvider } from '../services/analysis-service/dist/providers/personalModelProvider.js'

const mode = process.argv[2]
if (!['--plan', '--run', '--probe-native-thinking', '--run-native-thinking'].includes(mode) || process.argv.length !== 3) throw new Error('Use moma-acceptance.mjs --plan, --run, --probe-native-thinking or --run-native-thinking')
const root = resolve(import.meta.dirname, '..')
let store, reader
try {
  const config = JSON.parse(await readFile(resolve(root, '../.cat-thinking-postgres/secrets/database.json'), 'utf8'))
  if (config.version !== 1 || config.host !== '127.0.0.1' || !Number.isInteger(config.port)) throw new Error('local_database_configuration_invalid')
  const local = config.databases.local
  const connectionString = `postgresql://${local.user}:${encodeURIComponent(local.password)}@127.0.0.1:${config.port}/${local.name}`
  const database = { mode: 'postgres', connectionString, ssl: 'disable', poolMax: 3, connectTimeoutMs: 5000 }
  const cipher = new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64'))
  store = await PostgresJobStore.connect({ ...database, cipher, schemaPolicy: 'require-current', applicationName: 'cat-analysis-moma-public-acceptance' })
  reader = new QualityProfileReader(database, cipher, store)
  const profiles = {
    readState: () => reader.readState(), checkHealth: () => reader.checkHealth(),
    createRun: (...args) => reader.createRun(...args),
    getSnapshot: async (id) => {
      const snapshot = await reader.getSnapshot(id)
      if (!snapshot) return undefined
      const s = snapshot.settings, url = new URL(s.baseUrl)
      // An existing key for a different service can never be used by this check.
      return s.providerId === 'mobilecloud' && url.origin === 'https://zhenze-huhehaote.cmecloud.cn'
        && url.pathname.replace(/\/+$/, '') === '/v1' && s.modelId === 'deepseek-v4-flash-0731'
        && s.protocol === 'chat-completions' && s.networkMode === 'public' && !!s.apiKey ? snapshot : undefined
    },
  }
  const state = await profiles.readState()
  const snapshot = state.profileId ? await profiles.getSnapshot(state.profileId) : undefined
  const plan = { at: new Date().toISOString(), provider: 'mobilecloud', model: 'deepseek-v4-flash-0731',
    ready: state.enabled && !!snapshot, sample: 'photosynthesis', userFilesSent: false,
    budget: { maxCalls: 8, maxOutputTokensPerCall: 4096, maxReservedTokens: 50000, deadlineMs: 180000, automaticTransportRetries: 0 },
    semanticReviewRequired: true }
  if (mode === '--plan') console.log(JSON.stringify(plan, null, 2))
  else if (mode === '--probe-native-thinking') {
    if (!plan.ready) throw new Error('moma_profile_not_ready')
    const fetcher = createPinnedProviderFetch({ baseUrl: snapshot.settings.baseUrl, maxResponseBytes: 65536 })
    const started = Date.now()
    const response = await fetcher(new URL('chat/completions', snapshot.settings.baseUrl), {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${snapshot.settings.apiKey}` },
      body: JSON.stringify({ model: snapshot.settings.modelId, stream: false, max_tokens: 128, enable_thinking: false,
        messages: [{ role: 'user', content: '请仅返回JSON对象 {"ok":true}，不要补充说明。' }] }),
    })
    const payload = response.ok ? await response.json() : undefined
    const choice = payload?.choices?.[0]
    const receipt = { at: new Date().toISOString(), operation: 'bounded-native-thinking-probe', elapsedMs: Date.now() - started,
      httpStatus: response.status, maxOutputTokens: 128, calls: 1, automaticRetries: 0, userFilesSent: false,
      completed: choice?.finish_reason === 'stop', expectedContent: typeof choice?.message?.content === 'string' && /^\s*\{\s*"ok"\s*:\s*true\s*\}\s*$/u.test(choice.message.content),
      reasoningCharacters: typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0,
      usage: { inputTokens: payload?.usage?.prompt_tokens, outputTokens: payload?.usage?.completion_tokens } }
    await writeFile(resolve(root, 'reports/v3-moma-native-thinking-probe.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt))
    if (!response.ok || !receipt.completed || !receipt.expectedContent) process.exitCode = 1
  } else {
    if (!plan.ready) throw new Error('moma_profile_not_ready')
    const directory = resolve(root, 'reports', `v3-moma-real-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, 'plan.json'), JSON.stringify({ ...plan, experimentalNativeThinkingSwitch: mode === '--run-native-thinking' }, null, 2))
    const started = Date.now()
    console.log(JSON.stringify({ event: 'start', directory, budget: plan.budget }))
    const transport = []
    const createProvider = (profile) => {
      const pinned = createPinnedProviderFetch({ baseUrl: profile.settings.baseUrl, maxResponseBytes: 2000000 })
      return createPersonalModelProvider(profile.settings, profile.id, async (url, init) => {
        const body = JSON.parse(init.body)
        if (mode === '--run-native-thinking') body.enable_thinking = false
        const response = await pinned(url, { ...init, body: JSON.stringify(body) })
        const payload = response.ok ? await response.clone().json().catch(() => undefined) : undefined
        const choice = payload?.choices?.[0]
        transport.push({ httpStatus: response.status, completed: choice?.finish_reason === 'stop',
          finishReason: ['stop', 'length', 'content_filter'].includes(choice?.finish_reason) ? choice.finish_reason : 'other',
          contentCharacters: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
          reasoningCharacters: typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0,
          inputTokens: payload?.usage?.prompt_tokens, outputTokens: payload?.usage?.completion_tokens })
        await writeFile(resolve(directory, 'transport.json'), JSON.stringify(transport, null, 2))
        return response
      })
    }
    const result = await verifyPersonalQualitySample({ store, profiles, requestLimit: 8, maxRunTokens: 50000, createProvider }, 'photosynthesis')
    const quality = evaluatePublicQuality('photosynthesis', result)
    await writeFile(resolve(directory, 'result.json'), JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started,
      sample: qualitySample('photosynthesis'), result, quality }, null, 2))
    console.log(JSON.stringify({ event: 'finished', directory, outcome: result.outcome, artifacts: Object.keys(result.artifacts), callsUsed: result.callsUsed,
      usage: result.usage, unresolvedCount: result.unresolvedCount, cleanupComplete: result.cleanupComplete, profileStateUnchanged: result.profileStateUnchanged, failures: result.failures }))
    if (result.outcome !== 'passed' || !quality.exactReferencesPassed || !result.cleanupComplete || !result.profileStateUnchanged) process.exitCode = 1
  }
} catch (error) {
  console.error(error?.message === 'moma_profile_not_ready' ? 'moma_profile_not_ready: save and connect the MoMA profile in the app first; no model call made' : 'moma_acceptance_failed: raw errors and credentials withheld')
  process.exitCode = 1
} finally { try { await reader?.close() } finally { await store?.close() } }
