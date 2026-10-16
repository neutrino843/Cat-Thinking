import { inferProviderProtocolFromUrl, personalProviderModelsInputSchema, personalProviderStatusSchema, type PersonalProviderModelsInput, type PersonalProviderSettingsInput, type PersonalProviderStatus } from '@cat-thinking/analysis-contracts'
import type { AnalysisServiceConfig } from '../config.js'
import type { JobStore } from '../domain/jobStore.js'
import { JobStoreConflictError } from '../domain/jobStore.js'
import { PersistentDispatcher } from '../domain/persistentDispatcher.js'
import { RunService, isTerminalRun } from '../domain/runService.js'
import type { EngineAvailability } from '../domain/capabilities.js'
import { createAnalysisProviderRuntime } from '../providers/analysisProviderRuntime.js'
import { createPersonalModelProvider, PERSONAL_PROVIDER_LIMITS } from '../providers/personalModelProvider.js'
import { fetchProviderModels, normalizeProviderBaseUrl, ProviderConnectionError } from '../providers/providerConnection.js'
import { ServiceHttpError, createContractError } from '../errors.js'
import type { FetchImplementation } from '../providers/openAICompatibleProvider.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError, storedPersonalSettingsSchema, type PersonalProfileState, type PersonalProfileStore } from './profileStore.js'

export const unavailablePersonalStatus = (): PersonalProviderStatus => personalProviderStatusSchema.parse({
  version: 1, revision: 0, available: false, enabled: false, configured: false, hasApiKey: false,
  checkState: 'unchecked', acceptsRuns: false, pricingKnown: false, limits: PERSONAL_PROVIDER_LIMITS,
})

