import { createHash, randomUUID } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
  analysisEventSchema,
  analysisRunSchema,
  canonicalizeJson,
  evidenceCardSchema,
  type AnalysisErrorV1,
  type AnalysisRunV1,
  type EvidenceCardV1,
  type EvidenceChunkV1,
  type EvidenceGraphV1,
  type SourceSnapshotV1,
} from '@cat-thinking/analysis-contracts'
import { createContractError } from '../errors.js'
import {
  EvidenceBudgetExceededError,
  planEvidenceBudget,
  type EvidenceBudgetPolicy,
} from './budgetPlanner.js'
import {
  defaultChunkPlannerPolicy,
  hashChunkPlan,
  planEvidenceChunks,
  type ChunkPlannerPolicy,
} from './chunkPlanner.js'
import type { EvidenceGenerator } from './evidenceGenerator.js'
import { calculateEvidenceCoverage, mergeEvidenceCards } from './evidenceMerger.js'
import { EvidenceValidationError, validateEvidenceCard } from './evidenceValidator.js'
import type {
  JobLease,
  JobStore,
  LeaseIdentity,
  StoredEvidenceCard,
  StoredSourceContent,
} from './jobStore.js'
import { LeaseGuard } from './leaseGuard.js'
import type { RunEventBroker } from './eventBroker.js'

const NODE_KEY = 'evidence:pipeline'
const EVIDENCE_SCHEMA_VERSION = 'evidence-v1'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const terminalStatuses = new Set<AnalysisRunV1['status']>([
  'partial',
  'succeeded',
  'cancelled',
  'failed',
  'expired',
])

export class EvidencePipelineStoppedError extends Error {
  constructor(readonly reason: 'run_not_active' | 'lease_lost' | 'revision_changed' | 'aborted') {
    super(`evidence pipeline stopped: ${reason}`)
    this.name = 'EvidencePipelineStoppedError'
  }
}

export interface EvidencePipelineWorkerOptions {
  readonly store: JobStore
  readonly generator: EvidenceGenerator
  readonly broker: RunEventBroker
  readonly leaseMs: number
  readonly chunkPolicy?: ChunkPlannerPolicy
  readonly budgetPolicy?: EvidenceBudgetPolicy
  readonly now?: () => number
  readonly createId?: () => string
}

export type EvidencePipelineResult =
  | Readonly<{ outcome: 'completed' | 'already_complete'; run: AnalysisRunV1; graph: EvidenceGraphV1 }>
  | Readonly<{ outcome: 'busy' | 'stopped' | 'failed'; run: AnalysisRunV1 }>

interface SourceMaterial {
  readonly snapshot: SourceSnapshotV1
  readonly content: StoredSourceContent
}

