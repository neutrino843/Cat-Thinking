import { createHash, randomUUID } from 'node:crypto'
import {
  ARTIFACT_KINDS,
  canonicalizeJson,
  collectArtifactCitations,
  type AnalysisErrorV1,
  type AnalysisRunV1,
  type ArtifactKind,
  type KnowledgeArtifactV1,
  type MindMapArtifactV1,
  type OutlineArtifactV1,
  type QuizArtifactV1,
  type SummaryArtifactV1,
} from '@cat-thinking/analysis-contracts'
import { validateGeneratedArtifact } from '../domain/artifactValidator.js'
import { planArtifactBudget } from '../domain/artifactBudget.js'
import type { JobStore } from '../domain/jobStore.js'
import { PersistentDispatcher } from '../domain/persistentDispatcher.js'
import { RunService, isTerminalRun } from '../domain/runService.js'
import type { PersonalProfileState, PersonalProfileStore, PersonalProviderSnapshot } from '../personal/profileStore.js'
import { createAnalysisProviderRuntime } from '../providers/analysisProviderRuntime.js'
import type { ModelProvider, ModelResponse } from '../providers/modelProvider.js'
import { createPersonalModelProvider, PERSONAL_PROVIDER_LIMITS } from '../providers/personalModelProvider.js'
import { ProviderGatewayError } from '../providers/providerError.js'

/** Original public teaching text. Never substitute a user's document for this sample. */
export const PERSONAL_VERIFICATION_SAMPLE = [
  '第一节 光合作用的总体过程',
  '光合作用利用光能，将二氧化碳和水转化为有机物，并释放氧气。植物的叶绿体是这一过程的重要场所。有机物储存能量，也为植物生长提供物质基础。',
  '第二节 相互联系的反应',
  '光反应吸收光能，并为后续形成有机物的过程提供能量。因此，理解光合作用时，需要同时关注能量的转换和物质的变化，不能把这些知识作为彼此孤立的结论。',
  '第三节 研究与学习方法',
  '研究光照对光合作用的影响时，可以设置不同光照条件，并保持其他实验条件相同。记录现象后，应比较各组结果，再判断证据是否支持结论。整理知识时，可先说明总体过程，再解释组成部分之间的联系，最后用实验说明如何检验相关观点。',
].join('\n')

export const PERSONAL_VERIFICATION_LIMITS = Object.freeze({ requests: 3, outputTokens: 4096, deadlineMs: 120000 })

/** Original public lesson written for this isolated check, never imported customer text. */
export const PERSONAL_LEARNING_VERIFICATION_SAMPLE = [
  '第一节 从总体过程理解光合作用',
  '光合作用是一组彼此联系的反应。绿色植物利用光能，将二氧化碳和水转化为有机物，并释放氧气。有机物既是生长所需的物质，也是储存化学能的载体。叶绿体是植物进行光合作用的重要场所。学习这一主题时，可以先回答三个问题：能量从哪里来，物质发生了什么变化，各部分怎样合作完成总体过程。把这三个问题联系起来，比只背诵孤立的名称更容易解释新的现象。',
  '第二节 光反应提供能量与还原力',
  '在叶绿体的类囊体膜上，光合色素吸收光能，相关反应使水发生分解，并释放氧气。电子传递和质子梯度参与三磷酸腺苷的形成；另一部分反应形成还原型烟酰胺腺嘌呤二核苷酸磷酸。前者通常简称ATP，后者通常简称NADPH。ATP提供可利用的化学能，NADPH提供还原力。理解这一节，需要把色素吸收光能、水参与反应、产物形成和后续用途串成一个过程，而不是把几个缩写当作互不相干的词汇。',
  '第三节 碳同化利用前一阶段的产物',
  '在叶绿体的基质中，二氧化碳进入碳同化过程。二氧化碳先与受体结合，形成中间产物；随后利用ATP和NADPH参与的反应形成可用于合成有机物的产物，同时再生受体，使过程能够继续进行。这说明光反应与碳同化存在功能联系：一个阶段提供能量和还原力，另一个阶段利用这些条件完成碳的转化。碳同化的有关反应不直接吸收光，并不意味着它在自然条件下完全不受光照影响，因为它仍依赖前一阶段提供的产物。',
  '第四节 光照与二氧化碳的限制作用',
  '在其他条件适合时，增加光照强度可能提高光合作用速率；但提高到一定程度后，速率可能不再明显增加，因为二氧化碳供应或其他条件成为限制因素。增加二氧化碳浓度也不保证速率无限上升。分析曲线时，应区分低水平时的限制条件与接近平台时的新限制条件。观察到平台，只能说明在当前实验范围内增加某个条件的作用变小，不能直接证明所有反应都已达到相同的最大速度。',
  '第五节 设计实验并评价证据',
  '研究光照的影响，可以设置多个光照水平，同时尽量保持植物材料、二氧化碳供应、温度和测量时长相同。温度会影响酶参与的反应，因此光源引起的升温可能成为干扰。实验中可以记录单位时间内氧气变化等指标，但应说明指标与所研究过程之间的关系。设置重复组有助于观察结果是否稳定。比较结果时，先描述记录，再判断差异是否支持原来的解释；如果出现反常结果，应检查测量、材料差异和其他条件，不能为了符合预期而删去数据。',
  '第六节 用结构整理和练习检查理解',
  '知识结构可以以总体过程为中心，下设光反应、碳同化、限制因素和实验方法。光反应下面进一步组织位置、输入、产物和作用；碳同化下面组织二氧化碳进入、产物形成和受体再生。树状关系表达组成，跨节点关系表达ATP和NADPH的供给联系，以及限制因素对总体过程的影响。练习题可以分别检查名称识别、阶段联系、曲线解释和实验条件判断。选择题或判断题答错后，应回到对应原文检查原因；简答题则根据关键点进行自评。一次答对不等于长期掌握，一次答错也不能直接说明整个主题都不会。',
].join('\n')

