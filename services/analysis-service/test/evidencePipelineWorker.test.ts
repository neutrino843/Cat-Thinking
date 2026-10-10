import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  evidenceCardSchema,
  type AnalysisRequestV1,
  type EvidenceCardV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { defaultEvidenceBudgetPolicy } from '../src/domain/budgetPlanner.js'
import type { ChunkPlannerPolicy } from '../src/domain/chunkPlanner.js'
import type {
  EvidenceGenerator,
  EvidenceMapInput,
  EvidenceMapOutput,
} from '../src/domain/evidenceGenerator.js'
import { EvidencePipelineWorker } from '../src/domain/evidencePipelineWorker.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const text = [
  '第一章 光合作用。叶绿体吸收光能并形成化学能。'.repeat(5),
  '第二章 碳反应。二氧化碳在酶的参与下形成有机物。'.repeat(5),
  '第三章 影响因素。光照、温度和二氧化碳浓度会影响速率。'.repeat(5),
].join('\n\n')

const chunkPolicy: ChunkPlannerPolicy = {
  version: 'pipeline-test-v1',
  targetCharacters: 120,
  maxCharacters: 150,
  overlapCharacters: 10,
  minimumBoundaryRatio: 0.5,
}

const request = (requestKey = hash('pipeline-request')): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey,
  docId: 'doc-evidence',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-evidence',
      kind: 'text',
      extractor: 'fixture-v1',
      contentHash: hash(text),
      charCount: text.length,
      byteCount: new TextEncoder().encode(text).byteLength,
      locators: [
        { start: 0, end: text.length, titlePath: ['光合作用'] },
      ],
    }],
  },
  artifacts: ['summary'],
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount: 1,
    externalKnowledge: false,
  },
})

const cardFor = (input: EvidenceMapInput): EvidenceCardV1 => {
  const end = Math.min(input.chunk.end, input.chunk.start + Math.max(1, Math.min(16, input.text.length)))
  const citation = {
    version: 1 as const,
    provenance: 'source' as const,
    sourceId: input.chunk.sourceId,
    start: input.chunk.start,
    end,
    quote: input.text.slice(0, end - input.chunk.start),
  }
  return evidenceCardSchema.parse({
    version: 1,
    chunkId: input.chunk.chunkId,
    chunkHash: input.chunk.chunkHash,
    sourceId: input.chunk.sourceId,
    titlePath: input.chunk.titlePath,
    claims: [{
      id: 'claim-1',
      kind: 'fact',
      statement: `证据 ${input.chunk.ordinal}`,
      conceptIds: ['term-1'],
      citations: [citation],
    }],
    terms: [{ id: 'term-1', term: '光合作用', citations: [citation] }],
    learningObjectives: [{ id: 'objective-1', text: '理解文档内容', evidenceIds: ['claim-1'] }],
  })
}

class FixtureGenerator implements EvidenceGenerator {
  readonly route = {
    providerId: 'fixture-provider',
    modelId: 'fixture-model',
    profileVersion: 'fixture-profile-v1',
    promptVersion: 'evidence-map-v1',
  }
  readonly calls: EvidenceMapInput[] = []
  constructor(private readonly generate: (input: EvidenceMapInput, signal: AbortSignal) => EvidenceCardV1 = cardFor) {}

  async map(input: EvidenceMapInput, signal: AbortSignal): Promise<EvidenceMapOutput> {
    this.calls.push(input)
    if (signal.aborted) throw signal.reason
    return { card: this.generate(input, signal) }
  }
}

const prepareRun = async (
  store: InMemoryJobStore,
  tenantId: string,
  requestKey?: string,
): Promise<{ service: RunService; runId: string }> => {
  const service = new RunService({ store, retentionSeconds: 3_600, now: () => 1_000 })
  const created = await service.createRun(tenantId, request(requestKey))
  await service.uploadSource(tenantId, created.run.id, {
    version: 1,
    sourceId: 'source-evidence',
    contentHash: hash(text),
    partHash: hash(text),
    partIndex: 0,
    partCount: 1,
    start: 0,
    end: text.length,
    totalChars: text.length,
    text,
  })
  await service.startRun(tenantId, created.run.id, 1)
  return { service, runId: created.run.id }
}

const worker = (
  store: InMemoryJobStore,
  generator: EvidenceGenerator,
  broker: RunService['broker'],
  overrides: Partial<ConstructorParameters<typeof EvidencePipelineWorker>[0]> = {},
) => new EvidencePipelineWorker({
  store,
  generator,
  broker,
  leaseMs: 1_000,
  chunkPolicy,
  now: () => 1_000,
  createId: (() => { let id = 0; return () => `evidence-event-${++id}` })(),
  ...overrides,
})

