import { describe, expect, it } from 'vitest'
import { analysisRequestSchema, artifactEnvelopeSchema, type AnalysisEventV1 } from '@cat-thinking/analysis-contracts'
import requestFixture from '../../packages/analysis-contracts/fixtures/analysis-request.valid.json'
import summaryFixture from '../../packages/analysis-contracts/fixtures/summary-artifact.valid.json'
import { sha256Hex } from './fingerprint'
import { MockAnalysisEngineClient } from './mockEngine'

const signal = (): AbortSignal => new AbortController().signal

const requestForContent = async (content: string) => analysisRequestSchema.parse({
  ...requestFixture,
  manifest: {
    ...requestFixture.manifest,
    sources: [
      {
        ...requestFixture.manifest.sources[0],
        contentHash: await sha256Hex(content),
        charCount: content.length,
        byteCount: new TextEncoder().encode(content).byteLength,
        selectedRange: { start: 0, end: content.length },
      },
    ],
  },
})

const events: AnalysisEventV1[] = [
  {
    version: 1,
    type: 'run.accepted',
    eventId: 'event-0',
    runId: 'run-1',
    runRevision: 1,
    sequence: 0,
    createdAt: 1791500000000,
    requestKey: 'c'.repeat(64),
  },
  {
    version: 1,
    type: 'progress.updated',
    eventId: 'event-1',
    runId: 'run-1',
    runRevision: 2,
    sequence: 1,
    createdAt: 1791500000100,
    stage: 'mapping',
    progress: 0.5,
  },
]