export class EvidencePipelineWorker {
  private readonly store: JobStore
  private readonly generator: EvidenceGenerator
  private readonly broker: RunEventBroker
  private readonly leaseMs: number
  private readonly chunkPolicy: ChunkPlannerPolicy
  private readonly budgetPolicy?: EvidenceBudgetPolicy
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: EvidencePipelineWorkerOptions) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new RangeError('leaseMs must be a positive integer')
    }
    this.store = options.store
    this.generator = options.generator
    this.broker = options.broker
    this.leaseMs = options.leaseMs
    this.chunkPolicy = options.chunkPolicy ?? defaultChunkPlannerPolicy
    this.budgetPolicy = options.budgetPolicy
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async runOnce(
    tenantId: string,
    runId: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<EvidencePipelineResult> {
    const initial = await this.requireRun(tenantId, runId)
    const existingGraph = await this.store.getEvidenceGraph(tenantId, runId)
    if (initial.status === 'generating' && existingGraph) {
      return { outcome: 'already_complete', run: initial, graph: existingGraph }
    }
    if (terminalStatuses.has(initial.status)) return { outcome: 'stopped', run: initial }
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
      return await this.execute(tenantId, runId, identity, guard.signal)
    } catch (error) {
      if (error instanceof EvidencePipelineStoppedError || guard.signal.aborted) {
        return { outcome: 'stopped', run: await this.requireRun(tenantId, runId) }
      }
      const run = await this.failRun(tenantId, runId, identity, error)
      return { outcome: 'failed', run }
    } finally {
      await guard.stop()
      await this.store.releaseLease(identity)
    }
  }

  private async execute(
    tenantId: string,
    runId: string,
    lease: LeaseIdentity,
    signal: AbortSignal,
  ): Promise<Readonly<{ outcome: 'completed'; run: AnalysisRunV1; graph: EvidenceGraphV1 }>> {
    this.throwIfAborted(signal)
    let run = await this.requireRun(tenantId, runId)
    if (run.status === 'queued') run = await this.startStage(tenantId, run, lease, 'planning', 0.05)
    if (run.status !== 'planning' && run.status !== 'mapping' && run.status !== 'merging') {
      throw new EvidencePipelineStoppedError('run_not_active')
    }

    const sources = await this.loadSources(tenantId, run)
    const chunks = planEvidenceChunks(sources.map(({ snapshot, content }) => ({
      snapshot,
      text: content.text,
    })), this.chunkPolicy)
    const budget = planEvidenceBudget(chunks, run.request.options.qualityProfile, this.budgetPolicy)
    const route = this.generator.route
    if (run.status === 'planning') {
      run = await this.startStage(tenantId, run, lease, 'mapping', 0.1, {
        coverage: {
          input: 1,
          analysis: 0,
          citation: 0,
          chunksCompleted: 0,
          chunksFailed: 0,
          chunksTotal: chunks.length,
        },
        providerRoutes: [{ ...route }],
        usage: { ...run.usage, estimatedCostMicros: budget.estimatedCostMicros },
      })
    }

    const cards = await this.mapChunks(tenantId, run, lease, sources, chunks, budget.concurrency, signal)
    const coverage = calculateEvidenceCoverage({
      selectedRanges: Object.fromEntries(run.request.manifest.sources.map((snapshot) => [
        snapshot.sourceId,
        snapshot.selectedRange ?? { start: 0, end: snapshot.charCount },
      ])),
      chunks,
      cards,
    })
    if (coverage.input !== 1 || coverage.analysis !== 1) {
      throw new Error('evidence mapping completed without full input coverage')
    }

    run = await this.requireRun(tenantId, runId)
    if (run.status === 'mapping') run = await this.startStage(tenantId, run, lease, 'merging', 0.45, { coverage })
    if (run.status !== 'merging') throw new EvidencePipelineStoppedError('run_not_active')

    const graph = mergeEvidenceCards({
      runId,
      chunks,
      cards,
      sourceContentHashes: run.request.manifest.sources.map((source) => source.contentHash),
      coverage,
      missingChunkIds: [],
      chunkPlanHash: hashChunkPlan(chunks),
      policyVersion: this.chunkPolicy.version,
      promptVersion: route.promptVersion,
      generatorProfile: route.profileVersion,
      createdAt: this.now(),
    })
    const completed = await this.completeEvidence(tenantId, run, lease, graph)
    return { outcome: 'completed', run: completed, graph }
  }

  private async loadSources(tenantId: string, run: AnalysisRunV1): Promise<SourceMaterial[]> {
    const sources: SourceMaterial[] = []
    for (const snapshot of run.request.manifest.sources) {
      const content = await this.store.getSourceContent(tenantId, run.id, snapshot.sourceId)
      if (!content || content.contentHash !== snapshot.contentHash || sha256(content.text) !== snapshot.contentHash) {
        throw new Error(`source ${snapshot.sourceId} is missing or changed`)
      }
      sources.push({ snapshot, content })
    }
    return sources
  }

  private async mapChunks(
    tenantId: string,
    run: AnalysisRunV1,
    lease: LeaseIdentity,
    sources: readonly SourceMaterial[],
    chunks: readonly EvidenceChunkV1[],
    concurrency: number,
    outerSignal: AbortSignal,
  ): Promise<EvidenceCardV1[]> {
    const sourceById = new Map(sources.map((source) => [source.snapshot.sourceId, source]))
    const stored = await this.store.listEvidenceCards(tenantId, run.id)
    if (!stored) throw new Error('run disappeared while listing evidence')
    const cards = new Map<string, EvidenceCardV1>()
    for (const record of stored) {
      const source = sourceById.get(record.chunk.sourceId)
      const chunk = chunks.find((candidate) => candidate.chunkId === record.chunk.chunkId)
      if (!source || !chunk || chunk.chunkHash !== record.chunk.chunkHash) continue
      cards.set(chunk.chunkId, validateEvidenceCard({
        card: record.card,
        chunk,
        snapshot: source.snapshot,
        sourceText: source.content.text,
      }))
    }

    const pending = chunks.filter((chunk) => !cards.has(chunk.chunkId))
    const controller = new AbortController()
    const abort = () => controller.abort(outerSignal.reason)
    if (outerSignal.aborted) abort()
    else outerSignal.addEventListener('abort', abort, { once: true })
    let cursor = 0
    try {
      const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (true) {
          const index = cursor
          cursor += 1
          const chunk = pending[index]
          if (!chunk) return
          try {
            const card = await this.mapChunk(tenantId, run, lease, sourceById, chunk, controller.signal)
            cards.set(chunk.chunkId, card)
          } catch (error) {
            controller.abort(error)
            throw error
          }
        }
      })
      await Promise.all(workers)
    } finally {
      outerSignal.removeEventListener('abort', abort)
    }
    return chunks.map((chunk) => {
      const card = cards.get(chunk.chunkId)
      if (!card) throw new Error(`evidence card missing for ${chunk.chunkId}`)
      return card
    })
  }

  private async mapChunk(
    tenantId: string,
    run: AnalysisRunV1,
    lease: LeaseIdentity,
    sources: ReadonlyMap<string, SourceMaterial>,
    chunk: EvidenceChunkV1,
    signal: AbortSignal,
  ): Promise<EvidenceCardV1> {
    this.throwIfAborted(signal)
    await this.ensureRunActive(tenantId, run.id)
    const source = sources.get(chunk.sourceId)
    if (!source) throw new Error(`source missing for chunk ${chunk.chunkId}`)
    const cacheKey = this.evidenceCacheKey(chunk)
    const cached = await this.store.getCachedEvidenceCard(tenantId, cacheKey, this.now())
    let card: EvidenceCardV1
    let cardHash: string
    if (cached) {
      card = this.validateCachedCard(cached, chunk, source)
      cardHash = cached.cardHash
    } else {
      const output = await this.generator.map({
        runId: run.id,
        docId: run.docId,
        locale: run.request.options.locale,
        qualityProfile: run.request.options.qualityProfile,
        chunk,
        text: source.content.text.slice(chunk.start, chunk.end),
      }, signal)
      card = validateEvidenceCard({
        card: evidenceCardSchema.parse(output.card),
        chunk,
        snapshot: source.snapshot,
        sourceText: source.content.text,
      })
      cardHash = sha256(canonicalizeJson(card))
    }
    this.throwIfAborted(signal)
    await this.ensureRunActive(tenantId, run.id)
    await this.ensureLease(lease)
    const stored = await this.store.storeEvidenceCard({
      tenantId,
      runId: run.id,
      lease,
      now: this.now(),
      cacheKey,
      cardHash,
      chunk,
      card,
      expiresAt: run.expiresAt ?? this.now() + 3_600_000,
    })
    if (!stored) throw new EvidencePipelineStoppedError('lease_lost')
    return card
  }

  private validateCachedCard(
    cached: StoredEvidenceCard,
    chunk: EvidenceChunkV1,
    source: SourceMaterial,
  ): EvidenceCardV1 {
    if (cached.chunk.chunkHash !== chunk.chunkHash || cached.chunk.chunkId !== chunk.chunkId) {
      throw new Error('exact evidence cache returned a different chunk')
    }
    if (sha256(canonicalizeJson(cached.card)) !== cached.cardHash) throw new Error('evidence cache card hash mismatch')
    return validateEvidenceCard({
      card: cached.card,
      chunk,
      snapshot: source.snapshot,
      sourceText: source.content.text,
    })
  }

  private evidenceCacheKey(chunk: EvidenceChunkV1): string {
    return sha256(canonicalizeJson({
      schema: EVIDENCE_SCHEMA_VERSION,
      chunkHash: chunk.chunkHash,
      chunkPolicy: this.chunkPolicy.version,
      route: this.generator.route,
    }))
  }

  private async startStage(
    tenantId: string,
    current: AnalysisRunV1,
    lease: LeaseIdentity,
    stage: 'planning' | 'mapping' | 'merging',
    progress: number,
    patch: Partial<Pick<AnalysisRunV1, 'coverage' | 'providerRoutes' | 'usage'>> = {},
  ): Promise<AnalysisRunV1> {
    await this.ensureLease(lease)
    const now = this.now()
    const transitioned = await this.store.transitionRun(tenantId, current.id, current.revision, (run, sequence) => {
      if (terminalStatuses.has(run.status)) throw new EvidencePipelineStoppedError('run_not_active')
      const next = analysisRunSchema.parse({
        ...run,
        ...patch,
        revision: run.revision + 1,
        status: stage,
        stage,
        progress,
        updatedAt: now,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: ANALYSIS_CONTRACT_VERSION,
          type: 'stage.started',
          eventId: this.createId(),
          runId: run.id,
          runRevision: next.revision,
          sequence,
          createdAt: now,
          stage,
        }),
      }
    })
    if (transitioned.outcome !== 'updated') throw new EvidencePipelineStoppedError('revision_changed')
    this.broker.publish(current.id)
    return transitioned.run
  }

  private async completeEvidence(
    tenantId: string,
    current: AnalysisRunV1,
    lease: LeaseIdentity,
    graph: EvidenceGraphV1,
  ): Promise<AnalysisRunV1> {
    await this.ensureLease(lease)
    const now = this.now()
    const transitioned = await this.store.commitEvidenceGraph({
      tenantId,
      runId: current.id,
      expectedRevision: current.revision,
      lease,
      graph,
      now,
      build: (run, sequence) => {
        if (run.status !== 'merging') throw new EvidencePipelineStoppedError('run_not_active')
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          coverage: graph.coverage,
          updatedAt: now,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'evidence.ready',
            eventId: this.createId(),
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: now,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })
    if (transitioned.outcome !== 'updated') throw new EvidencePipelineStoppedError('revision_changed')
    this.broker.publish(current.id)
    return transitioned.run
  }

  private async failRun(
    tenantId: string,
    runId: string,
    lease: LeaseIdentity,
    error: unknown,
  ): Promise<AnalysisRunV1> {
    const current = await this.requireRun(tenantId, runId)
    if (terminalStatuses.has(current.status)) return current
    try {
      await this.ensureLease(lease)
    } catch {
      return current
    }
    const contractError = this.contractError(error, current.stage)
    const now = this.now()
    const transitioned = await this.store.transitionRun(tenantId, runId, current.revision, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'failed',
        stage: undefined,
        updatedAt: now,
        completedAt: now,
        error: contractError,
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
          error: contractError,
        }),
      }
    })
    if (transitioned.outcome === 'updated') {
      this.broker.publish(runId)
      return transitioned.run
    }
    return this.requireRun(tenantId, runId)
  }

  private contractError(error: unknown, stage: AnalysisRunV1['stage']): AnalysisErrorV1 {
    const withStage = (contractError: AnalysisErrorV1): AnalysisErrorV1 =>
      stage === undefined ? contractError : { ...contractError, stage }
    if (error instanceof EvidenceValidationError) {
      return withStage(createContractError('citation_invalid', 'validation', false, 'analysis.evidence.invalid', {
        issueCount: error.issues.length,
      }))
    }
    if (error instanceof EvidenceBudgetExceededError) {
      return withStage(createContractError('budget_exceeded', 'budget', false, 'analysis.evidence.budget_exceeded'))
    }
    return withStage(createContractError('internal_error', 'internal', true, 'analysis.evidence.failed'))
  }

  private async ensureRunActive(tenantId: string, runId: string): Promise<void> {
    const run = await this.requireRun(tenantId, runId)
    if (terminalStatuses.has(run.status)) throw new EvidencePipelineStoppedError('run_not_active')
  }

  private async ensureLease(identity: LeaseIdentity): Promise<JobLease> {
    const lease = await this.store.renewLease(identity, this.now(), this.leaseMs)
    if (!lease) throw new EvidencePipelineStoppedError('lease_lost')
    return lease
  }

  private async requireRun(tenantId: string, runId: string): Promise<AnalysisRunV1> {
    const run = await this.store.getRun(tenantId, runId)
    if (!run) throw new Error('analysis run not found')
    return run
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new EvidencePipelineStoppedError('aborted')
  }
}
