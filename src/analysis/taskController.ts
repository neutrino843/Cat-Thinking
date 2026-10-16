import {
  ANALYSIS_LIMITS, analysisOptionsSchema, analysisRequestSchema, canonicalizeJson, validateArtifactAgainstManifest,
  type AnalysisOptionsV1, type AnalysisRunV1, type ArtifactKind, type EngineCapabilitiesV1, type RunUsageV1, type SourceRangeV1,
} from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'
import { AnalysisClientError, type AnalysisEngineClient } from './engineClient'
import { applyAnalysisEvent, createRunMirror, markConnectionLost, reconcileRunSnapshot, type AnalysisRunMirror } from './eventReducer'
import { createAnalysisRequestKey, createSourceSnapshot } from './fingerprint'
import { artifactContentHash } from './localArtifactIdentity'
import { artifactDependencyClosure, DEFAULT_ANALYSIS_OPTIONS } from './artifactRegistry'
import { sourcePartRanges, sourceUploadPart } from './sourceUpload'
import type { AnalysisArtifactIdentityUpdate, AnalysisTaskRepository, StoredAnalysisTask } from './taskPersistence'

export const SUMMARY_OUTLINE_OPTIONS = DEFAULT_ANALYSIS_OPTIONS
const TERMINAL = new Set(['partial', 'succeeded', 'cancelled', 'failed', 'expired'])
export const isAnalysisTerminal = (run: AnalysisRunV1): boolean => TERMINAL.has(run.status)
interface ArtifactReadError { message: string; retryable: boolean }
class ProfileSelectionChangedError extends Error {}
class SelectedSourceLimitError extends Error {
  constructor(readonly maximum: number) { super('selected_source_limit'); this.name = 'SelectedSourceLimitError' }
}

export interface AnalysisTaskState {
  loading: boolean
  busy: boolean
  capabilities?: EngineCapabilitiesV1
  sources: SourceDocument[]
  task?: StoredAnalysisTask
  run?: AnalysisRunV1
  mirror?: AnalysisRunMirror
  sourceChanged: boolean
  artifactReadErrors: Partial<Record<ArtifactKind, ArtifactReadError>>
  usage?: RunUsageV1
  usageError?: string
  usageRetryable?: boolean
  error?: string
}

export function analysisActionError(error: unknown): string {
  if (error instanceof SelectedSourceLimitError) return `本次选择超过 ${error.maximum.toLocaleString('zh-CN')} 个字符。请缩小分析范围或减少原文数量。`
  if (error instanceof ProfileSelectionChangedError) return '所选模型已改变。这次任务会保留原来的模型和结果；请先结束旧分析，再用当前模型开始新分析。'
  if (error instanceof AnalysisClientError) {
    if (error.status === 404 || error.status === 410) return '任务已删除或过期，可清除本地关联后重新选择原文。'
    if (error.code === 'conflict') return '任务状态已改变，已重新读取状态；请检查后再操作。'
    if (error.code === 'unauthorized' || error.code === 'forbidden') return '分析服务拒绝访问，请检查本机服务配置。'
    if (error.code === 'invalid_response' || error.code === 'response_too_large') return '服务响应未通过校验，已停止恢复。'
    if (error.code === 'service_unavailable') return '分析服务尚未开放或连接中断。已有任务可稍后恢复查看。'
    return '操作被服务拒绝，请检查任务状态后再操作。'
  }
  return '连接或本地存储失败，操作结果可能尚未确认。请恢复查看，避免重复发起。'
}
const canReadAgain = (error: unknown) => !(error instanceof AnalysisClientError) || error.retryable
/** eventBatch 定时器轮转哨兵：仅表示本轮 5 秒订阅到期，不代表连接失败，不得触发轮询降级。 */
const STREAM_ROTATED = new Error('analysis event stream rotated')
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return }
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true })
})
const sameBinding = (a?: StoredAnalysisTask, b?: StoredAnalysisTask) =>
  a?.request.requestKey === b?.request.requestKey && a?.runId === b?.runId

