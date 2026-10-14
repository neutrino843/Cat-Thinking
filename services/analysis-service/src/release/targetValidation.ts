import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ARTIFACT_KINDS, analysisRequestSchema, canonicalizeJson, usageSchema, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import type { AnalysisServiceConfig } from '../config.js'
import type { JobStore, RunLedgerUsage } from '../domain/jobStore.js'
import { RunService } from '../domain/runService.js'
import { PersistentDispatcher } from '../domain/persistentDispatcher.js'
import { validateArtifactDescriptor, validateGeneratedArtifact } from '../domain/artifactValidator.js'
import { createAnalysisProviderRuntime } from '../providers/analysisProviderRuntime.js'
import type { ModelProvider } from '../providers/modelProvider.js'
import type { ProviderInvocationCoordinatorOptions } from '../providers/providerInvocationCoordinator.js'
import { buildIdentitySchema, type BuildIdentity } from './buildIdentity.js'
import { configurationHash, MAX_ATTESTATION_LIFETIME_MS } from './releaseAttestation.js'
import { createTargetValidationStore, type TargetValidationBudget, type TargetValidationScope } from './targetValidationStore.js'

export const TARGET_VALIDATION_PUBLIC_TEXT = 'Photosynthesis converts light into stored chemical energy.'
export const TARGET_VALIDATION_OPT_IN = 'I_ACKNOWLEDGE_BILLABLE_NONDESTRUCTIVE_TARGET_VALIDATION'
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const nonce = z.string().regex(/^[a-f0-9]{32}$/u)
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ledgerSchema = z.object({ usage: usageSchema.refine((usage) => usage.inputTokens > 0 && usage.outputTokens > 0),
  invocationCount: counter.min(6), unresolvedCount: z.literal(0),
  estimatedInputTokens: counter, reservedOutputTokens: counter }).strict()
const artifactHashesSchema = z.object({ summary: digest, outline: digest, mindmap: digest, quiz: digest, knowledge: digest }).strict()
export const targetValidationCheckpointSchema = z.object({
  version: z.literal(1), audience: z.literal('cat-analysis-target-checkpoint'), executionId: nonce,
  configurationHash: digest, build: buildIdentitySchema, validatedAt: counter,
  tenantId: z.string().regex(/^target-validation-[a-f0-9]{32}$/u),
  runId: z.string().regex(/^target-run-[a-f0-9]{32}$/u), requestKey: digest,
  artifactHashes: artifactHashesSchema, ledger: ledgerSchema,
}).strict()
export type TargetValidationCheckpoint = z.infer<typeof targetValidationCheckpointSchema>
export interface TargetValidationResult {
  readonly checkpoint: TargetValidationCheckpoint
  readonly completedAt: number
  readonly cleanup: 'passed'
}

