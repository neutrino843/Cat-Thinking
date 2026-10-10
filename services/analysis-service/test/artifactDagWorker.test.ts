import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  artifactEnvelopeSchema,
  evidenceGraphSchema,
  type AnalysisRequestV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type EvidenceGraphV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { ArtifactDagWorker } from '../src/domain/artifactDagWorker.js'
import { planArtifactBudget } from '../src/domain/artifactBudget.js'
import type {
  ArtifactGenerationInput,
  ArtifactGenerationOutput,
  ArtifactGenerator,
} from '../src/domain/artifactGenerator.js'
import {
  ArtifactValidationError,
  createArtifactDescriptor,
  validateArtifactDescriptor,
  validateGeneratedArtifact,
} from '../src/domain/artifactValidator.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const tenantId = 'tenant-artifact'
const sourceHash = hash('artifact source')
const citation = {
  version: 1 as const,
  provenance: 'source' as const,
  sourceId: 'source-artifact',
  start: 0,
  end: 4,
  quote: 'fact',
}

const requestFor = (
  artifacts: readonly ArtifactKind[] = ['summary', 'outline', 'mindmap', 'quiz', 'knowledge'],
  quizQuestionCount = 1,
): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey: hash(`artifact-request:${artifacts.join(',')}`),
  docId: 'doc-artifact',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-artifact',
      kind: 'text',
      extractor: 'fixture-v1',
      contentHash: sourceHash,
      charCount: 20,
      byteCount: 20,
    }],
  },
  artifacts,
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount,
    externalKnowledge: false,
  },
})

const graphFor = (runId: string): EvidenceGraphV1 => evidenceGraphSchema.parse({
  version: 1,
  runId,
  graphHash: hash(`graph:${runId}`),
  chunkPlanHash: hash('artifact chunks'),
  sourceContentHashes: [sourceHash],
  policyVersion: 'artifact-policy-v1',
  promptVersion: 'evidence-prompt-v1',
  generatorProfile: 'fixture-profile-v1',
  chunks: [{
    version: 1,
    chunkId: 'chunk-artifact',
    chunkHash: hash('artifact chunk'),
    sourceId: 'source-artifact',
    start: 0,
    end: 20,
    titlePath: [],
    estimatedTokens: 5,
    ordinal: 0,
    total: 1,
    overlapBefore: 0,
    overlapAfter: 0,
  }],
  cards: [{
    version: 1,
    chunkId: 'chunk-artifact',
    chunkHash: hash('artifact chunk'),
    sourceId: 'source-artifact',
    titlePath: [],
    claims: [{ id: 'claim-artifact', kind: 'fact', statement: 'grounded fact', conceptIds: [], citations: [citation] }],
    terms: [{ id: 'term-artifact', term: 'concept', definition: 'definition', citations: [citation] }],
    learningObjectives: [{ id: 'objective-artifact', text: 'understand fact', evidenceIds: ['claim-artifact'] }],
  }],
  claims: [{ id: 'claim-artifact', kind: 'fact', statement: 'grounded fact', conceptIds: [], citations: [citation] }],
  terms: [{ id: 'term-artifact', term: 'concept', definition: 'definition', citations: [citation] }],
  learningObjectives: [{ id: 'objective-artifact', text: 'understand fact', evidenceIds: ['claim-artifact'] }],
  coverage: { input: 1, analysis: 1, citation: 1, chunksCompleted: 1, chunksFailed: 0, chunksTotal: 1 },
  missingChunkIds: [],
  createdAt: 1_000,
})