describe('deterministic mock analysis engine', () => {
  it('reuses request keys and requires complete source upload before start', async () => {
    const content = 'x'.repeat(1200)
    const request = await requestForContent(content)
    const client = new MockAnalysisEngineClient({
      createRunId: () => 'run-1',
      now: () => 1791500000000,
      events,
    })

    const created = await client.createRun(request, signal())
    const reused = await client.createRun(request, signal())
    await expect(client.startRun(created.run.id, 1, signal())).rejects.toThrow(/incomplete/)

    const receipt = await client.uploadSource(
      created.run.id,
      {
        version: 1,
        sourceId: 'source-photosynthesis',
        contentHash: request.manifest.sources[0]!.contentHash,
        partHash: await sha256Hex(content),
        partIndex: 0,
        partCount: 1,
        start: 0,
        end: 1200,
        totalChars: 1200,
        text: content,
      },
      signal(),
    )
    const started = await client.startRun(created.run.id, 1, signal())

    expect(created.reused).toBe(false)
    expect(reused.reused).toBe(true)
    expect(receipt.complete).toBe(true)
    expect(started.status).toBe('queued')
    expect(started.revision).toBe(2)
  })

  it('replays only events after Last-Event-ID', async () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1', events })
    await client.createRun(request, signal())
    const replayed: AnalysisEventV1[] = []

    for await (const event of client.events('run-1', { lastEventId: 'event-0', signal: signal() })) {
      replayed.push(event)
    }

    expect(replayed.map((event) => event.eventId)).toEqual(['event-1'])
  })

  it('honors cancellation and optimistic revision checks', async () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1', now: () => 1791500000000 })
    const created = await client.createRun(request, signal())

    await expect(client.cancel(created.run.id, 2, signal())).rejects.toThrow(/revision conflict/)
    const cancelled = await client.cancel(created.run.id, 1, signal())
    const snapshot = await client.getRun(created.run.id, signal())

    expect(cancelled.revision).toBe(2)
    expect(snapshot.status).toBe('cancelled')
  })

  it('stops immediately when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test abort'))
    const client = new MockAnalysisEngineClient()

    await expect(client.capabilities(controller.signal)).rejects.toThrow('test abort')
  })

  it('tracks multipart upload idempotently and deletes temporary content', async () => {
    const request = await requestForContent('abcd')
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1' })
    await client.createRun(request, signal())
    const base = {
      version: 1 as const,
      sourceId: 'source-photosynthesis',
      contentHash: request.manifest.sources[0]!.contentHash,
      partCount: 2,
      totalChars: 4,
    }

    const first = await client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('ab'), partIndex: 0, start: 0, end: 2, text: 'ab' },
      signal(),
    )
    const duplicate = await client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('ab'), partIndex: 0, start: 0, end: 2, text: 'ab' },
      signal(),
    )
    const complete = await client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('cd'), partIndex: 1, start: 2, end: 4, text: 'cd' },
      signal(),
    )

    expect(first.complete).toBe(false)
    expect(duplicate.receivedParts).toBe(1)
    expect(complete.complete).toBe(true)
    await expect(client.startRun('run-1', 1, signal())).resolves.toMatchObject({ status: 'queued' })
    await expect(client.deleteContent('run-1', signal())).resolves.toMatchObject({ deleted: true })
    await expect(client.startRun('run-1', 2, signal())).rejects.toThrow(/incomplete/)
  })

  it('rejects source identity and multipart metadata drift', async () => {
    const request = await requestForContent('abcd')
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1' })
    await client.createRun(request, signal())
    const validFirstPart = {
      version: 1 as const,
      sourceId: 'source-photosynthesis',
      contentHash: request.manifest.sources[0]!.contentHash,
      partHash: await sha256Hex('ab'),
      partIndex: 0,
      partCount: 2,
      start: 0,
      end: 2,
      totalChars: 4,
      text: 'ab',
    }

    await expect(
      client.uploadSource('run-1', { ...validFirstPart, sourceId: 'source-missing' }, signal()),
    ).rejects.toThrow(/does not match/)
    await client.uploadSource('run-1', validFirstPart, signal())
    await expect(
      client.uploadSource(
        'run-1',
        {
          ...validFirstPart,
          partCount: 3,
          partIndex: 1,
          start: 2,
          end: 4,
          text: 'cd',
        },
        signal(),
      ),
    ).rejects.toThrow(/metadata changed/)
  })

  it('rejects forged hashes, changed duplicate parts, and non-contiguous uploads', async () => {
    const request = await requestForContent('abcd')
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1' })
    await client.createRun(request, signal())
    const base = {
      version: 1 as const,
      sourceId: 'source-photosynthesis',
      contentHash: request.manifest.sources[0]!.contentHash,
      partCount: 2,
      totalChars: 4,
    }

    await expect(client.uploadSource(
      'run-1',
      { ...base, partHash: 'b'.repeat(64), partIndex: 0, start: 0, end: 2, text: 'ab' },
      signal(),
    )).rejects.toThrow(/part hash mismatch/)

    await client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('ab'), partIndex: 0, start: 0, end: 2, text: 'ab' },
      signal(),
    )
    await expect(client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('ac'), partIndex: 0, start: 0, end: 2, text: 'ac' },
      signal(),
    )).rejects.toThrow(/part changed/)
    await expect(client.uploadSource(
      'run-1',
      { ...base, partHash: await sha256Hex('c'), partIndex: 1, start: 3, end: 4, text: 'c' },
      signal(),
    )).rejects.toThrow(/not contiguous/)
  })

  it('retries only requested artifacts and increments the attempt', async () => {
    const request = analysisRequestSchema.parse({ ...requestFixture, artifacts: ['summary'] })
    const client = new MockAnalysisEngineClient({ createRunId: () => 'run-1', now: () => 1791500000000 })
    await client.createRun(request, signal())

    const retried = await client.retryArtifact('run-1', 'summary', 1, signal())
    const snapshot = await client.getRun('run-1', signal())

    expect(retried.revision).toBe(2)
    expect(snapshot).toMatchObject({ status: 'generating', stage: 'summary' })
    expect(snapshot.artifactStates.summary?.attempt).toBe(1)
    await expect(client.retryArtifact('run-1', 'quiz', 2, signal())).rejects.toThrow(/not requested/)
  })

  it('filters events for other runs and reports unknown runs', async () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const client = new MockAnalysisEngineClient({
      createRunId: () => 'run-1',
      events: [events[0]!, { ...events[1]!, runId: 'run-other' }],
    })
    await client.createRun(request, signal())
    const replayed: AnalysisEventV1[] = []

    for await (const event of client.events('run-1', { signal: signal() })) replayed.push(event)

    expect(replayed.map((event) => event.eventId)).toEqual(['event-0'])
    await expect(client.getRun('missing-run', signal())).rejects.toThrow(/Unknown mock run/)
  })

  it('reads configured artifacts and removes them with run content', async () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const artifact = artifactEnvelopeSchema.parse(summaryFixture)
    const client = new MockAnalysisEngineClient({
      createRunId: () => 'run-1',
      artifacts: [artifact],
    })
    await client.createRun(request, signal())

    await expect(client.getArtifact('run-1', 'summary', signal())).resolves.toEqual(artifact)
    await client.deleteContent('run-1', signal())
    await expect(client.getArtifact('run-1', 'summary', signal())).rejects.toThrow(/Unknown mock artifact/)
  })
})