export class TargetValidationError extends Error {
  constructor(readonly code: 'configuration_invalid' | 'scope_mismatch' | 'not_ready' | 'incomplete' | 'usage_unresolved'
    | 'artifacts_missing' | 'checkpoint_required' | 'checkpoint_invalid' | 'recovery_mismatch' | 'cleanup_failed' | 'interrupted') {
    super(`target_validation.${code}`); this.name = 'TargetValidationError'
  }
}
export const targetValidationScope = (executionId: string, configDigest: string, build: BuildIdentity): TargetValidationScope => {
  nonce.parse(executionId); digest.parse(configDigest)
  const identity = buildIdentitySchema.parse(build)
  return { tenantId: `target-validation-${executionId}`, runId: `target-run-${executionId}`,
    request: analysisRequestSchema.parse({ version: 1,
      requestKey: hash(`cat-analysis-target-v1:${configDigest}:${canonicalizeJson(identity)}:${executionId}`), docId: `target-document-${executionId}`,
      manifest: { version: 1, sources: [{ version: 1, sourceId: 'synthetic-source', kind: 'text', extractor: 'synthetic-v1',
        contentHash: hash(TARGET_VALIDATION_PUBLIC_TEXT), charCount: TARGET_VALIDATION_PUBLIC_TEXT.length,
        byteCount: Buffer.byteLength(TARGET_VALIDATION_PUBLIC_TEXT) }] }, artifacts: [...ARTIFACT_KINDS],
      options: { locale: 'en-US', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 1, externalKnowledge: false } }) }
}
export const assertTargetValidationConfiguration = (config: AnalysisServiceConfig, budget: TargetValidationBudget): void => {
  if (!config.release.hold || config.jobStore.mode !== 'postgres' || config.provider.mode !== 'openai-compatible'
    || config.provider.invocationPolicy.maxAttempts !== 1
    || config.provider.inputMicrosPerMillionTokens <= 0 || config.provider.outputMicrosPerMillionTokens <= 0
    || !Number.isSafeInteger(budget.maxEstimatedTokens) || budget.maxEstimatedTokens <= 0 || budget.maxEstimatedTokens > 200_000
    || !Number.isSafeInteger(budget.maxEstimatedCostMicros) || budget.maxEstimatedCostMicros <= 0 || budget.maxEstimatedCostMicros > 1_000_000
    || !Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs <= 0 || budget.timeoutMs > 120_000) {
    throw new TargetValidationError('configuration_invalid')
  }
}
const assertScope = (current: AnalysisRunV1 | undefined, scope: TargetValidationScope): AnalysisRunV1 => {
  if (!current || current.id !== scope.runId || canonicalizeJson(current.request) !== canonicalizeJson(scope.request)) throw new TargetValidationError('scope_mismatch')
  return current
}
const requireKnownUsage = (ledger: RunLedgerUsage | undefined, budget: TargetValidationBudget): TargetValidationCheckpoint['ledger'] => {
  if (!ledger || ledger.invocationCount < 6 || ledger.unresolvedCount !== 0
    || ledger.usage.inputTokens <= 0 || ledger.usage.outputTokens <= 0
    || ledger.estimatedInputTokens + ledger.reservedOutputTokens > budget.maxEstimatedTokens
    || ledger.usage.inputTokens + ledger.usage.outputTokens > budget.maxEstimatedTokens
    || ledger.usage.estimatedCostMicros > budget.maxEstimatedCostMicros) throw new TargetValidationError('usage_unresolved')
  return ledgerSchema.parse(ledger)
}

export interface TargetValidationOptions {
  readonly config: AnalysisServiceConfig; readonly build: BuildIdentity; readonly executionId: string
  readonly budget: TargetValidationBudget; readonly provider: ModelProvider
  readonly connect: () => Promise<JobStore>
  readonly estimateCostMicros: ProviderInvocationCoordinatorOptions['estimateCostMicros']
  /** Runner checks trusted CI, unchanged build/config and explicit opt-in per attempt. */
  readonly canExecute: () => Promise<boolean>
  readonly signal?: AbortSignal; readonly now?: () => number
  /** A checkpoint is trusted only after the runner verifies its separate signature. */
  readonly resumeCheckpoint?: TargetValidationCheckpoint
  readonly saveCheckpoint: (checkpoint: TargetValidationCheckpoint) => Promise<void>
}