const artifactFor = (input: ArtifactGenerationInput): ArtifactEnvelopeV1 => {
  const base = {
    version: 1 as const,
    schemaVersion: 1 as const,
    id: `artifact-${input.kind}`,
    runId: input.runId,
    docId: input.docId,
    kind: input.kind,
    sourceContentHashes: input.graph.sourceContentHashes,
    createdAt: 1_100,
    updatedAt: 1_100,
  }
  switch (input.kind) {
    case 'summary':
      return artifactEnvelopeSchema.parse({
        ...base,
        payload: {
          overview: { id: 'summary-overview', text: 'overview', evidenceIds: ['claim-artifact'], citations: [citation] },
          keyPoints: [{ id: 'summary-point', text: 'point', evidenceIds: ['claim-artifact'], citations: [citation] }],
          confusions: [],
        },
      })
    case 'outline':
      return artifactEnvelopeSchema.parse({
        ...base,
        payload: {
          title: 'Outline',
          nodes: [{
            id: 'outline-root',
            title: 'Root',
            evidenceIds: ['claim-artifact'],
            citations: [citation],
            children: [],
          }],
        },
      })
    case 'mindmap':
      return artifactEnvelopeSchema.parse({
        ...base,
        payload: {
          title: 'Mind map',
          nodes: [{
            id: 'mindmap-root',
            parentId: null,
            text: input.outline?.title ?? 'missing outline',
            evidenceIds: ['claim-artifact'],
            citations: [citation],
          }],
          relations: [],
        },
      })
    case 'quiz':
      return artifactEnvelopeSchema.parse({
        ...base,
        payload: {
          title: 'Quiz',
          questions: [{
            id: 'quiz-question',
            type: 'multiple-choice',
            prompt: 'Which fact is grounded?',
            options: ['grounded fact', 'unsupported'],
            answerIndex: 0,
            explanation: 'The source supports the first option.',
            difficulty: 'medium',
            evidenceIds: ['claim-artifact'],
            citations: [citation],
          }],
        },
      })
    case 'knowledge':
      return artifactEnvelopeSchema.parse({
        ...base,
        payload: {
          items: [{
            id: 'knowledge-item',
            title: 'Application',
            explanation: 'A grounded application.',
            relationship: 'application',
            provenance: 'source',
            evidenceIds: ['claim-artifact'],
            citations: [citation],
          }],
        },
      })
  }
}

class FixtureArtifactGenerator implements ArtifactGenerator {
  readonly calls: ArtifactGenerationInput[] = []
  readonly failures = new Set<ArtifactKind>()
  maxActive = 0
  private active = 0

  async generate(input: ArtifactGenerationInput, signal: AbortSignal): Promise<ArtifactGenerationOutput> {
    this.calls.push(input)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        }, { once: true })
      })
      if (this.failures.has(input.kind)) throw new Error(`fixture ${input.kind} failure`)
      return {
        artifact: artifactFor(input),
        route: {
          providerId: 'fixture-provider',
          modelId: 'fixture-model',
          profileVersion: 'fixture-profile-v1',
          promptVersion: `artifact-${input.kind}-v1`,
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostMicros: 2,
          actualCostMicros: 1,
          currency: 'USD',
        },
      }
    } finally {
      this.active -= 1
    }
  }
}

const prepareGeneratingRun = async (
  artifacts?: readonly ArtifactKind[],
  quizQuestionCount?: number,
): Promise<{ store: InMemoryJobStore; service: RunService; runId: string; graph: EvidenceGraphV1 }> => {
  const store = new InMemoryJobStore()
  let id = 0
  const service = new RunService({
    store,
    retentionSeconds: 3_600,
    now: () => 1_000,
    createId: () => `artifact-setup-${++id}`,
  })
  const created = await service.createRun(tenantId, requestFor(artifacts, quizQuestionCount))
  const graph = graphFor(created.run.id)
  const merging = await store.transitionRun(tenantId, created.run.id, 1, (run, sequence) => {
    const next = analysisRunSchema.parse({
      ...run,
      revision: 2,
      status: 'merging',
      stage: 'merging',
      progress: 0.45,
      coverage: graph.coverage,
      updatedAt: 1_000,
    })
    return {
      run: next,
      event: analysisEventSchema.parse({
        version: 1,
        type: 'stage.started',
        eventId: 'artifact-setup-merging',
        runId: run.id,
        runRevision: 2,
        sequence,
        createdAt: 1_000,
        stage: 'merging',
      }),
    }
  })
  expect(merging.outcome).toBe('updated')
  const lease = await store.acquireLease({
    tenantId,
    runId: created.run.id,
    nodeKey: 'evidence:pipeline',
    ownerId: 'evidence-worker',
    now: 1_000,
    durationMs: 1_000,
  })
  const committed = await store.commitEvidenceGraph({
    tenantId,
    runId: created.run.id,
    expectedRevision: 2,
    lease: { tenantId, ...lease! },
    graph,
    now: 1_000,
    build: (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 3,
        status: 'generating',
        stage: undefined,
        progress: 0.55,
        updatedAt: 1_000,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'evidence.ready',
          eventId: 'artifact-setup-evidence',
          runId: run.id,
          runRevision: 3,
          sequence,
          createdAt: 1_000,
          graphHash: graph.graphHash,
          cardCount: graph.cards.length,
          claimCount: graph.claims.length,
          coverage: graph.coverage,
        }),
      }
    },
  })
  expect(committed.outcome).toBe('updated')
  await store.releaseLease({ tenantId, ...lease! })
  return { store, service, runId: created.run.id, graph }
}