export const PERSONAL_LEARNING_VERIFICATION_LIMITS = Object.freeze({ requests: 8, outputTokens: 4096, deadlineMs: 180000 })
export type PersonalLearningVerificationRequestLimit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

type VerificationReason = 'profile_not_enabled' | 'profile_changed' | 'provider_unavailable' | 'deadline_exceeded'
  | 'interrupted' | 'operation_failed' | 'result_not_safe'

export interface PersonalProviderVerificationResult {
  readonly version: 1
  readonly kind: 'personal-public-sample-verification'
  readonly notProductionAttestation: true
  readonly outcome: 'passed' | 'partial' | 'failed' | 'blocked' | 'timed_out' | 'interrupted'
  readonly reason?: VerificationReason
  readonly callsUsed: number
  readonly limit: 1 | 2 | 3
  readonly evidenceValidated: boolean
  readonly sample: Readonly<{ hash: string; characters: number }>
  readonly runId?: string
  readonly tenantId?: string
  readonly profileStateUnchanged: boolean
  readonly cleanupComplete: boolean
  readonly pricingKnown: false
  readonly invocationCount: number
  readonly unresolvedCount: number
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number }>
  readonly artifacts: Readonly<{ summary?: SummaryArtifactV1; outline?: OutlineArtifactV1 }>
  readonly failures: readonly Readonly<{ stage: 'evidence' | 'summary' | 'outline'; code: AnalysisErrorV1['code']; retryable: boolean }>[]
}

export interface PersonalProviderVerificationOptions {
  /** Already initialized stores; the caller owns their lifecycle and profile ownership lock. */
  readonly store: JobStore
  readonly profiles: PersonalProfileStore
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
  /** Remaining authorization for this batch; never expand beyond three attempts. */
  readonly requestLimit?: 1 | 2 | 3
  /** Trusted test injection only. The default uses the existing DNS-pinned Provider transport. */
  readonly createProvider?: (snapshot: PersonalProviderSnapshot) => ModelProvider
}

type VerificationArtifacts = Readonly<{
  summary?: SummaryArtifactV1; outline?: OutlineArtifactV1; mindmap?: MindMapArtifactV1
  quiz?: QuizArtifactV1; knowledge?: KnowledgeArtifactV1
}>
type VerificationFailure = Readonly<{ stage: 'evidence' | ArtifactKind; code: AnalysisErrorV1['code']; retryable: boolean }>
type VerificationReceipt = Omit<PersonalProviderVerificationResult, 'kind' | 'limit' | 'artifacts' | 'failures'> & Readonly<{
  artifacts: VerificationArtifacts; failures: readonly VerificationFailure[]
}>