/** Personal authorization is separate from production release evidence. */
export class PersonalAnalysisRuntime {
  readonly runService: RunService
  readonly runStore: JobStore
  private dispatcher?: PersistentDispatcher
  private stopping = false
  private faulted = false
  private mutation: Promise<void> = Promise.resolve()
  private checkingRevision?: number
  private lastCheckMessage?: string
  constructor(private readonly options: { config: AnalysisServiceConfig; store: JobStore; profiles: PersonalProfileStore;
    fetchImplementation?: FetchImplementation; onError?: (error: unknown) => void }) {
    if (options.config.operatingMode !== 'personal') throw new PersonalProfileUnavailableError()
    this.runStore = new Proxy(options.store, {
      get: (target, property) => {
        if (property === 'createRun') return async (...args: Parameters<JobStore['createRun']>) => {
          const state = await options.profiles.readState()
          const request = args[1].request
          if (request.providerProfileId !== state.profileId) throw new JobStoreConflictError('personal profile changed')
          const characters = request.manifest.sources.reduce((total, source) => total
            + (source.selectedRange ? source.selectedRange.end - source.selectedRange.start : source.charCount), 0)
          if (characters > PERSONAL_PROVIDER_LIMITS.maxInputCharacters) throw new ServiceHttpError(400,
            createContractError('source_too_large', 'budget', false, 'analysis.personal.source_too_large',
              { actual: characters, maximum: PERSONAL_PROVIDER_LIMITS.maxInputCharacters }))
          return options.profiles.createRun(...args)
        }
        if (property === 'listDispatchableRuns') return options.profiles.listDispatchableRuns.bind(options.profiles)
        if (property === 'listExpiredRuns') return options.profiles.listExpiredRuns.bind(options.profiles)
        if (property === 'reserveProviderInvocation') return async (...args: Parameters<JobStore['reserveProviderInvocation']>) => {
          const input = args[0]
          const snapshot = await options.profiles.getRunSnapshot(input.tenantId, input.runId)
          if (!snapshot || snapshot.revoked || !await this.canInvoke(snapshot.id)) throw new PersonalProfileUnavailableError()
          if (input.profileVersion !== snapshot.id || input.modelId !== snapshot.settings.modelId) throw new JobStoreConflictError('personal profile changed')
          return target.reserveProviderInvocation(...args)
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.runService = new RunService({ store: this.runStore, retentionSeconds: options.config.retentionSeconds,
      providerProfileMode: 'personal', maxRunEstimatedTokens: PERSONAL_PROVIDER_LIMITS.maxRunTokens,
      maxRunEstimatedCostMicros: 0, canAdmit: () => this.canAdmit() })
  }
  async initialize(): Promise<void> {
    if (this.options.config.personalReadOnly) return
    const state = await this.options.profiles.readState()
    await this.cancelBoundRuns(state.enabled ? state.profileId : undefined)
    await this.options.profiles.revokeHistoricSecrets(state.profileId)
    if (state.enabled) await this.startDispatcher(state)
  }
  async status(): Promise<PersonalProviderStatus> {
    const state = await this.options.profiles.readState()
    const snapshot = state.profileId ? await this.options.profiles.getSnapshot(state.profileId) : undefined
    return personalProviderStatusSchema.parse({
      version: 1, revision: state.revision, available: true, enabled: state.enabled, configured: !!snapshot && !snapshot.revoked,
      hasApiKey: !!snapshot?.settings.apiKey,
      ...(snapshot ? this.publicSettings(snapshot.settings) : {}),
      checkState: this.checkingRevision === state.revision ? 'checking' : state.checkState === 'unsupported' ? 'unchecked' : state.checkState,
      messageKey: state.checkState === 'unsupported' ? 'analysis.personal.models_not_supported'
        : state.checkState === 'failed' ? this.lastCheckMessage ?? 'analysis.personal.connection_failed' : undefined,
      acceptsRuns: await this.canAdmit(), pricingKnown: false, limits: PERSONAL_PROVIDER_LIMITS,
    })
  }
  async availability(): Promise<EngineAvailability> {
    const closed = { jobStoreReady: false, providerReady: false, dispatcherReady: false, usageReady: false,
      recoveryReady: false, personalAuthorized: false, maxSelectedCharacters: PERSONAL_PROVIDER_LIMITS.maxInputCharacters }
    try {
      if (!await this.health()) return closed
      const state = await this.options.profiles.readState()
      const snapshot = state.profileId ? await this.options.profiles.getSnapshot(state.profileId) : undefined
      return { jobStoreReady: true, providerReady: !!snapshot && !snapshot.revoked, dispatcherReady: this.dispatcher?.isReady() ?? false,
        usageReady: true, recoveryReady: true, personalAuthorized: state.enabled && !this.options.config.personalReadOnly && !this.stopping && !this.faulted,
        activeProfileId: snapshot?.id, modelId: snapshot?.settings.modelId,
        maxSelectedCharacters: PERSONAL_PROVIDER_LIMITS.maxInputCharacters }
    } catch { return closed }
  }
  async save(input: PersonalProviderSettingsInput): Promise<PersonalProviderStatus> {
    this.assertWritable()
    return this.serialize(async () => {
      const state = await this.expectRevision(input.expectedRevision)
      const old = state.profileId ? await this.options.profiles.getSnapshot(state.profileId) : undefined
      const fields = { version: 1 as const, ...this.publicSettings(input), apiKey: input.apiKey }
      const settings = this.normalizeSettings(fields, old?.settings)
      await this.options.profiles.save(state.revision, storedPersonalSettingsSchema.parse(settings))
      this.lastCheckMessage = undefined
      await this.stopAndCancel()
      await this.options.profiles.revokeHistoricSecrets((await this.options.profiles.readState()).profileId)
      return this.status()
    })
  }
  async models(input: PersonalProviderModelsInput) {
    this.assertWritable()
    const state = await this.options.profiles.readState()
    const old = state.profileId ? await this.options.profiles.getSnapshot(state.profileId) : undefined
    const settings = this.normalizeSettings(input, old?.settings)
    return { version: 1 as const, source: 'provider' as const,
      models: await fetchProviderModels({ ...settings, fetchImplementation: this.options.fetchImplementation }) }
  }
  async check(expectedRevision: number): Promise<PersonalProviderStatus> {
    this.assertWritable()
    return this.serialize(async () => {
      let state = await this.expectRevision(expectedRevision)
      const profileId = state.profileId
      if (!profileId) throw new PersonalProfileUnavailableError()
      if (state.enabled) state = await this.options.profiles.setEnabled(state.revision, false)
      await this.stopAndCancel()
      const snapshot = await this.options.profiles.getSnapshot(profileId)
      if (!snapshot) throw new PersonalProfileUnavailableError()
      this.checkingRevision = state.revision
      let result: 'ready' | 'failed' | 'unsupported' = 'ready'
      try {
        await fetchProviderModels({ ...snapshot.settings, fetchImplementation: this.options.fetchImplementation })
        this.lastCheckMessage = undefined
      } catch (error) {
        result = error instanceof ProviderConnectionError && error.safeCode === 'models_unsupported' ? 'unsupported' : 'failed'
        this.lastCheckMessage = error instanceof ProviderConnectionError && error.safeCode === 'credentials_rejected'
          ? 'analysis.personal.credentials_rejected' : 'analysis.personal.connection_failed'
      } finally { this.checkingRevision = undefined }
      await this.options.profiles.setCheck(state.revision, result)
      return this.status()
    })
  }
  async enable(expectedRevision: number): Promise<PersonalProviderStatus> {
    this.assertWritable()
    return this.serialize(async () => {
      if (this.faulted || this.stopping) throw new PersonalProfileUnavailableError()
      const current = await this.expectRevision(expectedRevision)
      if (!['ready', 'unsupported'].includes(current.checkState)) throw new PersonalProfileUnavailableError()
      const state = await this.options.profiles.setEnabled(current.revision, true)
      try { await this.startDispatcher(state) } catch (error) {
        await this.options.profiles.setEnabled(state.revision, false)
        throw error
      }
      return this.status()
    })
  }
  async pause(expectedRevision: number): Promise<PersonalProviderStatus> {
    this.assertWritable()
    return this.serialize(async () => {
      await this.expectRevision(expectedRevision)
      await this.options.profiles.setEnabled(expectedRevision, false)
      await this.stopAndCancel()
      return this.status()
    })
  }
  async clear(expectedRevision: number): Promise<PersonalProviderStatus> {
    this.assertWritable()
    return this.serialize(async () => {
      await this.options.profiles.clear(expectedRevision)
      await this.stopAndCancel()
      await this.options.profiles.revokeHistoricSecrets()
      return this.status()
    })
  }
  async close(): Promise<void> {
    this.stopping = true
    // Graceful shutdown preserves selected profile and outstanding run bindings for restart.
    await this.serialize(async () => { await this.dispatcher?.stop(this.options.config.shutdownTimeoutMs); this.dispatcher = undefined })
    await this.options.profiles.close()
  }
  private async canAdmit(): Promise<boolean> {
    if (this.stopping || this.faulted || !this.dispatcher?.isReady()) return false
    try {
      if (!await this.health()) return false
      const state = await this.options.profiles.readState()
      return !!state.profileId && await this.canInvoke(state.profileId)
    } catch { return false }
  }
  private async canInvoke(profileId: string): Promise<boolean> {
    try {
      if (this.options.config.personalReadOnly || this.stopping || this.faulted || !await this.health()) return false
      const state = await this.options.profiles.readState()
      const snapshot = await this.options.profiles.getSnapshot(profileId)
      return state.enabled && state.profileId === profileId && !!snapshot && !snapshot.revoked
    } catch { return false }
  }
  private async health(): Promise<boolean> { return await this.options.store.checkHealth() && await this.options.profiles.checkHealth() }
  private async startDispatcher(state: PersonalProfileState): Promise<void> {
    if (this.dispatcher?.isReady()) return
    if (!state.profileId) throw new PersonalProfileUnavailableError()
    const snapshot = await this.options.profiles.getSnapshot(state.profileId)
    if (!snapshot || snapshot.revoked) throw new PersonalProfileUnavailableError()
    const provider = createPersonalModelProvider(snapshot.settings, snapshot.id, this.options.fetchImplementation)
    const runtime = createAnalysisProviderRuntime({ store: this.runStore, provider, broker: this.runService.broker,
      expectedPersonalProfileId: snapshot.id,
      leaseMs: this.options.config.leaseMs, estimateCostMicros: () => 0,
      canInvoke: () => this.canInvoke(snapshot.id),
      policy: { maxAttempts: 1, retryBaseDelayMs: 250, retryMaxDelayMs: 1_000, circuitFailureThreshold: 3, circuitOpenMs: 30_000,
        staleAfterMs: 600_000, maxRunEstimatedTokens: PERSONAL_PROVIDER_LIMITS.maxRunTokens, maxRunEstimatedCostMicros: 0,
        maxRunInvocations: PERSONAL_PROVIDER_LIMITS.maxInvocations } })
    const boundWorker = (worker: typeof runtime.evidence | typeof runtime.artifacts) => ({
      runOnce: async (tenantId: string, runId: string, ownerId: string, signal: AbortSignal) => {
        const bound = await this.options.profiles.getRunSnapshot(tenantId, runId)
        if (!bound || bound.revoked || bound.id !== snapshot.id || bound.settings.modelId !== snapshot.settings.modelId) return
        return worker.runOnce(tenantId, runId, ownerId, signal)
      },
    })
    this.dispatcher = new PersistentDispatcher({ store: this.runStore, evidence: boundWorker(runtime.evidence), artifacts: boundWorker(runtime.artifacts),
      cleanupExpired: () => this.runService.cleanupExpired(this.options.config.cleanupBatchSize),
      leaseMs: this.options.config.leaseMs, pollMs: this.options.config.ssePollMs, maxRunMs: 30 * 60_000, concurrency: 1,
      canDispatch: () => this.canInvoke(snapshot.id), onError: this.options.onError })
    await this.dispatcher.start()
  }
  private async stopAndCancel(): Promise<void> {
    try { await this.dispatcher?.stop(this.options.config.shutdownTimeoutMs) } catch (error) { this.faulted = true; throw error }
    this.dispatcher = undefined
    await this.cancelBoundRuns()
  }
  private async cancelBoundRuns(retainProfileId?: string): Promise<void> {
    for (const ref of await this.options.profiles.listBoundActiveRuns()) {
      if (retainProfileId && (await this.options.profiles.getRunSnapshot(ref.tenantId, ref.runId))?.id === retainProfileId) continue
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const run = await this.options.store.getRun(ref.tenantId, ref.runId)
        if (!run || isTerminalRun(run)) break
        try { await this.runService.cancel(ref.tenantId, ref.runId, run.revision); break } catch (error) {
          if (attempt === 2) { this.faulted = true; throw error }
        }
      }
    }
  }
  private normalizeSettings(input: PersonalProviderModelsInput, old?: PersonalProviderModelsInput): PersonalProviderModelsInput {
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl, { networkMode: input.networkMode })
    const keepSecret = old && old.providerId === input.providerId && old.baseUrl === baseUrl && old.networkMode === input.networkMode
    const settings = personalProviderModelsInputSchema.parse({ ...input, baseUrl,
      protocol: inferProviderProtocolFromUrl(input.baseUrl) ?? input.protocol, apiKey: input.apiKey ?? (keepSecret ? old.apiKey : undefined) })
    if (settings.networkMode === 'public' && !settings.apiKey) throw new ProviderConnectionError('credentials_required')
    let decodedUrl: string
    try { decodedUrl = decodeURIComponent(baseUrl) } catch { throw new ProviderConnectionError('endpoint_invalid') }
    if (settings.apiKey && [baseUrl, decodedUrl, settings.providerId, settings.modelId ?? ''].some((value) => value.includes(settings.apiKey ?? ''))) {
      throw new ProviderConnectionError('endpoint_private_fields')
    }
    return settings
  }
  private publicSettings(settings: PersonalProviderModelsInput): Omit<PersonalProviderModelsInput, 'version' | 'apiKey'> {
    return { providerId: settings.providerId, baseUrl: settings.baseUrl, modelId: settings.modelId,
      protocol: settings.protocol, structuredOutput: settings.structuredOutput, networkMode: settings.networkMode }
  }
  private async expectRevision(expectedRevision: number): Promise<PersonalProfileState> {
    const state = await this.options.profiles.readState()
    if (state.revision !== expectedRevision) throw new PersonalProfileConflictError()
    return state
  }
  private assertWritable(): void {
    if (this.options.config.personalReadOnly || this.stopping || this.faulted) throw new PersonalProfileUnavailableError()
  }
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}