const workerFor = (store: InMemoryJobStore, service: RunService, generator: ArtifactGenerator, concurrency = 4) => {
  let id = 0
  return new ArtifactDagWorker({
    store,
    generator,
    broker: service.broker,
    leaseMs: 1_000,
    concurrency,
    now: () => 1_000,
    createId: () => `artifact-event-${++id}`,
  })
}

describe('artifact validation boundary', () => {
  it('accepts a source-grounded artifact and binds its descriptor to the exact payload', async () => {
    const { service, runId, graph } = await prepareGeneratingRun(['summary'])
    const run = await service.getRun(tenantId, runId)
    const artifact = artifactFor({
      runId,
      docId: run.docId,
      kind: 'summary',
      options: run.request.options,
      budget: planArtifactBudget('summary', run.request.options),
      graph,
    })

    expect(validateGeneratedArtifact({ artifact, expectedKind: 'summary', run, graph })).toEqual(artifact)
    const descriptor = createArtifactDescriptor(artifact)
    expect(() => validateArtifactDescriptor(artifact, descriptor)).not.toThrow()
    expect(() => validateArtifactDescriptor(artifact, { ...descriptor, artifactHash: hash('tampered') }))
      .toThrow(ArtifactValidationError)
  })

  it('rejects schedule, evidence, citation, and provenance mismatches', async () => {
    const { service, runId, graph } = await prepareGeneratingRun(['summary'])
    const run = await service.getRun(tenantId, runId)
    const artifact = artifactFor({
      runId,
      docId: run.docId,
      kind: 'summary',
      options: run.request.options,
      budget: planArtifactBudget('summary', run.request.options),
      graph,
    })
    if (artifact.kind !== 'summary') throw new Error('expected summary fixture')
    const missingEvidence = {
      ...artifact,
      payload: {
        ...artifact.payload,
        overview: { ...artifact.payload.overview, evidenceIds: ['claim-missing'] },
      },
    }
    const unboundCitation = {
      ...artifact,
      payload: {
        ...artifact.payload,
        overview: { ...artifact.payload.overview, evidenceIds: [] },
      },
    }
    const externalCitation = {
      ...artifact,
      payload: {
        ...artifact.payload,
        overview: {
          ...artifact.payload.overview,
          citations: [{ version: 1, provenance: 'external', externalSourceId: 'external-1' }],
        },
      },
    }

    for (const [candidate, expectedCode] of [
      [{ ...artifact, kind: 'summary' }, 'identity_invalid'],
      [missingEvidence, 'evidence_missing'],
      [unboundCitation, 'citation_unverified'],
      [externalCitation, 'provenance_unsupported'],
    ] as const) {
      try {
        validateGeneratedArtifact({
          artifact: candidate,
          expectedKind: expectedCode === 'identity_invalid' ? 'quiz' : 'summary',
          run,
          graph,
        })
        throw new Error('expected artifact validation to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactValidationError)
        expect((error as ArtifactValidationError).issues.map((issue) => issue.code)).toContain(expectedCode)
      }
    }

    expect(() => validateGeneratedArtifact({
      artifact,
      expectedKind: 'summary',
      run,
      graph,
      maxArtifactBytes: 1,
    })).toThrow(ArtifactValidationError)
  })

  it('rejects malformed identities and dependency/count violations while allowing marked knowledge inference', async () => {
    const { service, runId, graph } = await prepareGeneratingRun()
    const run = await service.getRun(tenantId, runId)
    expect(() => validateGeneratedArtifact({ artifact: { invalid: true }, expectedKind: 'summary', run, graph }))
      .toThrow(ArtifactValidationError)

    const summary = artifactFor({
      runId,
      docId: run.docId,
      kind: 'summary',
      options: run.request.options,
      budget: planArtifactBudget('summary', run.request.options),
      graph,
    })
    expect(() => validateGeneratedArtifact({
      artifact: { ...summary, runId: 'run-other' },
      expectedKind: 'summary',
      run,
      graph,
    })).toThrow(ArtifactValidationError)

    const mindmap = artifactFor({
      runId,
      docId: run.docId,
      kind: 'mindmap',
      options: run.request.options,
      budget: planArtifactBudget('mindmap', run.request.options),
      graph,
    })
    expect(() => validateGeneratedArtifact({ artifact: mindmap, expectedKind: 'mindmap', run, graph }))
      .toThrow(ArtifactValidationError)

    const knowledge = artifactFor({
      runId,
      docId: run.docId,
      kind: 'knowledge',
      options: run.request.options,
      budget: planArtifactBudget('knowledge', run.request.options),
      graph,
    })
    if (knowledge.kind !== 'knowledge') throw new Error('expected knowledge fixture')
    const inferredKnowledge = {
      ...knowledge,
      payload: {
        items: [{
          ...knowledge.payload.items[0],
          provenance: 'inference',
          evidenceIds: [],
          citations: [{ version: 1, provenance: 'inference', label: 'model inference' }],
        }],
      },
    }
    expect(validateGeneratedArtifact({
      artifact: inferredKnowledge,
      expectedKind: 'knowledge',
      run,
      graph,
    })).toMatchObject({ kind: 'knowledge' })

    const quizSetup = await prepareGeneratingRun(['quiz'], 2)
    const quizRun = await quizSetup.service.getRun(tenantId, quizSetup.runId)
    const quiz = artifactFor({
      runId: quizSetup.runId,
      docId: quizRun.docId,
      kind: 'quiz',
      options: quizRun.request.options,
      budget: planArtifactBudget('quiz', quizRun.request.options),
      graph: quizSetup.graph,
    })
    expect(() => validateGeneratedArtifact({
      artifact: quiz,
      expectedKind: 'quiz',
      run: quizRun,
      graph: quizSetup.graph,
    })).toThrow(ArtifactValidationError)

    const summaryOnly = await prepareGeneratingRun(['summary'])
    const summaryRun = await summaryOnly.service.getRun(tenantId, summaryOnly.runId)
    const unrequestedQuiz = artifactFor({
      runId: summaryOnly.runId,
      docId: summaryRun.docId,
      kind: 'quiz',
      options: summaryRun.request.options,
      budget: planArtifactBudget('quiz', summaryRun.request.options),
      graph: summaryOnly.graph,
    })
    expect(() => validateGeneratedArtifact({
      artifact: unrequestedQuiz,
      expectedKind: 'quiz',
      run: summaryRun,
      graph: summaryOnly.graph,
    })).toThrow(ArtifactValidationError)
  })
})

describe('artifact DAG worker', () => {
  it('validates worker options and handles inactive, completed, busy, aborted, and evidence-missing runs', async () => {
    const prepared = await prepareGeneratingRun(['summary'])
    const generator = new FixtureArtifactGenerator()
    expect(() => workerFor(prepared.store, prepared.service, generator, 0)).toThrow(RangeError)
    expect(() => new ArtifactDagWorker({
      store: prepared.store,
      generator,
      broker: prepared.service.broker,
      leaseMs: 0,
    })).toThrow(RangeError)
    expect(() => new ArtifactDagWorker({
      store: prepared.store,
      generator,
      broker: prepared.service.broker,
      leaseMs: 1_000,
    })).not.toThrow()

    const busyLease = await prepared.store.acquireLease({
      tenantId,
      runId: prepared.runId,
      nodeKey: 'artifacts:dag',
      ownerId: 'other-worker',
      now: 1_000,
      durationMs: 1_000,
    })
    expect(busyLease).toBeDefined()
    expect(await workerFor(prepared.store, prepared.service, generator).runOnce(
      tenantId,
      prepared.runId,
      'blocked-worker',
      new AbortController().signal,
    )).toMatchObject({ outcome: 'busy' })
    await prepared.store.releaseLease({ tenantId, ...busyLease! })

    const aborted = new AbortController()
    aborted.abort(new Error('shutdown'))
    expect(await workerFor(prepared.store, prepared.service, generator).runOnce(
      tenantId,
      prepared.runId,
      'aborted-worker',
      aborted.signal,
    )).toMatchObject({ outcome: 'stopped', run: { status: 'generating' } })

    const completed = await workerFor(prepared.store, prepared.service, generator).runOnce(
      tenantId,
      prepared.runId,
      'successful-worker',
      new AbortController().signal,
    )
    expect(completed).toMatchObject({ outcome: 'completed', run: { status: 'succeeded' } })
    expect(await workerFor(prepared.store, prepared.service, generator).runOnce(
      tenantId,
      prepared.runId,
      'replay-worker',
      new AbortController().signal,
    )).toMatchObject({ outcome: 'already_complete' })

    const inactiveStore = new InMemoryJobStore()
    const inactiveService = new RunService({ store: inactiveStore, retentionSeconds: 3_600, now: () => 1_000 })
    const inactive = await inactiveService.createRun(tenantId, requestFor(['summary']))
    expect(await workerFor(inactiveStore, inactiveService, generator).runOnce(
      tenantId,
      inactive.run.id,
      'inactive-worker',
      new AbortController().signal,
    )).toMatchObject({ outcome: 'stopped', run: { status: 'receiving' } })
    await inactiveService.cancel(tenantId, inactive.run.id, inactive.run.revision)
    expect(await workerFor(inactiveStore, inactiveService, generator).runOnce(
      tenantId,
      inactive.run.id,
      'cancelled-worker',
      new AbortController().signal,
    )).toMatchObject({ outcome: 'stopped', run: { status: 'cancelled' } })
    expect(await inactiveStore.acquireLease({
      tenantId,
      runId: inactive.run.id,
      nodeKey: 'artifacts:dag',
      ownerId: 'too-late-worker',
      now: 1_000,
      durationMs: 1_000,
    })).toBeUndefined()

    const missingGraph = await prepareGeneratingRun(['summary'])
    await missingGraph.service.deleteContent(tenantId, missingGraph.runId)
    expect(await workerFor(missingGraph.store, missingGraph.service, generator).runOnce(
      tenantId,
      missingGraph.runId,
      'missing-graph-worker',
      new AbortController().signal,
    )).toMatchObject({ outcome: 'failed', run: { status: 'failed' } })
  })

  it('generates five artifacts with bounded parallelism and runs mind map after outline', async () => {
    const { store, service, runId } = await prepareGeneratingRun()
    const generator = new FixtureArtifactGenerator()
    const result = await workerFor(store, service, generator, 2)
      .runOnce(tenantId, runId, 'artifact-worker', new AbortController().signal)

    expect(result).toMatchObject({ outcome: 'completed', run: { status: 'succeeded', progress: 1 } })
    expect(generator.maxActive).toBe(2)
    expect(generator.calls.every((call) => call.budget.maxOutputTokens > 0)).toBe(true)
    expect(generator.calls.map((call) => call.kind)).toEqual(['summary', 'outline', 'quiz', 'knowledge', 'mindmap'])
    expect(generator.calls.at(-1)?.outline?.title).toBe('Outline')
    expect(await store.listArtifactDescriptors(tenantId, runId)).toHaveLength(5)
    expect((await service.listEvents(tenantId, runId)).map((event) => event.type))
      .toEqual(expect.arrayContaining(['artifact.ready', 'run.completed']))
    expect((await store.getArtifact(tenantId, runId, 'summary'))?.artifact.kind).toBe('summary')
    expect(await service.getArtifact(tenantId, runId, 'summary')).toMatchObject({ kind: 'summary', runId })
    expect(await store.getArtifact('tenant-other', runId, 'summary')).toBeUndefined()
    expect(await store.listArtifactDescriptors('tenant-other', runId)).toBeUndefined()
    expect(await service.deleteContent(tenantId, runId)).toMatchObject({ deleted: true })
    expect(await store.getArtifact(tenantId, runId, 'summary')).toBeUndefined()
    expect(await store.listArtifactDescriptors(tenantId, runId)).toEqual([])
  })

  it('isolates a failed artifact and retries only that artifact without changing evidence', async () => {
    const { store, service, runId, graph } = await prepareGeneratingRun()
    const generator = new FixtureArtifactGenerator()
    generator.failures.add('quiz')
    const worker = workerFor(store, service, generator)
    const first = await worker.runOnce(tenantId, runId, 'artifact-worker', new AbortController().signal)
    const summaryBefore = await store.getArtifact(tenantId, runId, 'summary')

    expect(first.run.status).toBe('partial')
    expect(first.run.artifactStates.quiz).toMatchObject({ status: 'failed', attempt: 1 })
    generator.failures.delete('quiz')
    await service.retryArtifact(tenantId, runId, 'quiz', first.run.revision)
    const retried = await worker.runOnce(tenantId, runId, 'artifact-worker', new AbortController().signal)

    expect(retried.run.status).toBe('succeeded')
    expect(retried.run.artifactStates.quiz).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(generator.calls.filter((call) => call.kind === 'quiz')).toHaveLength(2)
    expect(generator.calls.filter((call) => call.kind === 'summary')).toHaveLength(1)
    expect((await store.getArtifact(tenantId, runId, 'summary'))?.descriptor.artifactHash)
      .toBe(summaryBefore?.descriptor.artifactHash)
    expect((await store.getEvidenceGraph(tenantId, runId))?.graphHash).toBe(graph.graphHash)
  })

  it('resumes an artifact left running by an interrupted worker', async () => {
    const { store, service, runId, graph } = await prepareGeneratingRun(['summary'])
    const interrupted = await store.transitionRun(tenantId, runId, 3, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 4,
        status: 'generating',
        stage: 'summary',
        artifactStates: {
          ...run.artifactStates,
          summary: { status: 'running', attempt: 1, updatedAt: 1_000 },
        },
        updatedAt: 1_000,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'interrupted-summary-start',
          runId,
          runRevision: next.revision,
          sequence,
          createdAt: 1_000,
          stage: 'summary',
        }),
      }
    })
    expect(interrupted.outcome).toBe('updated')
    const run = await service.getRun(tenantId, runId)
    const artifact = artifactFor({
      runId,
      docId: run.docId,
      kind: 'summary',
      options: run.request.options,
      budget: planArtifactBudget('summary', run.request.options),
      graph,
    })
    const descriptor = createArtifactDescriptor(artifact)
    const lease = await store.acquireLease({
      tenantId,
      runId,
      nodeKey: 'artifacts:dag',
      ownerId: 'invalid-commit-worker',
      now: 1_000,
      durationMs: 1_000,
    })
    expect(lease).toBeDefined()
    await expect(store.commitArtifact({
      tenantId,
      runId,
      kind: 'summary',
      expectedRevision: 4,
      expectedAttempt: 1,
      lease: { tenantId, ...lease! },
      now: 1_000,
      result: 'succeeded',
      artifact,
      descriptor,
      build: (current, sequence) => ({
        run: analysisRunSchema.parse({ ...current, revision: 5, updatedAt: 1_000 }),
        events: [analysisEventSchema.parse({
          version: 1,
          type: 'artifact.ready',
          eventId: 'mismatched-ready-event',
          runId,
          runRevision: 5,
          sequence,
          createdAt: 1_000,
          descriptor: { ...descriptor, artifactHash: hash('wrong event descriptor') },
        })],
      }),
    })).rejects.toThrow(/does not match its result/)
    expect(await store.getArtifact(tenantId, runId, 'summary')).toBeUndefined()
    expect(await service.getRun(tenantId, runId)).toMatchObject({ revision: 4 })
    await store.releaseLease({ tenantId, ...lease! })
    const generator = new FixtureArtifactGenerator()

    const resumed = await workerFor(store, service, generator).runOnce(
      tenantId,
      runId,
      'replacement-worker',
      new AbortController().signal,
    )
    expect(resumed).toMatchObject({ outcome: 'completed', run: { status: 'succeeded' } })
    expect(generator.calls.map((call) => call.kind)).toEqual(['summary'])
    expect((await store.getArtifact(tenantId, runId, 'summary'))?.artifact.kind).toBe('summary')
  })

  it('records a mind-map dependency failure without calling its generator', async () => {
    const { store, service, runId } = await prepareGeneratingRun()
    const generator = new FixtureArtifactGenerator()
    generator.failures.add('outline')
    const result = await workerFor(store, service, generator)
      .runOnce(tenantId, runId, 'artifact-worker', new AbortController().signal)

    expect(result.run.status).toBe('partial')
    expect(result.run.artifactStates.outline?.status).toBe('failed')
    expect(result.run.artifactStates.mindmap).toMatchObject({
      status: 'failed',
      error: { code: 'dependency_failed' },
    })
    expect(generator.calls.some((call) => call.kind === 'mindmap')).toBe(false)
  })

  it('ignores a provider result that arrives after the run is cancelled', async () => {
    const { store, service, runId } = await prepareGeneratingRun(['summary'])
    let announceStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    let releaseGeneration: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { releaseGeneration = resolve })
    const generator: ArtifactGenerator = {
      async generate(input) {
        announceStarted?.()
        await blocked
        return {
          artifact: artifactFor(input),
          route: {
            providerId: 'fixture-provider',
            modelId: 'fixture-model',
            profileVersion: 'fixture-profile-v1',
            promptVersion: 'artifact-summary-v1',
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostMicros: 1,
            currency: 'USD',
          },
        }
      },
    }
    const running = workerFor(store, service, generator).runOnce(
      tenantId,
      runId,
      'late-result-worker',
      new AbortController().signal,
    )
    await started
    const active = await service.getRun(tenantId, runId)
    await service.cancel(tenantId, runId, active.revision)
    releaseGeneration?.()

    expect(await running).toMatchObject({ outcome: 'stopped', run: { status: 'cancelled' } })
    expect(await store.getArtifact(tenantId, runId, 'summary')).toBeUndefined()
  })

  it('marks a run failed when its only artifact fails', async () => {
    const { store, service, runId } = await prepareGeneratingRun(['summary'])
    const generator = new FixtureArtifactGenerator()
    generator.failures.add('summary')
    const result = await workerFor(store, service, generator)
      .runOnce(tenantId, runId, 'artifact-worker', new AbortController().signal)

    expect(result.run).toMatchObject({ status: 'failed', error: { code: 'artifact_invalid' } })
    expect((await service.listEvents(tenantId, runId)).slice(-2).map((event) => event.type))
      .toEqual(['artifact.failed', 'run.failed'])
  })

  it('isolates a contract-valid artifact with the wrong run identity as an artifact validation failure', async () => {
    const { store, service, runId } = await prepareGeneratingRun(['summary'])
    const generator: ArtifactGenerator = {
      async generate(input) {
        return {
          artifact: { ...artifactFor(input), runId: 'run-other' },
          route: {
            providerId: 'fixture-provider',
            modelId: 'fixture-model',
            profileVersion: 'fixture-profile-v1',
            promptVersion: 'artifact-summary-v1',
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostMicros: 1,
            currency: 'USD',
          },
        }
      },
    }

    const result = await workerFor(store, service, generator).runOnce(
      tenantId,
      runId,
      'invalid-artifact-worker',
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      outcome: 'completed',
      run: {
        status: 'failed',
        artifactStates: { summary: { error: { code: 'artifact_invalid' } } },
      },
    })
  })

  it('rejects provider output that exceeds the planned token budget', async () => {
    const { store, service, runId } = await prepareGeneratingRun(['summary'])
    const generator: ArtifactGenerator = {
      async generate(input) {
        return {
          artifact: artifactFor(input),
          route: {
            providerId: 'fixture-provider',
            modelId: 'fixture-model',
            profileVersion: 'fixture-profile-v1',
            promptVersion: 'artifact-summary-v1',
          },
          usage: {
            inputTokens: 1,
            outputTokens: input.budget.maxOutputTokens + 1,
            estimatedCostMicros: 1,
            currency: 'USD',
          },
        }
      },
    }

    const result = await workerFor(store, service, generator).runOnce(
      tenantId,
      runId,
      'over-budget-worker',
      new AbortController().signal,
    )
    expect(result.run).toMatchObject({
      status: 'failed',
      artifactStates: { summary: { error: { code: 'budget_exceeded', category: 'budget' } } },
    })
  })
})
