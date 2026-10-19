import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { InMemoryJobStore } from '../services/analysis-service/dist/infrastructure/memoryJobStore.js'
import { verifyLocalQualitySample } from '../services/analysis-service/dist/operations/personalProviderVerification.js'
import { evaluatePublicQuality } from '../services/analysis-service/dist/operations/qualityEvaluation.js'
import { localChat } from '../services/analysis-service/dist/personal/localChat.js'

const root = resolve('.local-ai-validation')
const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']
const inheritedProxyNames = proxyVariables.filter((name) => process.env[name])
for (const name of proxyVariables) delete process.env[name]
const probe = (host, port = 443) => new Promise((yes) => {
  const started = Date.now(), socket = connect({ host, port })
  let done = false
  const finish = (connected, error) => {
    if (done) return; done = true; socket.destroy()
    yes({ host, port, connected, error, elapsedMs: Date.now() - started })
  }
  socket.setTimeout(5000, () => finish(false, 'timeout'))
  socket.once('connect', () => finish(true)); socket.once('error', (error) => finish(false, error.code))
})
await mkdir(root, { recursive: true })
if (process.argv.includes('--baseline')) {
  const receipt = { at: new Date().toISOString(), executable: process.execPath, inheritedProxyNames,
    probes: await Promise.all(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'].map((host) => probe(host))) }
  await writeFile(resolve(root, 'network-baseline.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt)); process.exit(receipt.probes.some((entry) => entry.connected) ? 0 : 1)
}
const guardPath = resolve(root, process.argv[2] ?? '')
if (!guardPath.startsWith(`${root}\\guard-`)) throw new Error('invalid_guard_directory')
const guard = JSON.parse((await readFile(resolve(guardPath, 'ready.json'), 'utf8')).replace(/^\uFEFF/, ''))
if (!guard.ready || !guard.programs.some((path) => path.toLowerCase() === process.execPath.toLowerCase())) throw new Error('acceptance_executable_not_guarded')
if (!guard.engine || guard.engine.processId !== Number((await readFile(resolve(root, 'engine.pid'), 'utf8')).trim())) throw new Error('engine_listener_not_owned')
const baseline = JSON.parse(await readFile(resolve(root, 'network-baseline.json'), 'utf8'))
if (baseline.executable.toLowerCase() !== process.execPath.toLowerCase() || !baseline.probes.some((entry) => entry.connected)) throw new Error('missing_positive_external_control')
const reportDirectory = resolve('reports', `v3-real-offline-${guard.runId}`)
await mkdir(reportDirectory, { recursive: true })
let activeRun
try {
  const controlledHosts = baseline.probes.filter((entry) => entry.connected)
  const external = await Promise.all(controlledHosts.map((entry) => probe(entry.host, entry.port)))
  if (!external.length || external.some((entry) => entry.connected)) throw new Error('external_network_not_blocked')
  const version = await (await fetch('http://127.0.0.1:11434/api/version')).json()
  const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json()
  await writeFile(resolve(reportDirectory, 'network-controls.json'), JSON.stringify({ scope: 'selected-process-external-network', physicallyDisconnectedMachine: false,
    guard, baseline, blockedAt: new Date().toISOString(), external, localhost: { passed: true, version }, tags, inheritedProxyNames }, null, 2))
  for (const modelId of ['qwen3:4b', 'qwen3:8b']) {
    // Unload first; all runs below have new source/run IDs and no prior AI cache.
    await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: modelId, keep_alive: 0 }) })
    for (const sampleId of ['photosynthesis', 'search-experiment']) {
      const store = new InMemoryJobStore(), profileId = randomUUID()
      const settings = { version: 1, providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', modelId, protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'local-loopback' }
      const state = { revision: 1, enabled: true, profileId, checkState: 'ready' }
      // Isolated storage; no inference injection or fixture provider. Production
      // provider transport, workers, validation, budgets and dispatcher are used.
      const profiles = { readState: async () => ({ ...state }), getSnapshot: async (id) => id === profileId ? { id, settings, revoked: false } : undefined,
        checkHealth: async () => true, createRun: (...args) => store.createRun(...args) }
      const started = Date.now(), key = `${modelId.replace(':', '-')}-${sampleId}`
      activeRun = key; console.log(JSON.stringify({ event: 'start', key, at: new Date().toISOString() }))
      const isolationController = new AbortController()
      const isolationChecks = []
      let checkPromise
      const checkIsolation = () => {
        if (checkPromise) return checkPromise
        checkPromise = (async () => {
        try {
          const probes = await Promise.all(controlledHosts.map((entry) => probe(entry.host, entry.port)))
          const cleaned = await readFile(resolve(guardPath, 'cleanup.json'), 'utf8').then(() => true, () => false)
          isolationChecks.push({ at: new Date().toISOString(), probes, guardAlreadyCleaned: cleaned })
          if (cleaned || probes.some((entry) => entry.connected)) isolationController.abort(new Error('isolation_lost'))
          try { process.kill(guard.engine.processId, 0) } catch { isolationController.abort(new Error('owned_engine_exited')) }
        } finally { checkPromise = undefined }
        })()
        return checkPromise
      }
      await checkIsolation()
      if (isolationController.signal.aborted) throw new Error('isolation_lost_before_run')
      const monitor = setInterval(() => { void checkIsolation().catch(() => isolationController.abort()) }, 30_000)
      let result
      try { result = await verifyLocalQualitySample({ store, profiles, deadlineMs: 2_700_000, requestLimit: 8, signal: isolationController.signal }, sampleId) }
      finally { clearInterval(monitor) }
      await checkIsolation()
      const receipt = { at: new Date().toISOString(), elapsedMs: Date.now() - started, modelId, sampleId, isolatedMemoryPersistence: true,
        result, isolationChecks, isolationLost: isolationController.signal.aborted,
        quality: evaluatePublicQuality(sampleId, result), modelProcess: await (await fetch('http://127.0.0.1:11434/api/ps')).json() }
      await writeFile(resolve(reportDirectory, `${key}.json`), JSON.stringify(receipt, null, 2))
      console.log(JSON.stringify({ event: 'finished', key, elapsedMs: receipt.elapsedMs, outcome: result.outcome, calls: result.callsUsed, kinds: Object.keys(result.artifacts), failures: result.failures }))
      if (isolationController.signal.aborted) throw new Error('isolation_lost')
      if (result.outcome !== 'passed') throw new Error(`pipeline_${key}_${result.outcome}`)
    }
    const chatBefore = await Promise.all(controlledHosts.map((entry) => probe(entry.host, entry.port)))
    if (chatBefore.some((entry) => entry.connected)) throw new Error('isolation_lost_before_chat')
    const settings = { version: 1, providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', modelId, protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'local-loopback' }
    const chat = await localChat(settings, { question: '资料未给出排序耗时，能否认定二分方案总时间更短？请解释。', context: '二分检索要求数据有序。一次查询的比较次数不等于包含排序准备与数据读写的总耗时。' })
    const chatAfter = await Promise.all(controlledHosts.map((entry) => probe(entry.host, entry.port)))
    const guardCleaned = await readFile(resolve(guardPath, 'cleanup.json'), 'utf8').then(() => true, () => false)
    if (guardCleaned || chatAfter.some((entry) => entry.connected)) throw new Error('isolation_lost_during_chat')
    await writeFile(resolve(reportDirectory, `${modelId.replace(':', '-')}-chat.json`), JSON.stringify({ ...chat, chatBefore, chatAfter }, null, 2))
  }
} catch (error) {
  await writeFile(resolve(reportDirectory, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), activeRun, message: error.message }, null, 2))
  throw error
} finally {
  await writeFile(resolve(guardPath, 'finish'), new Date().toISOString())
  let cleanup
  for (let attempt = 0; attempt < 20; attempt++) {
    cleanup = await readFile(resolve(guardPath, 'cleanup.json'), 'utf8').then((raw) => JSON.parse(raw.replace(/^\uFEFF/, '')), () => undefined)
    if (cleanup) break
    await new Promise((yes) => setTimeout(yes, 500))
  }
  if (!cleanup?.cleanupComplete || cleanup.remainingRules !== 0) {
    process.exitCode = 1
    await writeFile(resolve(reportDirectory, 'guard-cleanup-failure.json'), JSON.stringify({ at: new Date().toISOString(), cleanupComplete: false, reason: 'guard_cleanup_not_confirmed' }, null, 2))
    console.error('guard_cleanup_not_confirmed')
  } else await copyFile(resolve(guardPath, 'cleanup.json'), resolve(reportDirectory, 'guard-cleanup.json'))
}
