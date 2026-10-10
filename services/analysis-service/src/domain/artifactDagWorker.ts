import { randomUUID } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
  ARTIFACT_KINDS,
  analysisEventSchema,
  analysisRunSchema,
  providerRouteSchema,
  usageSchema,
  type AnalysisErrorV1,
  type AnalysisEventV1,
  type AnalysisRunV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type OutlineArtifactV1,
  type ProviderRouteV1,
  type UsageV1,
} from '@cat-thinking/analysis-contracts'
import { createContractError } from '../errors.js'
import { ArtifactBudgetExceededError, planArtifactBudget } from './artifactBudget.js'
import {
  ArtifactValidationError,
  createArtifactDescriptor,
  validateGeneratedArtifact,
} from './artifactValidator.js'
import type { ArtifactGenerationOutput, ArtifactGenerator } from './artifactGenerator.js'
import type { RunEventBroker } from './eventBroker.js'
import type { JobStore, LeaseIdentity } from './jobStore.js'
import { LeaseGuard, LeaseGuardLostError } from './leaseGuard.js'

const NODE_KEY = 'artifacts:dag'
const stoppedStatuses = new Set<AnalysisRunV1['status']>(['cancelled', 'expired'])
const completedStatuses = new Set<AnalysisRunV1['status']>(['partial', 'succeeded', 'failed'])
const settledArtifactStatuses = new Set(['succeeded', 'failed', 'cancelled'])

export class ArtifactDagStoppedError extends Error {
  constructor(readonly reason: 'run_not_active' | 'lease_lost' | 'revision_changed' | 'aborted') {
    super(`artifact DAG stopped: ${reason}`)
    this.name = 'ArtifactDagStoppedError'
  }
}

class ArtifactDependencyError extends Error {
  constructor(readonly kind: ArtifactKind, readonly dependency: ArtifactKind) {
    super(`${kind} requires successful ${dependency}`)
    this.name = 'ArtifactDependencyError'
  }
}

export interface ArtifactDagWorkerOptions {
  readonly store: JobStore
  readonly generator: ArtifactGenerator
  readonly broker: RunEventBroker
  readonly leaseMs: number
  readonly concurrency?: number
  readonly now?: () => number
  readonly createId?: () => string
}

export type ArtifactDagResult =
  | Readonly<{ outcome: 'completed' | 'already_complete'; run: AnalysisRunV1 }>
  | Readonly<{ outcome: 'busy' | 'stopped' | 'failed'; run: AnalysisRunV1 }>

interface PreparedArtifact {
  readonly kind: ArtifactKind
  readonly attempt: number
}

interface GeneratedArtifact extends PreparedArtifact {
  readonly output?: ArtifactGenerationOutput
  readonly error?: unknown
}