/** Never opens an API listener, changes release hold, truncates, or discovers business runs. */
export const validateTargetDeployment = async (options: TargetValidationOptions): Promise<TargetValidationResult> => {
  assertTargetValidationConfiguration(options.config, options.budget)
  const build = buildIdentitySchema.parse(options.build)
  const configDigest = configurationHash(options.config)
  const scope = targetValidationScope(options.executionId, configDigest, build)
  const now = options.now ?? Date.now
  const deadline = now() + options.budget.timeoutMs
  const providerConfig = options.config.provider
  if (providerConfig.mode !== 'openai-compatible' || options.provider.id !== providerConfig.id
    || options.provider.modelId !== providerConfig.modelId || options.provider.profileVersion !== providerConfig.profileVersion) throw new TargetValidationError('configuration_invalid')
  const allowed = async (): Promise<boolean> => !options.signal?.aborted && now() < deadline
    && options.provider.isReady() && await options.canExecute()
  const requireReady = async (): Promise<void> => {
    if (options.signal?.aborted || now() >= deadline) throw new TargetValidationError('interrupted')
    if (!await allowed()) throw new TargetValidationError('not_ready')
  }
  await requireReady()
  let checkpoint: TargetValidationCheckpoint | undefined
  if (options.resumeCheckpoint) {
    checkpoint = targetValidationCheckpointSchema.parse(options.resumeCheckpoint)
    if (checkpoint.executionId !== options.executionId || checkpoint.configurationHash !== configDigest
      || canonicalizeJson(checkpoint.build) !== canonicalizeJson(build) || checkpoint.tenantId !== scope.tenantId
      || checkpoint.runId !== scope.runId || checkpoint.requestKey !== scope.request.requestKey
      || checkpoint.validatedAt > now() || checkpoint.validatedAt + MAX_ATTESTATION_LIFETIME_MS <= now()) throw new TargetValidationError('checkpoint_invalid')
  }
  let store: JobStore | undefined
  let dispatcher: PersistentDispatcher | undefined
  const reconnect = async (): Promise<JobStore> => {
    await store?.close(); store = undefined
    await requireReady()
    store = await options.connect()
    if (!await store.checkHealth()) throw new TargetValidationError('not_ready')
    return createTargetValidationStore(store, scope, options.budget)
  }
  const dispatch = async (scoped: JobStore, service: RunService): Promise<void> => {
    const runtime = createAnalysisProviderRuntime({ store: scoped, provider: options.provider, broker: service.broker,
      leaseMs: options.config.leaseMs, estimateCostMicros: options.estimateCostMicros,
      policy: providerConfig.invocationPolicy, canInvoke: allowed })
    dispatcher = new PersistentDispatcher({ store: scoped, ...runtime, leaseMs: options.config.leaseMs,
      pollMs: Math.min(options.config.ssePollMs, 200), maxRunMs: options.budget.timeoutMs, concurrency: 1,
      cleanupExpired: async () => undefined, canDispatch: allowed })
    await dispatcher.start()
    if (!dispatcher.isReady()) throw new TargetValidationError('not_ready')
    while (true) {
      await requireReady()
      const current = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
      if (['partial', 'succeeded', 'cancelled', 'failed', 'expired'].includes(current.status)) break
      await delay(20)
    }
    await dispatcher.stop(options.config.shutdownTimeoutMs); dispatcher = undefined
  }
  try {
    let scoped = await reconnect()
    const found = await scoped.lookupRunByRequestKey(scope.tenantId, scope.request.requestKey)
    if (found.status === 'abandoned' || (checkpoint && found.status !== 'found')) throw new TargetValidationError('scope_mismatch')
    if (found.status === 'absent' && await scoped.getRun(scope.tenantId, scope.runId)) throw new TargetValidationError('scope_mismatch')
    let needsRunId = found.status === 'absent'
    const service = new RunService({ store: scoped, retentionSeconds: options.config.retentionSeconds, createId: () => {
      if (needsRunId) { needsRunId = false; return scope.runId }
      return randomUUID()
    },
      maxRunEstimatedTokens: Math.min(providerConfig.invocationPolicy.maxRunEstimatedTokens, options.budget.maxEstimatedTokens),
      maxRunEstimatedCostMicros: Math.min(providerConfig.invocationPolicy.maxRunEstimatedCostMicros, options.budget.maxEstimatedCostMicros) })
    let current = found.status === 'found' ? assertScope(found.run, scope)
      : (await service.createRun(scope.tenantId, scope.request)).run
    if (!checkpoint && current.status === 'receiving') {
      const source = scope.request.manifest.sources[0]
      const receipt = await scoped.getSourceReceipt(scope.tenantId, scope.runId, source.sourceId)
      if (!receipt?.complete) await service.uploadSource(scope.tenantId, scope.runId, { version: 1,
        sourceId: source.sourceId, contentHash: source.contentHash, partHash: source.contentHash,
        partIndex: 0, partCount: 1, start: 0, end: source.charCount, totalChars: source.charCount, text: TARGET_VALIDATION_PUBLIC_TEXT })
      try { await service.startRun(scope.tenantId, scope.runId, current.revision) } catch (error) {
        // A concurrent invocation may have accepted this exact request already.
        current = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
        if (current.status === 'receiving') throw error
      }
    }
    current = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
    if (!checkpoint && !['partial', 'succeeded', 'cancelled', 'failed', 'expired'].includes(current.status)) await dispatch(scoped, service)
    current = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
    if (current.status !== 'succeeded') throw new TargetValidationError('incomplete')
    const ledger = requireKnownUsage(await scoped.getRunLedgerUsage(scope.tenantId, scope.runId), options.budget)
    if (checkpoint) {
      if (canonicalizeJson(checkpoint.ledger) !== canonicalizeJson(ledger)) throw new TargetValidationError('recovery_mismatch')
    } else {
      const graph = await scoped.getEvidenceGraph(scope.tenantId, scope.runId)
      const outline = await scoped.getArtifact(scope.tenantId, scope.runId, 'outline')
      if (!graph || !outline || outline.artifact.kind !== 'outline') throw new TargetValidationError('checkpoint_required')
      const artifactHashes: Record<string, string> = {}
      for (const kind of ARTIFACT_KINDS) {
        const stored = await scoped.getArtifact(scope.tenantId, scope.runId, kind)
        if (!stored || current.artifactStates[kind]?.status !== 'succeeded') throw new TargetValidationError('artifacts_missing')
        validateGeneratedArtifact({ artifact: stored.artifact, expectedKind: kind, run: current, graph, outline: outline.artifact.payload })
        validateArtifactDescriptor(stored.artifact, stored.descriptor)
        artifactHashes[kind] = stored.descriptor.artifactHash
      }
      // A new connection and a running dispatcher must recover this committed run
      // without reserving another invocation or changing an artifact identity.
      scoped = await reconnect()
      const recovered = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
      if (recovered.status !== 'succeeded' || canonicalizeJson(requireKnownUsage(await scoped.getRunLedgerUsage(scope.tenantId, scope.runId), options.budget)) !== canonicalizeJson(ledger)) throw new TargetValidationError('recovery_mismatch')
      const recoveredDescriptors = await scoped.listArtifactDescriptors(scope.tenantId, scope.runId)
      if (recoveredDescriptors?.length !== ARTIFACT_KINDS.length
        || recoveredDescriptors.some((descriptor) => artifactHashes[descriptor.kind] !== descriptor.artifactHash)) throw new TargetValidationError('recovery_mismatch')
      await dispatch(scoped, new RunService({ store: scoped, retentionSeconds: options.config.retentionSeconds }))
      if (canonicalizeJson(requireKnownUsage(await scoped.getRunLedgerUsage(scope.tenantId, scope.runId), options.budget)) !== canonicalizeJson(ledger)) throw new TargetValidationError('recovery_mismatch')
      checkpoint = targetValidationCheckpointSchema.parse({ version: 1, audience: 'cat-analysis-target-checkpoint',
        executionId: options.executionId, configurationHash: configDigest, build, validatedAt: now(),
        tenantId: scope.tenantId, runId: scope.runId, requestKey: scope.request.requestKey, artifactHashes, ledger })
      // Write-ahead, separately signed checkpoint. Crashes after content cleanup
      // can verify it and finish without replaying the already billed calls.
      await options.saveCheckpoint(checkpoint)
    }
    await requireReady()
    await scoped.deleteContent(scope.tenantId, scope.runId)
    scoped = await reconnect()
    const cleanedRun = assertScope(await scoped.getRun(scope.tenantId, scope.runId), scope)
    if (cleanedRun.status !== 'succeeded' || (await scoped.listArtifactDescriptors(scope.tenantId, scope.runId))?.length !== 0
      || await scoped.getEvidenceGraph(scope.tenantId, scope.runId)
      || await scoped.getSourceContent(scope.tenantId, scope.runId, scope.request.manifest.sources[0].sourceId)
      || canonicalizeJson(requireKnownUsage(await scoped.getRunLedgerUsage(scope.tenantId, scope.runId), options.budget)) !== canonicalizeJson(checkpoint.ledger)) throw new TargetValidationError('cleanup_failed')
    await requireReady()
    return { checkpoint, completedAt: now(), cleanup: 'passed' }
  } finally {
    // Never close a connection beneath an undrained request. Preserve durable
    // content on incomplete runs so the same nonce can resume, with ledger fences.
    await dispatcher?.stop(options.config.shutdownTimeoutMs)
    await store?.close()
  }
}