describe('evidence pipeline worker', () => {
  it('validates lease configuration and supports explicit production defaults', async () => {
    const store = new InMemoryJobStore()
    const prepared = await prepareRun(store, 'tenant-a', hash('worker-defaults'))
    const generator = new FixtureGenerator()
    expect(() => new EvidencePipelineWorker({
      store,
      generator,
      broker: prepared.service.broker,
      leaseMs: 0,
    })).toThrow(/leaseMs/)
    expect(() => new EvidencePipelineWorker({
      store,
      generator,
      broker: prepared.service.broker,
      leaseMs: 1.5,
    })).toThrow(/leaseMs/)
    const defaulted = new EvidencePipelineWorker({
      store,
      generator,
      broker: prepared.service.broker,
      leaseMs: 1_000,
    })
    const cancelled = await prepared.service.cancel('tenant-a', prepared.runId, 2)
    expect(cancelled.accepted).toBe(true)
    expect(await prepared.service.getRun('tenant-a', prepared.runId)).toMatchObject({ status: 'cancelled' })
    expect(await defaulted.runOnce(
      'tenant-a', prepared.runId, 'worker-defaults', new AbortController().signal,
    )).toMatchObject({ outcome: 'stopped', run: { status: 'cancelled' } })

    const abortedRun = await prepareRun(store, 'tenant-a', hash('worker-pre-aborted'))
    const controller = new AbortController()
    controller.abort(new Error('shutdown before execution'))
    expect(await new EvidencePipelineWorker({
      store,
      generator,
      broker: abortedRun.service.broker,
      leaseMs: 1_000,
    }).runOnce('tenant-a', abortedRun.runId, 'worker-aborted', controller.signal))
      .toMatchObject({ outcome: 'stopped', run: { status: 'queued' } })
  })

  it('moves a queued run through evidence stages and persists a recoverable graph', async () => {
    const store = new InMemoryJobStore()
    const { service, runId } = await prepareRun(store, 'tenant-a')
    const generator = new FixtureGenerator()
    const brokerVersion = service.broker.version(runId)
    const result = await worker(store, generator, service.broker).runOnce(
      'tenant-a', runId, 'worker-1', new AbortController().signal,
    )

    expect(result.outcome).toBe('completed')
    if (result.outcome !== 'completed') throw new Error('expected completed evidence pipeline')
    expect(result.run).toMatchObject({ status: 'generating', revision: 6, progress: 0.55 })
    expect(result.run.coverage).toMatchObject({ input: 1, analysis: 1, chunksFailed: 0 })
    expect(generator.calls.length).toBeGreaterThan(1)
    expect(await store.getEvidenceGraph('tenant-a', runId)).toMatchObject({ runId, graphHash: result.graph.graphHash })
    expect((await service.listEvents('tenant-a', runId)).at(-1)).toMatchObject({
      type: 'evidence.ready',
      graphHash: result.graph.graphHash,
      runRevision: 6,
    })
    expect(service.broker.version(runId)).toBe(brokerVersion + 4)

    const replay = await worker(store, generator, service.broker).runOnce(
      'tenant-a', runId, 'worker-2', new AbortController().signal,
    )
    expect(replay.outcome).toBe('already_complete')
  })

  it('reuses exact cards inside one tenant but not across tenants', async () => {
    const store = new InMemoryJobStore()
    const generator = new FixtureGenerator()
    const first = await prepareRun(store, 'tenant-a', hash('request-a-1'))
    await worker(store, generator, first.service.broker).runOnce(
      'tenant-a', first.runId, 'worker-1', new AbortController().signal,
    )
    const firstCalls = generator.calls.length

    const second = await prepareRun(store, 'tenant-a', hash('request-a-2'))
    await worker(store, generator, second.service.broker).runOnce(
      'tenant-a', second.runId, 'worker-2', new AbortController().signal,
    )
    expect(generator.calls).toHaveLength(firstCalls)

    const isolated = await prepareRun(store, 'tenant-b', hash('request-b-1'))
    await worker(store, generator, isolated.service.broker).runOnce(
      'tenant-b', isolated.runId, 'worker-3', new AbortController().signal,
    )
    expect(generator.calls.length).toBeGreaterThan(firstCalls)
  })

  it('stops when another worker owns the lease and resumes after an interrupted map', async () => {
    const store = new InMemoryJobStore()
    const prepared = await prepareRun(store, 'tenant-a')
    await store.acquireLease({
      tenantId: 'tenant-a',
      runId: prepared.runId,
      nodeKey: 'evidence:pipeline',
      ownerId: 'other-worker',
      now: 1_000,
      durationMs: 1_000,
    })
    const generator = new FixtureGenerator()
    expect(await worker(store, generator, prepared.service.broker).runOnce(
      'tenant-a', prepared.runId, 'worker-1', new AbortController().signal,
    )).toMatchObject({ outcome: 'busy' })

    await store.releaseLease({
      tenantId: 'tenant-a',
      runId: prepared.runId,
      nodeKey: 'evidence:pipeline',
      ownerId: 'other-worker',
      attempt: 1,
    })
    const controller = new AbortController()
    const interrupted = new FixtureGenerator((input) => {
      if (input.chunk.ordinal === 1) {
        controller.abort(new Error('simulated worker shutdown'))
        throw new Error('simulated worker shutdown')
      }
      return cardFor(input)
    })
    const serialBudget = {
      ...defaultEvidenceBudgetPolicy,
      profiles: Object.fromEntries(Object.entries(defaultEvidenceBudgetPolicy.profiles).map(([key, value]) => [
        key,
        { ...value, concurrency: 1 },
      ])) as typeof defaultEvidenceBudgetPolicy.profiles,
    }
    const stopped = await worker(store, interrupted, prepared.service.broker, { budgetPolicy: serialBudget }).runOnce(
      'tenant-a', prepared.runId, 'worker-1', controller.signal,
    )
    expect(stopped.outcome).toBe('stopped')
    expect(stopped.run.status).toBe('mapping')
    expect(await store.listEvidenceCards('tenant-a', prepared.runId)).toHaveLength(1)

    const resumed = new FixtureGenerator()
    expect(await worker(store, resumed, prepared.service.broker, { budgetPolicy: serialBudget }).runOnce(
      'tenant-a', prepared.runId, 'worker-2', new AbortController().signal,
    )).toMatchObject({ outcome: 'completed' })
    expect(resumed.calls.length).toBeGreaterThan(0)
  })

  it('records deterministic budget and citation failures without storing a graph', async () => {
    const store = new InMemoryJobStore()
    const budgetRun = await prepareRun(store, 'tenant-a', hash('budget-run'))
    const constrainedBudget = {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, maxChunks: 1 },
    }
    const budgetResult = await worker(
      store, new FixtureGenerator(), budgetRun.service.broker, { budgetPolicy: constrainedBudget },
    ).runOnce(
      'tenant-a', budgetRun.runId, 'budget-worker', new AbortController().signal,
    )
    expect(budgetResult).toMatchObject({
      outcome: 'failed',
      run: { status: 'failed', error: { code: 'budget_exceeded', stage: 'planning' } },
    })
    expect(await store.getEvidenceGraph('tenant-a', budgetRun.runId)).toBeUndefined()

    const invalidRun = await prepareRun(store, 'tenant-a', hash('invalid-run'))
    const invalidGenerator = new FixtureGenerator((input) => {
      const valid = cardFor(input)
      return evidenceCardSchema.parse({
        ...valid,
        claims: [{
          ...valid.claims[0]!,
          citations: [{ ...valid.claims[0]!.citations[0]!, quote: 'not from source' }],
        }],
      })
    })
    const invalidResult = await worker(store, invalidGenerator, invalidRun.service.broker).runOnce(
      'tenant-a', invalidRun.runId, 'invalid-worker', new AbortController().signal,
    )
    expect(invalidResult).toMatchObject({
      outcome: 'failed',
      run: { status: 'failed', error: { code: 'citation_invalid', stage: 'mapping' } },
    })
  })

  it('ignores a late result after cancellation and removes derived data with content deletion', async () => {
    const store = new InMemoryJobStore()
    const prepared = await prepareRun(store, 'tenant-a')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const generator = new FixtureGenerator(asyncInput => cardFor(asyncInput))
    generator.map = async (input, signal) => {
      generator.calls.push(input)
      await gate
      if (signal.aborted) throw signal.reason
      return { card: cardFor(input) }
    }
    const running = worker(store, generator, prepared.service.broker).runOnce(
      'tenant-a', prepared.runId, 'worker-1', new AbortController().signal,
    )
    while (generator.calls.length === 0) await Promise.resolve()
    const snapshot = await prepared.service.getRun('tenant-a', prepared.runId)
    await prepared.service.cancel('tenant-a', prepared.runId, snapshot.revision)
    release()
    expect(await running).toMatchObject({ outcome: 'stopped', run: { status: 'cancelled' } })
    expect(await store.listEvidenceCards('tenant-a', prepared.runId)).toEqual([])

    const completed = await prepareRun(store, 'tenant-a', hash('delete-run'))
    await worker(store, new FixtureGenerator(), completed.service.broker).runOnce(
      'tenant-a', completed.runId, 'worker-delete', new AbortController().signal,
    )
    expect(await store.getEvidenceGraph('tenant-a', completed.runId)).toBeDefined()
    await completed.service.deleteContent('tenant-a', completed.runId)
    expect(await store.getEvidenceGraph('tenant-a', completed.runId)).toBeUndefined()
    expect(await store.listEvidenceCards('tenant-a', completed.runId)).toEqual([])
  })

  it('rejects cross-scope leases and leaves no graph or event after an invalid atomic commit', async () => {
    const store = new InMemoryJobStore()
    const completed = await prepareRun(store, 'tenant-a', hash('scope-source'))
    const generator = new FixtureGenerator()
    const result = await worker(store, generator, completed.service.broker).runOnce(
      'tenant-a', completed.runId, 'worker-scope', new AbortController().signal,
    )
    if (result.outcome !== 'completed') throw new Error('expected completed evidence pipeline')
    const mapped = generator.calls[0]!
    const lease = await store.acquireLease({
      tenantId: 'tenant-a',
      runId: completed.runId,
      nodeKey: 'evidence:pipeline',
      ownerId: 'worker-scope-2',
      now: 1_000,
      durationMs: 1_000,
    })
    expect(lease).toBeDefined()
    await expect(store.storeEvidenceCard({
      tenantId: 'tenant-b',
      runId: completed.runId,
      lease: { tenantId: 'tenant-a', ...lease! },
      now: 1_000,
      cacheKey: hash('scope-cache'),
      cardHash: hash('scope-card'),
      chunk: mapped.chunk,
      card: cardFor(mapped),
      expiresAt: 2_000,
    })).rejects.toThrow(/lease identity/)

    const atomic = await prepareRun(store, 'tenant-a', hash('atomic-source'))
    const queued = await atomic.service.getRun('tenant-a', atomic.runId)
    const merging = await store.transitionRun('tenant-a', atomic.runId, queued.revision, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'merging',
        stage: 'merging',
        updatedAt: 1_000,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'atomic-merging',
          runId: run.id,
          runRevision: next.revision,
          sequence,
          createdAt: 1_000,
          stage: 'merging',
        }),
      }
    })
    if (merging.outcome !== 'updated') throw new Error('expected merging transition')
    const atomicLease = await store.acquireLease({
      tenantId: 'tenant-a',
      runId: atomic.runId,
      nodeKey: 'evidence:pipeline',
      ownerId: 'worker-atomic',
      now: 1_000,
      durationMs: 1_000,
    })
    expect(atomicLease).toBeDefined()
    const eventCount = (await atomic.service.listEvents('tenant-a', atomic.runId)).length
    const graph = { ...result.graph, runId: atomic.runId }
    expect(await store.commitEvidenceGraph({
      tenantId: 'tenant-a',
      runId: 'missing-run',
      expectedRevision: 1,
      lease: {
        tenantId: 'tenant-a',
        runId: 'missing-run',
        nodeKey: 'evidence:pipeline',
        ownerId: 'missing-worker',
        attempt: 1,
      },
      graph: { ...graph, runId: 'missing-run' },
      now: 1_000,
      build: () => { throw new Error('must not build a missing run') },
    })).toEqual({ outcome: 'missing' })
    expect(await store.commitEvidenceGraph({
      tenantId: 'tenant-a',
      runId: atomic.runId,
      expectedRevision: merging.run.revision - 1,
      lease: { tenantId: 'tenant-a', ...atomicLease! },
      graph,
      now: 1_000,
      build: () => { throw new Error('must not build a stale revision') },
    })).toMatchObject({ outcome: 'revision_conflict', run: { revision: merging.run.revision } })
    await expect(store.commitEvidenceGraph({
      tenantId: 'tenant-a',
      runId: atomic.runId,
      expectedRevision: merging.run.revision,
      lease: { tenantId: 'tenant-a', ...atomicLease! },
      graph,
      now: 1_000,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          updatedAt: 1_000,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'atomic-invalid-sequence',
            runId: run.id,
            runRevision: next.revision,
            sequence: sequence + 1,
            createdAt: 1_000,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toThrow(/evidence commit identity/)
    expect(await store.getEvidenceGraph('tenant-a', atomic.runId)).toBeUndefined()
    expect(await atomic.service.getRun('tenant-a', atomic.runId)).toMatchObject({
      revision: merging.run.revision,
      status: 'merging',
    })
    expect(await atomic.service.listEvents('tenant-a', atomic.runId)).toHaveLength(eventCount)
  })
})