/** Single lifecycle for all five artifacts. Automatic retries perform reads only. */
export class AnalysisTaskController {
  private state: AnalysisTaskState = { loading: true, busy: false, sources: [], sourceChanged: false, artifactReadErrors: {} }
  private listeners = new Set<() => void>()
  private lifetime?: AbortController
  private binding = new AbortController()
  private watcher?: AbortController
  private operation?: Promise<void>
  private reads: Promise<void> = Promise.resolve()
  private unsubscribe?: () => void
  private readonly origin = crypto.randomUUID()
  private lastFocusedRead = 0
  constructor(readonly docId: string, private readonly client: AnalysisEngineClient, private readonly repository: AnalysisTaskRepository) {}
  getSnapshot = (): AnalysisTaskState => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<AnalysisTaskState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private requireSignal(): AbortSignal {
    if (!this.lifetime || this.lifetime.signal.aborted) throw new Error('Analysis view is disconnected')
    return AbortSignal.any([this.lifetime.signal, this.binding.signal])
  }
  private assertCurrentProvider(task: StoredAnalysisTask, capabilities: EngineCapabilitiesV1): void {
    if (task.request.providerProfileId !== capabilities.activeProfileId) {
      throw new ProfileSelectionChangedError()
    }
  }
  private async save(task: StoredAnalysisTask, signal: AbortSignal, identityUpdate?: AnalysisArtifactIdentityUpdate): Promise<StoredAnalysisTask> {
    signal.throwIfAborted()
    const stored = await this.repository.save(task, this.origin, identityUpdate)
    signal.throwIfAborted()
    const saved = stored ?? task
    this.publish({ task: saved })
    return saved
  }
  connect(): () => void {
    this.disconnect()
    const lifetime = new AbortController()
    this.lifetime = lifetime
    this.binding = new AbortController()
    this.publish({ loading: true, busy: !!this.operation, task: undefined, run: undefined, mirror: undefined,
      usage: undefined, sourceChanged: false, error: undefined, artifactReadErrors: {}, usageError: undefined, usageRetryable: false })
    this.unsubscribe = this.repository.subscribe?.(this.docId, (change) => {
      if (change.origin === this.origin) return
      this.invalidateBinding()
      void this.initialize(this.requireSignal(), false)
    })
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onFocus)
      document.addEventListener('visibilitychange', this.onFocus)
    }
    void this.initialize(this.requireSignal(), false)
    return () => { if (this.lifetime === lifetime) this.disconnect() }
  }
  disconnect() {
    this.lifetime?.abort(); this.binding.abort(); this.watcher?.abort(); this.unsubscribe?.(); this.unsubscribe = undefined
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onFocus)
      document.removeEventListener('visibilitychange', this.onFocus)
    }
  }
  private invalidateBinding() {
    this.binding.abort(); this.watcher?.abort(); this.binding = new AbortController()
    this.publish({ loading: true, task: undefined, run: undefined, mirror: undefined, usage: undefined,
      artifactReadErrors: {}, sourceChanged: false, error: undefined, usageError: undefined, usageRetryable: false })
  }
  private onFocus = () => {
    if (document.visibilityState === 'hidden' || this.operation || Date.now() - this.lastFocusedRead < 2_000) return
    this.lastFocusedRead = Date.now()
    void this.recheckBinding()
  }
  private async recheckBinding() {
    const signal = this.requireSignal()
    try {
      const stored = await this.repository.load(this.docId)
      signal.throwIfAborted()
      if (!sameBinding(stored, this.state.task)) {
        this.invalidateBinding()
        await this.initialize(this.requireSignal(), false)
      } else if (stored?.runId && !this.operation) { await this.refresh(signal); this.watch() }
    } catch (error) { if (!signal.aborted) this.publish({ error: analysisActionError(error) }) }
  }
  async checkService(): Promise<void> {
    const signal = this.requireSignal()
    try {
      const capabilities = await this.client.capabilities(signal)
      signal.throwIfAborted()
      this.publish({ capabilities, error: undefined })
      await this.recheckBinding()
    } catch (error) { if (!signal.aborted) this.publish({ capabilities: undefined, error: analysisActionError(error) }) }
  }
  private async initialize(signal: AbortSignal, resumeReceiving: boolean) {
    try {
      const [sources, task] = await Promise.all([this.repository.sources(this.docId), this.repository.load(this.docId)])
      signal.throwIfAborted()
      this.publish({ sources, task })
      try {
        const capabilities = await this.client.capabilities(signal)
        signal.throwIfAborted(); this.publish({ capabilities })
      } catch (error) { if (signal.aborted) throw error; this.publish({ capabilities: undefined, error: analysisActionError(error) }) }
      if (task?.runId) {
        await this.refresh(signal)
        if (resumeReceiving && this.state.run?.status === 'receiving' && !this.state.sourceChanged && this.state.capabilities?.acceptsRuns) {
          await this.action(() => this.uploadAndStart(this.requireSignal()))
        }
      } else if (task) {
        const sourceChanged = !await this.sourcesMatch(task, sources)
        signal.throwIfAborted(); this.publish({ sourceChanged })
      }
    } catch (error) { if (!signal.aborted) this.publish({ error: analysisActionError(error) }) }
    finally { if (!signal.aborted) { this.publish({ loading: false }); this.watch() } }
  }
  private async sourcesMatch(task: StoredAnalysisTask, sources: SourceDocument[]): Promise<boolean> {
    for (const snapshot of task.request.manifest.sources) {
      const source = sources.find((s) => s.id === snapshot.sourceId && s.docId === this.docId)
      if (!source) return false
      try { if (canonicalizeJson(await createSourceSnapshot(source, snapshot.selectedRange)) !== canonicalizeJson(snapshot)) return false }
      catch { return false }
    }
    return true
  }
  private assertRunIdentity(run: AnalysisRunV1, task: StoredAnalysisTask) {
    if (run.id !== task.runId || run.docId !== this.docId || run.requestKey !== task.request.requestKey
      || canonicalizeJson(run.request) !== canonicalizeJson(task.request)) throw new AnalysisClientError('invalid_response', 'Task identity mismatch', false)
  }
  private refresh(signal: AbortSignal): Promise<void> {
    const read = this.reads.catch(() => {}).then(() => this.refreshSnapshot(signal))
    this.reads = read
    return read
  }
  private async refreshSnapshot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const task = this.state.task
    if (!task?.runId) return
    let run: AnalysisRunV1
    let sources: SourceDocument[]
    try {
      ;[run, sources] = await Promise.all([this.client.getRun(task.runId, signal), this.repository.sources(this.docId)])
    } catch (error) {
      if (!signal.aborted && error instanceof AnalysisClientError && (error.status === 404 || error.status === 410)) {
        this.publish({ mirror: undefined, run: this.state.run && { ...this.state.run, status: 'expired' }, artifactReadErrors: {} })
        const canonical = await this.save({ ...task, artifactIdentities: {}, updatedAt: Date.now() }, signal, { expected: task.artifactIdentities })
        if (Object.keys(canonical.artifactIdentities ?? {}).length > 0) await this.save({ ...canonical, artifactIdentities: {} }, signal, { expected: canonical.artifactIdentities })
      }
      throw error
    }
    signal.throwIfAborted()
    this.assertRunIdentity(run, task)
    if (run.revision < task.revision) throw new AnalysisClientError('conflict', 'Stale run snapshot', true)
    const sourceChanged = !await this.sourcesMatch(task, sources)
    signal.throwIfAborted()
    const previous = reconcileRunSnapshot(this.state.mirror ?? createRunMirror(run.id), run)
    const mirror = { ...previous, artifacts: { ...previous.artifacts } }
    const identities: StoredAnalysisTask['artifactIdentities'] = {}
    for (const kind of run.request.artifacts) {
      const state = run.artifactStates[kind]
      if (sourceChanged || run.status === 'expired' || state?.status !== 'succeeded') delete mirror.artifacts[kind]
      else {
        if (mirror.artifacts[kind]?.id !== state.artifactId) delete mirror.artifacts[kind]
        const identity = task.artifactIdentities?.[kind]
        if (identity && identity.artifactId === state.artifactId && identity.attempt === state.attempt) identities[kind] = identity
      }
    }
    this.publish({ run, sources, sourceChanged, mirror, artifactReadErrors: {} })
    let saved = await this.save({ ...task, revision: run.revision, artifactIdentities: identities, updatedAt: Date.now() }, signal, { expected: task.artifactIdentities })
    if (sourceChanged || run.status === 'expired') {
      if (Object.keys(saved.artifactIdentities ?? {}).length > 0) saved = await this.save({ ...saved, artifactIdentities: {} }, signal, { expected: saved.artifactIdentities })
    } else {
      for (const [kind, identity] of Object.entries(saved.artifactIdentities ?? {})) {
        const artifactState = run.artifactStates[kind as ArtifactKind]
        if (artifactState?.status === 'succeeded' && artifactState.artifactId === identity.artifactId && artifactState.attempt === identity.attempt) identities[kind as ArtifactKind] = identity
      }
    }
    const usageRead = this.client.getUsage(run.id, signal).then((usage) => {
      signal.throwIfAborted()
      if (usage.runId !== run.id) throw new AnalysisClientError('invalid_response', 'Usage identity mismatch', false)
      this.publish({ usage, usageError: undefined, usageRetryable: false })
    }).catch((error: unknown) => { if (!signal.aborted) this.publish({ usage: undefined, usageError: analysisActionError(error), usageRetryable: canReadAgain(error) }) })
    if (!sourceChanged && run.status !== 'expired') {
      await Promise.all(run.request.artifacts.map(async (kind) => {
        const artifactState = run.artifactStates[kind]
        if (artifactState?.status !== 'succeeded') return
        try {
          const artifact = mirror.artifacts[kind] ?? await this.client.getArtifact(run.id, kind, signal)
          signal.throwIfAborted()
          const expectedHashes = task.request.manifest.sources.map((s) => s.contentHash).sort()
          if (artifact.id !== artifactState.artifactId || artifact.runId !== run.id || artifact.kind !== kind || artifact.docId !== this.docId
            || canonicalizeJson([...artifact.sourceContentHashes].sort()) !== canonicalizeJson(expectedHashes)
            || validateArtifactAgainstManifest(artifact, task.request.manifest).length > 0) {
            throw new AnalysisClientError('invalid_response', 'Artifact source mismatch', false)
          }
          const contentHash = mirror.artifacts[kind] ? identities[kind]?.contentHash ?? await artifactContentHash(artifact) : await artifactContentHash(artifact)
          if (identities[kind]?.contentHash && identities[kind]?.contentHash !== contentHash) {
            throw new AnalysisClientError('invalid_response', 'Artifact content changed without a new identity', false)
          }
          signal.throwIfAborted()
          identities[kind] = { artifactId: artifact.id, attempt: artifactState.attempt,
            runRevision: identities[kind]?.runRevision ?? run.revision, contentHash }
          const current = this.state.mirror ?? mirror
          this.publish({ mirror: { ...current, artifacts: { ...current.artifacts, [kind]: artifact } } })
        } catch (error) {
          if (signal.aborted) return
          if (!canReadAgain(error)) delete identities[kind]
          const current = this.state.mirror ?? mirror
          const artifacts = { ...current.artifacts }; delete artifacts[kind]
          this.publish({ mirror: { ...current, artifacts }, artifactReadErrors: { ...this.state.artifactReadErrors,
            [kind]: { message: analysisActionError(error), retryable: canReadAgain(error) } },
            ...(canReadAgain(error) ? {} : { error: analysisActionError(error) }) })
        }
      }))
      signal.throwIfAborted()
      await this.save({ ...saved, artifactIdentities: identities, updatedAt: Date.now() }, signal, { expected: saved.artifactIdentities })
    }
    await usageRead
    signal.throwIfAborted()
  }
  private action(work: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation
    const signal = this.requireSignal()
    this.publish({ busy: true, error: undefined })
    const execute = async () => {
      if (typeof navigator === 'undefined' || !navigator.locks) throw new AnalysisClientError('request_failed', 'Browser lacks task mutation locks', false)
      await navigator.locks.request(`cat-analysis:${this.docId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        signal.throwIfAborted()
        if (!lock) throw new AnalysisClientError('conflict', 'Another tab owns task mutation', false)
        const stored = await this.repository.load(this.docId)
        signal.throwIfAborted()
        if (!sameBinding(stored, this.state.task)) {
          this.invalidateBinding(); await this.initialize(this.requireSignal(), false)
          this.publish({ error: analysisActionError(new AnalysisClientError('conflict', 'Task binding changed in another tab', false)) })
          return
        }
        await work()
      })
    }
    const operation = execute().catch(async (error: unknown) => {
      if (signal.aborted) return
      if (error instanceof AnalysisClientError && error.code === 'conflict') await this.refresh(signal).catch(() => {})
      if (!signal.aborted) this.publish({ error: analysisActionError(error) })
    }).finally(() => {
      if (this.operation !== operation) return
      this.operation = undefined
      if (this.lifetime && !this.lifetime.signal.aborted) { this.publish({ busy: false }); this.watch() }
    })
    this.operation = operation
    return operation
  }
  create(sourceIds: string[], selectedKinds: ArtifactKind[], ranges: Record<string, SourceRangeV1> = {}, options: AnalysisOptionsV1 = DEFAULT_ANALYSIS_OPTIONS): Promise<void> {
    return this.action(async () => {
      const signal = this.requireSignal()
      this.watcher?.abort()
      const capabilities = await this.client.capabilities(signal)
      signal.throwIfAborted(); this.publish({ capabilities })
      if (!capabilities.acceptsRuns) throw new AnalysisClientError('service_unavailable', 'Admission closed', false)
      if (this.state.task) throw new AnalysisClientError('conflict', 'Existing task must be resolved first', false)
      const artifacts = artifactDependencyClosure(selectedKinds)
      const parsedOptions = analysisOptionsSchema.parse(options)
      if (parsedOptions.externalKnowledge) throw new AnalysisClientError('request_failed', 'External knowledge unsupported', false)
      const sources = await this.repository.sources(this.docId)
      const selected = sources.filter((s) => sourceIds.includes(s.id))
      if (!artifacts.length || selected.length !== new Set(sourceIds).size || !selected.length || selected.length > capabilities.maxSourcesPerRun
        || selected.some((s) => s.charCount > capabilities.maxSourceCharacters || s.text.length !== s.charCount || !s.text.length)
        || artifacts.some((kind) => !capabilities.artifactKinds.includes(kind))) throw new AnalysisClientError('request_failed', 'Unsupported input', false)
      const snapshots = await Promise.all(selected.map((s) => createSourceSnapshot(s, ranges[s.id])))
      const selectedCharacters = snapshots.reduce((total, snapshot) => total + (snapshot.selectedRange
        ? snapshot.selectedRange.end - snapshot.selectedRange.start : snapshot.charCount), 0)
      if (capabilities.maxSelectedCharacters !== undefined && selectedCharacters > capabilities.maxSelectedCharacters) {
        throw new SelectedSourceLimitError(capabilities.maxSelectedCharacters)
      }
      const requestKey = await createAnalysisRequestKey({ docId: this.docId, sources: snapshots, artifacts,
        options: parsedOptions, engineCapabilityVersion: capabilities.serviceVersion, intentId: crypto.randomUUID(),
        providerProfileId: capabilities.activeProfileId })
      const request = analysisRequestSchema.parse({ version: 1, requestKey, docId: this.docId,
        manifest: { version: 1, sources: snapshots }, artifacts, options: parsedOptions,
        ...(capabilities.activeProfileId === undefined ? {} : { providerProfileId: capabilities.activeProfileId }) })
      const task: StoredAnalysisTask = { version: 1, docId: this.docId, request, partBytes: Math.min(128_000, capabilities.maxUploadPartBytes, ANALYSIS_LIMITS.maxUploadPartBytes),
        uploadedParts: {}, revision: 0, lastSequence: -1, updatedAt: Date.now() }
      await this.save(task, signal)
      await this.submitPending(signal, false)
    })
  }
  /** Reconcile by key before checking source text or admission. Only explicit resume can recreate an absent intent. */
  resume(): Promise<void> {
    return this.action(async () => {
      const signal = this.requireSignal()
      this.watcher?.abort()
      if (!this.state.task?.runId) await this.submitPending(signal, true)
      else {
        await this.refresh(signal)
        if (this.state.run?.status === 'receiving' && !this.state.sourceChanged && this.state.capabilities?.acceptsRuns) await this.uploadAndStart(signal)
      }
    })
  }
  private async submitPending(signal: AbortSignal, reconcile: boolean) {
    const task = this.state.task
    if (!task || task.runId) return
    if (reconcile) {
      const lookup = await this.client.lookupRequest(task.request.requestKey, signal)
      signal.throwIfAborted()
      if (lookup.status === 'abandoned') {
        await this.repository.remove(this.docId, task.request.requestKey, this.origin)
        signal.throwIfAborted(); this.publish({ task: undefined, run: undefined, mirror: undefined, sourceChanged: false })
        return
      }
      if (lookup.status === 'found') {
        this.assertRunIdentity(lookup.run, { ...task, runId: lookup.run.id })
        await this.save({ ...task, runId: lookup.run.id, revision: lookup.run.revision, updatedAt: Date.now() }, signal)
        await this.refresh(signal)
        if (this.state.run?.status === 'receiving' && !this.state.sourceChanged && this.state.capabilities?.acceptsRuns) await this.uploadAndStart(signal)
        return
      }
    }
    const capabilities = await this.client.capabilities(signal)
    signal.throwIfAborted(); this.publish({ capabilities })
    if (!capabilities.acceptsRuns) throw new AnalysisClientError('service_unavailable', 'Admission closed', false)
    this.assertCurrentProvider(task, capabilities)
    const sources = await this.repository.sources(this.docId)
    const matches = await this.sourcesMatch(task, sources)
    signal.throwIfAborted()
    if (!matches) { this.publish({ sources, sourceChanged: true }); throw new AnalysisClientError('conflict', 'Source changed', false) }
    const result = await this.client.createRun(task.request, signal)
    signal.throwIfAborted()
    this.assertRunIdentity(result.run, { ...task, runId: result.run.id })
    await this.save({ ...task, runId: result.run.id, revision: result.run.revision, updatedAt: Date.now() }, signal)
    this.publish({ run: result.run, mirror: reconcileRunSnapshot(createRunMirror(result.run.id), result.run) })
    if (result.run.status === 'receiving') await this.uploadAndStart(signal)
    else await this.refresh(signal)
  }
  private async uploadAndStart(signal: AbortSignal) {
    let task = this.state.task
    if (!task?.runId) return
    const runId = task.runId
    const capabilities = await this.client.capabilities(signal)
    signal.throwIfAborted(); this.publish({ capabilities })
    if (!capabilities.acceptsRuns) throw new AnalysisClientError('service_unavailable', 'Admission closed', false)
    this.assertCurrentProvider(task, capabilities)
    const sources = await this.repository.sources(this.docId)
    const matches = await this.sourcesMatch(task, sources)
    signal.throwIfAborted()
    if (!matches) { this.publish({ sources, sourceChanged: true }); throw new AnalysisClientError('conflict', 'Source changed', false) }
    for (const snapshot of task.request.manifest.sources) {
      const source = sources.find((s) => s.id === snapshot.sourceId)
      if (!source) throw new Error('Source missing')
      const ranges = sourcePartRanges(source.text, task.partBytes)
      for (let index = 0; index < ranges.length; index++) {
        signal.throwIfAborted()
        const part = await sourceUploadPart(snapshot, source.text, task.partBytes, index, ranges)
        const receipt = await this.client.uploadSource(runId, part, signal)
        signal.throwIfAborted()
        if (receipt.sourceId !== snapshot.sourceId || receipt.partCount !== ranges.length
          || receipt.complete && receipt.computedHash !== snapshot.contentHash) throw new AnalysisClientError('invalid_response', 'Upload receipt mismatch', false)
        task = await this.save({ ...task, uploadedParts: { ...task.uploadedParts, [snapshot.sourceId]: receipt.receivedParts }, updatedAt: Date.now() }, signal)
      }
    }
    await this.refresh(signal)
    if (this.state.run?.status === 'receiving') await this.client.startRun(runId, this.state.run.revision, signal)
    await this.refresh(signal)
  }
  cancel(): Promise<void> { return this.mutate('cancel') }
  retry(kind: ArtifactKind): Promise<void> { return this.mutate('retry', kind) }
  private mutate(operation: 'cancel' | 'retry', kind?: ArtifactKind): Promise<void> {
    return this.action(async () => {
      const signal = this.requireSignal(); this.watcher?.abort(); await this.refresh(signal)
      const run = this.state.run
      if (!run) return
      if (operation === 'cancel') await this.client.cancel(run.id, run.revision, signal)
      else if (kind) {
        const capabilities = await this.client.capabilities(signal)
        signal.throwIfAborted(); this.publish({ capabilities })
        if (!capabilities.acceptsRuns || this.state.sourceChanged || run.artifactStates[kind]?.error?.retryable !== true) throw new AnalysisClientError('request_failed', 'Retry unavailable', false)
        if (this.state.task) this.assertCurrentProvider(this.state.task, capabilities)
        await this.client.retryArtifact(run.id, kind, run.revision, signal)
      }
      await this.refresh(signal)
    })
  }
  deleteContent(): Promise<void> {
    return this.action(async () => {
      const signal = this.requireSignal(); this.watcher?.abort()
      const task = this.state.task
      if (!task) return
      if (task.runId) {
        const run = await this.client.getRun(task.runId, signal)
        this.assertRunIdentity(run, task)
        if (!isAnalysisTerminal(run)) await this.client.cancel(run.id, run.revision, signal)
        const result = await this.client.deleteContent(task.runId, signal)
        if (result.runId !== task.runId) throw new AnalysisClientError('invalid_response', 'Deletion unconfirmed', false)
      } else {
        const result = await this.client.abandonRequest(task.request.requestKey, signal)
        if (result.requestKey !== task.request.requestKey || !result.abandoned) throw new AnalysisClientError('invalid_response', 'Abandonment unconfirmed', false)
      }
      signal.throwIfAborted()
      await this.repository.remove(this.docId, task.request.requestKey, this.origin)
      signal.throwIfAborted()
      this.publish({ task: undefined, run: undefined, mirror: undefined, usage: undefined, artifactReadErrors: {}, sourceChanged: false })
    })
  }
  forgetExpired(): Promise<void> {
    return this.action(async () => {
      const signal = this.requireSignal()
      const task = this.state.task
      if (!task?.runId) throw new AnalysisClientError('request_failed', 'Unconfirmed create must be abandoned', false)
      try {
        const run = await this.client.getRun(task.runId, signal)
        this.assertRunIdentity(run, task)
        if (run.status !== 'expired') throw new AnalysisClientError('request_failed', 'Content still retained', false)
      } catch (error) {
        if (!(error instanceof AnalysisClientError && (error.status === 404 || error.status === 410))) throw error
      }
      this.watcher?.abort()
      await this.repository.remove(this.docId, task.request.requestKey, this.origin)
      signal.throwIfAborted()
      this.publish({ task: undefined, run: undefined, mirror: undefined, usage: undefined, sourceChanged: false, artifactReadErrors: {} })
    })
  }
  private hasRetryableReads() { return this.state.usageRetryable === true || Object.values(this.state.artifactReadErrors).some((error) => error?.retryable) }
  private watch() {
    this.watcher?.abort()
    const task = this.state.task
    if (!this.lifetime || this.lifetime.signal.aborted || !task?.runId || this.state.sourceChanged
      || this.state.run && (this.state.run.status === 'receiving' || isAnalysisTerminal(this.state.run) && !this.hasRetryableReads())) return
    const lifetime = this.requireSignal()
    const watcher = new AbortController(); this.watcher = watcher
    const abort = () => watcher.abort()
    lifetime.addEventListener('abort', abort, { once: true })
    void this.watchReadOnly(task.runId, watcher.signal).finally(() => lifetime.removeEventListener('abort', abort))
  }
  /** Rotate streams so a silent/broken SSE connection cannot hide terminal state.
   * A failed stream falls back to bounded, read-only snapshot polling.
   * 定时器轮转不是连接失败：以 STREAM_ROTATED 哨兵结束本轮，watchReadOnly 捕获后继续下一轮流订阅。 */
  private async *eventBatch(runId: string, signal: AbortSignal) {
    const batch = new AbortController()
    const streamSignal = AbortSignal.any([signal, batch.signal])
    const timer = setTimeout(() => batch.abort(), 5_000)
    try {
      yield* this.client.events(runId, { signal: streamSignal, lastEventId: this.state.task?.lastEventId })
    } catch (error) {
      if (signal.aborted || !batch.signal.aborted) throw error
      throw STREAM_ROTATED
    } finally { clearTimeout(timer); batch.abort() }
  }
  private async watchReadOnly(runId: string, signal: AbortSignal) {
    let failures = 0
    let pollingOnly = this.state.capabilities?.supportsSse === false
    let readError: string | undefined
    while (!signal.aborted) {
      try {
        if (pollingOnly || this.state.run && isAnalysisTerminal(this.state.run)) await delay(pollingOnly ? 2_000 : Math.min(500 * 2 ** failures, 8_000), signal)
        await this.refresh(signal)
        if (readError && this.state.error === readError) this.publish({ error: undefined })
        readError = undefined
        let lastRefreshAt = Date.now()
        if (this.state.sourceChanged) return
        if (this.state.run && isAnalysisTerminal(this.state.run)) {
          if (!this.hasRetryableReads() || ++failures >= 5) return
          continue
        }
        if (pollingOnly) { failures = 0; continue }
        let rotated = false
        try {
          for await (const event of this.eventBatch(runId, signal)) {
            signal.throwIfAborted()
            const reduction = applyAnalysisEvent(this.state.mirror ?? createRunMirror(runId), event)
            if (!reduction.accepted) continue
            this.publish({ mirror: reduction.state })
            if (['artifact.ready', 'artifact.failed', 'run.completed', 'run.cancelled', 'run.failed', 'run.expired'].includes(event.type) || Date.now() - lastRefreshAt >= 5_000) {
              await this.refresh(signal); lastRefreshAt = Date.now()
            }
            const task = this.state.task
            if (task) await this.save({ ...task, lastEventId: event.eventId, lastSequence: event.sequence, updatedAt: Date.now() }, signal)
            if (this.state.run && isAnalysisTerminal(this.state.run)) {
              if (!this.hasRetryableReads()) return
              break
            }
            failures = 0
          }
        } catch (error) {
          if (error !== STREAM_ROTATED) throw error
          rotated = true
        }
        if (!this.state.run || !isAnalysisTerminal(this.state.run)) {
          // 每轮到期都做一次快照核对（轮转的目的），但只有真实流结束才降级轮询。
          await this.refresh(signal)
          // Snapshot reads remain available even when the stream closes early.
          if (!rotated && (!this.state.run || !isAnalysisTerminal(this.state.run))) pollingOnly = true
        }
      } catch (error) {
        if (signal.aborted) return
        pollingOnly = true
        readError = analysisActionError(error)
        this.publish({ mirror: this.state.mirror && markConnectionLost(this.state.mirror), error: readError })
        if (!canReadAgain(error) || ++failures >= 5) return
        await delay(Math.min(500 * 2 ** failures, 8_000), signal).catch(() => {})
      }
    }
  }
}