export class ArtifactDagWorker {
  private readonly store: JobStore
  private readonly generator: ArtifactGenerator
  private readonly broker: RunEventBroker
  private readonly leaseMs: number
  private readonly concurrency: number
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: ArtifactDagWorkerOptions) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new RangeError('leaseMs must be a positive integer')
    }
    const concurrency = options.concurrency ?? 4
    if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > ARTIFACT_KINDS.length) {
      throw new RangeError(`concurrency must be between 1 and ${ARTIFACT_KINDS.length}`)
    }
    this.store = options.store
    this.generator = options.generator
    this.broker = options.broker
    this.leaseMs = options.leaseMs
    this.concurrency = concurrency
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async runOnce(
    tenantId: string,
    runId: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ArtifactDagResult> {
    const initial = await this.requireRun(tenantId, runId)
    if (completedStatuses.has(initial.status)) return { outcome: 'already_complete', run: initial }
    if (stoppedStatuses.has(initial.status)) return { outcome: 'stopped', run: initial }
    if (initial.status !== 'generating') return { outcome: 'stopped', run: initial }
    const graph = await this.store.getEvidenceGraph(tenantId, runId)
    if (!graph) return { outcome: 'failed', run: await this.failRun(tenantId, runId, 'analysis.artifact.evidence_missing') }

    const lease = await this.store.acquireLease({
      tenantId,
      runId,
      nodeKey: NODE_KEY,
      ownerId,
      now: this.now(),
      durationMs: this.leaseMs,
    })
    if (!lease) return { outcome: 'busy', run: initial }
    const identity: LeaseIdentity = { tenantId, ...lease }
    const guard = new LeaseGuard({
      store: this.store,
      identity,
      leaseMs: this.leaseMs,
      parentSignal: signal,
      now: this.now,
    })
    guard.start()
    try {
      const run = await this.execute(tenantId, runId, graph, identity, guard)
      return { outcome: 'completed', run }
    } catch (error) {
      if (
        error instanceof ArtifactDagStoppedError
        || error instanceof LeaseGuardLostError
        || signal.aborted
        || guard.signal.aborted
      ) return { outcome: 'stopped', run: await this.requireRun(tenantId, runId) }
      return { outcome: 'failed', run: await this.failRun(tenantId, runId, 'analysis.artifact.pipeline_failed') }
    } finally {
      await guard.stop()
      await this.store.releaseLease(identity)
    }
  }

  private async execute(
    tenantId: string,
    runId: string,
    graph: NonNullable<Awaited<ReturnType<JobStore['getEvidenceGraph']>>>,
    lease: LeaseIdentity,
    guard: LeaseGuard,
  ): Promise<AnalysisRunV1> {
    const initial = await this.requireRun(tenantId, runId)
    const requested = ARTIFACT_KINDS.filter((kind) => initial.request.artifacts.includes(kind))
    const roots = requested.filter((kind) => kind !== 'mindmap')
    await this.processBatch(tenantId, runId, graph, lease, guard, roots)

    if (requested.includes('mindmap')) {
      const outline = await this.store.getArtifact(tenantId, runId, 'outline')
      if (!outline || outline.artifact.kind !== 'outline') {
        await this.processDependencyFailure(tenantId, runId, graph, lease, guard, 'mindmap', 'outline')
      } else {
        await this.processBatch(tenantId, runId, graph, lease, guard, ['mindmap'], outline.artifact.payload)
      }
    }
    return this.requireRun(tenantId, runId)
  }

  private async processBatch(
    tenantId: string,
    runId: string,
    graph: NonNullable<Awaited<ReturnType<JobStore['getEvidenceGraph']>>>,
    lease: LeaseIdentity,
    guard: LeaseGuard,
    kinds: readonly ArtifactKind[],
    outline?: OutlineArtifactV1,
  ): Promise<void> {
    const prepared: PreparedArtifact[] = []
    for (const kind of kinds) {
      const item = await this.beginArtifact(tenantId, runId, kind, guard)
      if (item) prepared.push(item)
    }
    if (prepared.length === 0) return

    const generated = await this.mapBounded(prepared, async (item) => {
      if (guard.signal.aborted) throw new ArtifactDagStoppedError('aborted')
      const run = await this.requireRun(tenantId, runId)
      try {
        const budget = planArtifactBudget(item.kind, run.request.options)
        const output = await this.generator.generate({
          runId,
          docId: run.docId,
          kind: item.kind,
          options: run.request.options,
          budget,
          graph,
          outline,
        }, guard.signal)
        return { ...item, output }
      } catch (error) {
        if (guard.signal.aborted) throw new ArtifactDagStoppedError('aborted')
        return { ...item, error }
      }
    })
    for (const result of generated) {
      await guard.ensure()
      await this.commitGenerated(tenantId, runId, graph, lease, result, outline)
    }
  }

  private async processDependencyFailure(
    tenantId: string,
    runId: string,
    graph: NonNullable<Awaited<ReturnType<JobStore['getEvidenceGraph']>>>,
    lease: LeaseIdentity,
    guard: LeaseGuard,
    kind: ArtifactKind,
    dependency: ArtifactKind,
  ): Promise<void> {
    const prepared = await this.beginArtifact(tenantId, runId, kind, guard)
    if (!prepared) return
    await guard.ensure()
    await this.commitGenerated(tenantId, runId, graph, lease, {
      ...prepared,
      error: new ArtifactDependencyError(kind, dependency),
    })
  }

  private async beginArtifact(
    tenantId: string,
    runId: string,
    kind: ArtifactKind,
    guard: LeaseGuard,
  ): Promise<PreparedArtifact | undefined> {
    await guard.ensure()
    const current = await this.requireRun(tenantId, runId)
    if (stoppedStatuses.has(current.status)) throw new ArtifactDagStoppedError('run_not_active')
    const state = current.artifactStates[kind]
    if (!state || settledArtifactStatuses.has(state.status)) return undefined
    if (state.status === 'running') return { kind, attempt: state.attempt }
    const attempt = Math.max(1, state.attempt)
    const now = this.now()
    const transitioned = await this.store.transitionRun(tenantId, runId, current.revision, (run, sequence) => {
      const latest = run.artifactStates[kind]
      if (!latest || latest.status !== 'pending' || latest.attempt !== state.attempt) {
        throw new ArtifactDagStoppedError('revision_changed')
      }
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'generating',
        stage: kind,
        artifactStates: {
          ...run.artifactStates,
          [kind]: { status: 'running', attempt, updatedAt: now },
        },
        updatedAt: now,
        completedAt: undefined,
        error: undefined,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: ANALYSIS_CONTRACT_VERSION,
          type: 'stage.started',
          eventId: this.createId(),
          runId,
          runRevision: next.revision,
          sequence,
          createdAt: now,
          stage: kind,
        }),
      }
    })
    if (transitioned.outcome !== 'updated') throw new ArtifactDagStoppedError('revision_changed')
    this.broker.publish(runId)
    return { kind, attempt }
  }

  private async commitGenerated(
    tenantId: string,
    runId: string,
    graph: NonNullable<Awaited<ReturnType<JobStore['getEvidenceGraph']>>>,
    lease: LeaseIdentity,
    generated: GeneratedArtifact,
    outline?: OutlineArtifactV1,
  ): Promise<void> {
    const current = await this.requireRun(tenantId, runId)
    if (stoppedStatuses.has(current.status)) throw new ArtifactDagStoppedError('run_not_active')
    let artifact: ArtifactEnvelopeV1 | undefined
    let output: ArtifactGenerationOutput | undefined
    let error: AnalysisErrorV1 | undefined
    if (generated.output) {
      try {
        output = {
          ...generated.output,
          route: providerRouteSchema.parse(generated.output.route),
          usage: usageSchema.parse(generated.output.usage),
        }
        const budget = planArtifactBudget(generated.kind, current.request.options)
        if (output.usage.outputTokens > budget.maxOutputTokens) {
          throw new ArtifactBudgetExceededError(output.usage.outputTokens, budget.maxOutputTokens)
        }
        artifact = validateGeneratedArtifact({
          artifact: output.artifact,
          expectedKind: generated.kind,
          run: current,
          graph,
          outline,
          maxArtifactBytes: budget.maxArtifactBytes,
        })
      } catch (validationError) {
        error = this.artifactError(validationError, generated.kind)
      }
    } else {
      error = this.artifactError(generated.error, generated.kind)
    }
    const descriptor = artifact ? createArtifactDescriptor(artifact) : undefined
    const failureError = artifact && descriptor
      ? undefined
      : error ?? this.artifactError(undefined, generated.kind)
    const now = this.now()
    const build = (run: AnalysisRunV1, sequence: number) => {
      const state = run.artifactStates[generated.kind]
      if (!state || state.status !== 'running' || state.attempt !== generated.attempt) {
        throw new ArtifactDagStoppedError('revision_changed')
      }
      const artifactStates: AnalysisRunV1['artifactStates'] = {
        ...run.artifactStates,
        [generated.kind]: artifact && descriptor
          ? { status: 'succeeded', attempt: state.attempt, artifactId: descriptor.id, updatedAt: now }
          : { status: 'failed', attempt: state.attempt, error: failureError, updatedAt: now },
      }
      const requestedStates = run.request.artifacts.map((kind) => {
        const requestedState = artifactStates[kind]
        if (!requestedState) throw new TypeError(`requested artifact ${kind} has no state`)
        return requestedState
      })
      const settled = requestedStates.filter((candidate) => settledArtifactStatuses.has(candidate.status)).length
      const succeeded = requestedStates.filter((candidate) => candidate.status === 'succeeded').length
      const allSettled = settled === requestedStates.length
      const status: AnalysisRunV1['status'] = !allSettled
        ? 'generating'
        : succeeded === requestedStates.length
          ? 'succeeded'
          : succeeded > 0
            ? 'partial'
            : 'failed'
      const terminalError = status === 'failed'
        ? createContractError('artifact_invalid', 'validation', false, 'analysis.artifacts.all_failed')
        : undefined
      const usage = output ? this.addUsage(run.usage, output.usage) : run.usage
      const providerRoutes = output ? this.addRoute(run.providerRoutes, output.route) : run.providerRoutes
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status,
        stage: undefined,
        progress: allSettled ? 1 : Math.max(run.progress, 0.55 + 0.45 * (settled / requestedStates.length)),
        providerRoutes,
        artifactStates,
        usage,
        updatedAt: now,
        completedAt: allSettled ? now : undefined,
        error: terminalError,
      })
      const events: AnalysisEventV1[] = [analysisEventSchema.parse(artifact && descriptor
        ? {
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'artifact.ready',
            eventId: this.createId(),
            runId,
            runRevision: next.revision,
            sequence,
            createdAt: now,
            descriptor,
          }
        : {
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'artifact.failed',
            eventId: this.createId(),
            runId,
            runRevision: next.revision,
            sequence,
            createdAt: now,
            kind: generated.kind,
            error: failureError,
          })]
      if (status === 'succeeded' || status === 'partial') {
        events.push(analysisEventSchema.parse({
          version: ANALYSIS_CONTRACT_VERSION,
          type: 'run.completed',
          eventId: this.createId(),
          runId,
          runRevision: next.revision,
          sequence: sequence + 1,
          createdAt: now,
          status,
          coverage: next.coverage,
        }))
      } else if (status === 'failed') {
        if (!terminalError) throw new TypeError('failed artifact run has no terminal error')
        events.push(analysisEventSchema.parse({
          version: ANALYSIS_CONTRACT_VERSION,
          type: 'run.failed',
          eventId: this.createId(),
          runId,
          runRevision: next.revision,
          sequence: sequence + 1,
          createdAt: now,
          error: terminalError,
        }))
      }
      return { run: next, events }
    }
    const committed = artifact && descriptor
      ? await this.store.commitArtifact({
          tenantId,
          runId,
          kind: generated.kind,
          expectedRevision: current.revision,
          expectedAttempt: generated.attempt,
          lease,
          now,
          result: 'succeeded',
          artifact,
          descriptor,
          build,
        })
      : await this.store.commitArtifact({
          tenantId,
          runId,
          kind: generated.kind,
          expectedRevision: current.revision,
          expectedAttempt: generated.attempt,
          lease,
          now,
          result: 'failed',
          build,
        })
    if (committed.outcome !== 'updated') throw new ArtifactDagStoppedError(
      committed.outcome === 'lease_conflict' ? 'lease_lost' : 'revision_changed',
    )
    this.broker.publish(runId)
  }

  private artifactError(error: unknown, kind: ArtifactKind): AnalysisErrorV1 {
    if (error instanceof ArtifactDependencyError) {
      return createContractError('dependency_failed', 'validation', false, 'analysis.artifact.dependency_failed', {
        kind,
        dependency: error.dependency,
      })
    }
    if (error instanceof ArtifactValidationError) {
      return createContractError('artifact_invalid', 'validation', false, 'analysis.artifact.invalid', {
        kind,
        issueCount: error.issues.length,
      })
    }
    if (error instanceof ArtifactBudgetExceededError) {
      return createContractError('budget_exceeded', 'budget', false, 'analysis.artifact.budget_exceeded', {
        kind,
        actualOutputTokens: error.actualOutputTokens,
        maximumOutputTokens: error.maximumOutputTokens,
      })
    }
    return createContractError('internal_error', 'internal', true, 'analysis.artifact.generation_failed', { kind })
  }

  private addRoute(routes: readonly ProviderRouteV1[], route: ProviderRouteV1): readonly ProviderRouteV1[] {
    const key = JSON.stringify(route)
    return routes.some((candidate) => JSON.stringify(candidate) === key) ? routes : [...routes, route]
  }

  private addUsage(current: UsageV1, delta: UsageV1): UsageV1 {
    if (current.currency !== delta.currency) throw new TypeError('artifact usage currency differs from run usage')
    const actualDefined = current.actualCostMicros !== undefined || delta.actualCostMicros !== undefined
    return usageSchema.parse({
      inputTokens: current.inputTokens + delta.inputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
      estimatedCostMicros: current.estimatedCostMicros + delta.estimatedCostMicros,
      actualCostMicros: actualDefined
        ? (current.actualCostMicros ?? 0) + (delta.actualCostMicros ?? 0)
        : undefined,
      currency: current.currency,
    })
  }

  private async mapBounded<T, U>(items: readonly T[], operation: (item: T) => Promise<U>): Promise<U[]> {
    const results = new Array<U>(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        const item = items[index]
        if (item === undefined) return
        results[index] = await operation(item)
      }
    })
    await Promise.all(workers)
    return results
  }

  private async failRun(tenantId: string, runId: string, messageKey: string): Promise<AnalysisRunV1> {
    const current = await this.requireRun(tenantId, runId)
    if (stoppedStatuses.has(current.status) || completedStatuses.has(current.status)) return current
    const now = this.now()
    const error = createContractError('internal_error', 'internal', true, messageKey)
    const transitioned = await this.store.transitionRun(tenantId, runId, current.revision, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'failed',
        stage: undefined,
        updatedAt: now,
        completedAt: now,
        error,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: ANALYSIS_CONTRACT_VERSION,
          type: 'run.failed',
          eventId: this.createId(),
          runId,
          runRevision: next.revision,
          sequence,
          createdAt: now,
          error,
        }),
      }
    })
    if (transitioned.outcome === 'updated') {
      this.broker.publish(runId)
      return transitioned.run
    }
    return this.requireRun(tenantId, runId)
  }

  private async requireRun(tenantId: string, runId: string): Promise<AnalysisRunV1> {
    const run = await this.store.getRun(tenantId, runId)
    if (!run) throw new Error('analysis run not found')
    return run
  }
}