export interface PersonalLearningVerificationResult extends Omit<PersonalProviderVerificationResult, 'kind' | 'limit' | 'artifacts' | 'failures'> {
  readonly kind: 'personal-learning-pipeline-verification'
  readonly limit: PersonalLearningVerificationRequestLimit
  readonly artifacts: VerificationArtifacts
  readonly failures: readonly VerificationFailure[]
}
export interface PersonalLearningVerificationOptions extends Omit<PersonalProviderVerificationOptions, 'requestLimit'> {
  /** A new explicit authorization, independent of the old three-request check. */
  readonly requestLimit?: PersonalLearningVerificationRequestLimit
}
interface VerificationConfiguration {
  readonly sample: string
  readonly maximumRequests: number
  readonly maximumDeadlineMs: number
  readonly kinds: readonly ArtifactKind[]
  readonly learning: boolean
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sameState = (left: PersonalProfileState, right: PersonalProfileState) => left.revision === right.revision
  && left.profileId === right.profileId && left.enabled === right.enabled && left.checkState === right.checkState

const containsPrivateText = (value: unknown, privateValues: readonly string[]): boolean => {
  if (typeof value === 'string') return privateValues.some((text) => value.includes(text))
  if (Array.isArray(value)) return value.some((item) => containsPrivateText(item, privateValues))
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
    containsPrivateText(key, privateValues) || containsPrivateText(item, privateValues))
  return false
}

const abortableResponse = (response: Promise<ModelResponse>, signal: AbortSignal, providerId: string) =>
  new Promise<ModelResponse>((resolve, reject) => {
    const aborted = () => reject(new ProviderGatewayError({ providerId, kind: 'outcome_unknown', retryable: false,
      safeCode: 'verification_interrupted' }))
    if (signal.aborted) { void response.catch(() => undefined); aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    void response.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })

const pause = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, 20)
  signal.addEventListener('abort', done, { once: true })
})

/** One explicitly authorized sample, never a background retry or production release receipt. */
export const verifyPersonalProvider = async (options: PersonalProviderVerificationOptions): Promise<PersonalProviderVerificationResult> => {
  const receipt = await verifyBoundedPersonalSample(options, { sample: PERSONAL_VERIFICATION_SAMPLE,
    maximumRequests: PERSONAL_VERIFICATION_LIMITS.requests, maximumDeadlineMs: PERSONAL_VERIFICATION_LIMITS.deadlineMs,
    kinds: ['summary', 'outline'], learning: false })
  return { ...receipt, kind: 'personal-public-sample-verification', limit: options.requestLimit ?? 3,
    failures: receipt.failures.filter((failure): failure is PersonalProviderVerificationResult['failures'][number] =>
      failure.stage === 'evidence' || failure.stage === 'summary' || failure.stage === 'outline') }
}

/** Separate eight-request operation. Implementing this function never authorizes its execution. */
export const verifyPersonalLearningPipeline = async (options: PersonalLearningVerificationOptions): Promise<PersonalLearningVerificationResult> => {
  const receipt = await verifyBoundedPersonalSample(options, { sample: PERSONAL_LEARNING_VERIFICATION_SAMPLE,
    maximumRequests: PERSONAL_LEARNING_VERIFICATION_LIMITS.requests,
    maximumDeadlineMs: PERSONAL_LEARNING_VERIFICATION_LIMITS.deadlineMs, kinds: ARTIFACT_KINDS, learning: true })
  return { ...receipt, kind: 'personal-learning-pipeline-verification', limit: options.requestLimit ?? 8 }
}

const verifyBoundedPersonalSample = async (
  options: Omit<PersonalProviderVerificationOptions, 'requestLimit'> & Readonly<{ requestLimit?: number }>,
  configuration: VerificationConfiguration,
): Promise<VerificationReceipt> => {
  const requestLimit = options.requestLimit ?? configuration.maximumRequests
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > configuration.maximumRequests) {
    throw new RangeError(`personal verification request limit must be between 1 and ${configuration.maximumRequests}`)
  }
  const deadlineMs = options.deadlineMs ?? configuration.maximumDeadlineMs
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > configuration.maximumDeadlineMs) {
    throw new RangeError(`personal verification deadline must be between 1 and ${configuration.maximumDeadlineMs} milliseconds`)
  }
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  const operationId = randomUUID()
  const tenantId = `${configuration.learning ? 'learning-verify' : 'verify'}-${operationId}`
  const sourceId = `source-${operationId}`
  const sampleHash = sha256(configuration.sample)
  let initialState: PersonalProfileState | undefined
  let snapshot: PersonalProviderSnapshot | undefined
  let snapshotSettingsHash: string | undefined
  let privateValues: readonly string[] = []
  let runId: string | undefined
  let service: RunService | undefined
  let dispatcher: PersistentDispatcher | undefined
  let callsUsed = 0
  let evidenceValidated = false
  let dispatchFailed = false
  let reason: VerificationReason | undefined
  let outcome: PersonalProviderVerificationResult['outcome'] = 'blocked'
  let artifacts: VerificationArtifacts = {}
  let failures: readonly VerificationFailure[] = []
  let cleanupComplete = false
  let profileStateUnchanged = false
  let invocationCount = 0
  let unresolvedCount = 0
  let usage = { inputTokens: 0, outputTokens: 0 }

  const canInvoke = async () => {
    if (signal.aborted || !initialState || !snapshot || !initialState.enabled) return false
    try {
      if (!await options.store.checkHealth() || !await options.profiles.checkHealth()) return false
      const state = await options.profiles.readState()
      const current = await options.profiles.getSnapshot(snapshot.id)
      return sameState(initialState, state) && !!current && !current.revoked
        && snapshot.id === initialState.profileId && current.id === snapshot.id
        && sha256(canonicalizeJson(current.settings)) === snapshotSettingsHash
    } catch { return false }
  }

  try {
    initialState = await options.profiles.readState()
    if (configuration.learning && signal.aborted) { reason = 'interrupted'; outcome = 'interrupted'; return await finish() }
    if (!initialState.enabled || !initialState.profileId) { reason = 'profile_not_enabled'; return await finish() }
    snapshot = await options.profiles.getSnapshot(initialState.profileId)
    if (snapshot) {
      snapshotSettingsHash = sha256(canonicalizeJson(snapshot.settings))
      privateValues = [snapshot.settings.apiKey, snapshot.settings.baseUrl].filter((value): value is string => !!value)
    }
    if (!snapshot || snapshot.revoked || !await canInvoke()) { reason = 'provider_unavailable'; return await finish() }
    const provider = options.createProvider ? options.createProvider(snapshot)
      : createPersonalModelProvider(snapshot.settings, snapshot.id)
    if (!provider.isReady() || provider.profileVersion !== snapshot.id || provider.modelId !== snapshot.settings.modelId) {
      reason = 'provider_unavailable'; return await finish()
    }
    const snapshotId = snapshot.id
    const boundedProvider: ModelProvider = {
      id: provider.id, modelId: provider.modelId, profileVersion: provider.profileVersion,
      capabilities: { ...provider.capabilities, maxOutputTokens: Math.min(provider.capabilities.maxOutputTokens, PERSONAL_VERIFICATION_LIMITS.outputTokens) },
      isReady: () => provider.isReady(),
      generate: async (request, parentSignal) => {
        const callSignal = AbortSignal.any([signal, parentSignal])
        if (callSignal.aborted || !await canInvoke()) throw new ProviderGatewayError({ providerId: provider.id,
          kind: 'rejected', acceptance: 'not_accepted', retryable: false, safeCode: 'verification_gate_closed' })
        if (callsUsed >= requestLimit || request.maxOutputTokens > PERSONAL_VERIFICATION_LIMITS.outputTokens) {
          throw new ProviderGatewayError({ providerId: provider.id, kind: 'rejected', acceptance: 'not_accepted',
            retryable: false, safeCode: 'verification_request_limit' })
        }
        callSignal.throwIfAborted()
        callsUsed += 1
        return abortableResponse(provider.generate(request, callSignal), callSignal, provider.id)
      },
    }
    const scopedStore = new Proxy(options.store, {
      get(target, property) {
        if (property === 'createRun') return async (...args: Parameters<JobStore['createRun']>) => {
          if (args[0] !== tenantId || args[1].request.providerProfileId !== snapshotId || !await canInvoke()) {
            throw new Error('verification_run_scope_invalid')
          }
          return options.profiles.createRun(...args)
        }
        if (property === 'listDispatchableRuns') return async (now: number) => {
          if (!runId) return []
          const run = await target.getRun(tenantId, runId)
          return run && !isTerminalRun(run) && run.status !== 'receiving' && (run.expiresAt ?? Infinity) > now
            ? [{ tenantId, runId }] : []
        }
        if (property === 'listExpiredRuns') return async () => []
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    service = new RunService({ store: scopedStore, retentionSeconds: 3600, providerProfileMode: 'personal', canAdmit: canInvoke,
      maxRunEstimatedTokens: PERSONAL_PROVIDER_LIMITS.maxRunTokens, maxRunEstimatedCostMicros: 0 })
    const runtime = createAnalysisProviderRuntime({ store: scopedStore, provider: boundedProvider, broker: service.broker,
      expectedPersonalProfileId: snapshot.id, leaseMs: 1000, estimateCostMicros: () => 0, canInvoke,
      policy: { maxAttempts: 1, retryBaseDelayMs: 250, retryMaxDelayMs: 1000, circuitFailureThreshold: 3, circuitOpenMs: 30000,
        staleAfterMs: 600000, maxRunEstimatedTokens: PERSONAL_PROVIDER_LIMITS.maxRunTokens, maxRunEstimatedCostMicros: 0,
        maxRunInvocations: requestLimit } })
    const created = await service.createRun(tenantId, {
      version: 1, requestKey: sha256(`${operationId}:${sampleHash}`), docId: `sample-${operationId}`, providerProfileId: snapshot.id,
      manifest: { version: 1, sources: [{ version: 1, sourceId, kind: 'text', extractor: 'public-verification-v1',
        contentHash: sampleHash, charCount: configuration.sample.length,
        byteCount: new TextEncoder().encode(configuration.sample).byteLength,
        locators: [{ start: 0, end: configuration.sample.length, titlePath: ['公开教学样例：光合作用'] }] }] },
      artifacts: [...configuration.kinds], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'brief',
        quizQuestionCount: configuration.learning ? 5 : 1, externalKnowledge: false },
    })
    runId = created.run.id
    await service.uploadSource(tenantId, runId, { version: 1, sourceId, contentHash: sampleHash, partHash: sampleHash,
      partIndex: 0, partCount: 1, start: 0, end: configuration.sample.length, totalChars: configuration.sample.length,
      text: configuration.sample })
    await service.startRun(tenantId, runId, created.run.revision)
    dispatcher = new PersistentDispatcher({ store: scopedStore, evidence: runtime.evidence, artifacts: runtime.artifacts,
      cleanupExpired: async () => undefined, ownerId: `verification-${operationId}`, leaseMs: 1000, pollMs: 20,
      maxRunMs: deadlineMs, concurrency: 1, canDispatch: canInvoke, onError: () => { dispatchFailed = true } })
    await dispatcher.start()
    let completed: AnalysisRunV1 | undefined
    while (!signal.aborted) {
      const current = await scopedStore.getRun(tenantId, runId)
      if (!current) throw new Error('verification_run_missing')
      if (isTerminalRun(current)) { completed = current; break }
      if (dispatchFailed) { reason = 'operation_failed'; break }
      if (!await canInvoke()) { reason = 'profile_changed'; break }
      await pause(signal)
    }
    if (signal.aborted) reason = options.signal?.aborted ? 'interrupted' : 'deadline_exceeded'
    if (completed) {
      await collectValidatedArtifacts(completed)
      if (containsPrivateText(artifacts, privateValues)) {
        artifacts = {}; reason = 'result_not_safe'
      }
      failures = [
        ...(completed.error && !configuration.kinds.some((kind) => completed.artifactStates[kind]?.error)
          ? [{ stage: 'evidence' as const, code: completed.error.code, retryable: completed.error.retryable }] : []),
        ...configuration.kinds.flatMap((stage) => {
          const error = completed.artifactStates[stage]?.error
          return error ? [{ stage, code: error.code, retryable: error.retryable }] : []
        }),
      ]
      outcome = configuration.kinds.every((kind) => !!artifacts[kind]) && !reason ? 'passed'
        : !reason && (Object.keys(artifacts).length > 0 || evidenceValidated) ? 'partial' : 'failed'
    } else outcome = reason === 'deadline_exceeded' ? 'timed_out' : reason === 'interrupted' ? 'interrupted' : 'blocked'
  } catch {
    reason = signal.aborted ? options.signal?.aborted ? 'interrupted' : 'deadline_exceeded' : 'operation_failed'
    outcome = reason === 'deadline_exceeded' ? 'timed_out' : reason === 'interrupted' ? 'interrupted' : 'failed'
  }
  return finish()

  async function collectValidatedArtifacts(run: AnalysisRunV1): Promise<void> {
    if (!runId || !service) return
    const graph = await options.store.getEvidenceGraph(tenantId, runId)
    evidenceValidated = !!graph
    if (!graph) { artifacts = {}; return }
    const outline = await options.store.getArtifact(tenantId, runId, 'outline')
    let collected: VerificationArtifacts = {}
    for (const kind of configuration.kinds) {
      const stored = kind === 'outline' ? outline : await options.store.getArtifact(tenantId, runId, kind)
      if (!stored || run.artifactStates[kind]?.status !== 'succeeded') continue
      const artifact = validateGeneratedArtifact({ artifact: stored.artifact, expectedKind: kind, run, graph,
        maxArtifactBytes: planArtifactBudget(kind, run.request.options).maxArtifactBytes,
        ...(outline?.artifact.kind === 'outline' ? { outline: outline.artifact.payload } : {}) })
      if (configuration.learning) for (const citation of collectArtifactCitations(artifact)) {
        if (citation.provenance === 'source' && (citation.sourceId !== sourceId
          || citation.quote !== configuration.sample.slice(citation.start, citation.end))) {
          throw new Error('verification_source_reference_invalid')
        }
      }
      switch (artifact.kind) {
        case 'summary': collected = { ...collected, summary: artifact.payload }; break
        case 'outline': collected = { ...collected, outline: artifact.payload }; break
        case 'mindmap': collected = { ...collected, mindmap: artifact.payload }; break
        case 'quiz': collected = { ...collected, quiz: artifact.payload }; break
        case 'knowledge': collected = { ...collected, knowledge: artifact.payload }; break
      }
    }
    artifacts = collected
  }

  async function finish(): Promise<VerificationReceipt> {
    clearTimeout(timer)
    controller.abort()
    let stopped = true
    try { await dispatcher?.stop(5000) } catch { stopped = false }
    if (runId && service) {
      try {
        const current = await options.store.getRun(tenantId, runId)
        if (configuration.learning && current) {
          try { await collectValidatedArtifacts(current) } catch {
            artifacts = {}; reason = 'operation_failed'; outcome = 'failed'
          }
        }
        if (current && !isTerminalRun(current)) await service.cancel(tenantId, runId, current.revision)
        const deleted = await service.deleteContent(tenantId, runId)
        cleanupComplete = stopped && deleted.deleted
      } catch { cleanupComplete = false }
      try {
        const ledger = await options.store.getRunLedgerUsage(tenantId, runId)
        if (configuration.learning && callsUsed > 0 && (!ledger || ledger.invocationCount < callsUsed)) {
          cleanupComplete = false
        }
        invocationCount = ledger?.invocationCount ?? 0
        unresolvedCount = ledger?.unresolvedCount ?? 0
        usage = { inputTokens: ledger?.usage.inputTokens ?? 0, outputTokens: ledger?.usage.outputTokens ?? 0 }
      } catch { cleanupComplete = false }
    } else cleanupComplete = stopped
    try {
      profileStateUnchanged = !!initialState && sameState(initialState, await options.profiles.readState())
      if (configuration.learning && snapshot && profileStateUnchanged) {
        const current = await options.profiles.getSnapshot(snapshot.id)
        profileStateUnchanged = !!current && !current.revoked && current.id === initialState?.profileId
          && sha256(canonicalizeJson(current.settings)) === snapshotSettingsHash
        if (current) privateValues = [...privateValues, current.settings.apiKey, current.settings.baseUrl]
          .filter((value): value is string => !!value)
      }
    } catch { profileStateUnchanged = false }
    if (containsPrivateText(artifacts, privateValues)) { artifacts = {}; reason = 'result_not_safe'; outcome = 'failed' }
    if (outcome === 'passed' && (!cleanupComplete || !profileStateUnchanged || unresolvedCount > 0
      || !evidenceValidated || !configuration.kinds.every((kind) => !!artifacts[kind]))) {
      outcome = configuration.learning ? 'partial' : 'failed'
      reason = profileStateUnchanged ? 'operation_failed' : 'profile_changed'
    }
    return { version: 1, notProductionAttestation: true, outcome,
      ...(reason ? { reason } : {}), callsUsed, evidenceValidated,
      sample: { hash: sampleHash, characters: configuration.sample.length },
      ...(runId ? { runId, tenantId } : {}), profileStateUnchanged, cleanupComplete, pricingKnown: false,
      invocationCount, unresolvedCount, usage, artifacts, failures }
  }
}
