import { describe, expect, it } from 'vitest'
import type { AnalysisOptionsV1, ArtifactKind } from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'
import {
  createAnalysisRequestKey,
  createSourceSnapshot,
  sha256Hex,
  type DigestFunction,
} from './fingerprint'

const digest: DigestFunction = async (bytes) => {
  const output = new Uint8Array(32)
  bytes.forEach((byte, index) => {
    output[index % output.length] = (output[index % output.length]! + byte + index) % 256
  })
  return output.buffer
}

const source = (overrides: Partial<SourceDocument> = {}): SourceDocument => ({
  version: 1,
  id: 'source-1',
  docId: 'doc-1',
  name: 'original.docx',
  kind: 'docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 100,
  lastModified: 1,
  importedAt: 2,
  extractor: 'docx-v1',
  text: '光合作用',
  charCount: 4,
  anchors: [{ nodeId: 'node-1', start: 0, end: 4, locator: '第一节' }],
  ...overrides,
})

const options: AnalysisOptionsV1 = {
  locale: 'zh-CN',
  qualityProfile: 'standard',
  summaryDetail: 'standard',
  quizQuestionCount: 5,
  externalKnowledge: false,
}

describe('source fingerprint', () => {
  it('ignores display name and timestamps but changes with source text', async () => {
    const first = await createSourceSnapshot(source(), undefined, digest)
    const metadataChanged = await createSourceSnapshot(
      source({ name: 'renamed.docx', lastModified: 999, importedAt: 1_000 }),
      undefined,
      digest,
    )
    const textChanged = await createSourceSnapshot(
      source({ text: '光合作用。', charCount: 5, anchors: [{ nodeId: 'node-1', start: 0, end: 5 }] }),
      undefined,
      digest,
    )

    expect(metadataChanged.contentHash).toBe(first.contentHash)
    expect(textChanged.contentHash).not.toBe(first.contentHash)
  })

  it('rejects a selected range beyond the normalized source', async () => {
    await expect(createSourceSnapshot(source(), { start: 0, end: 5 }, digest)).rejects.toThrow(RangeError)
  })

  it('derives PDF page count from persisted anchors', async () => {
    const snapshot = await createSourceSnapshot(
      source({
        kind: 'pdf',
        name: 'lesson.pdf',
        mime: 'application/pdf',
        anchors: [
          { nodeId: 'node-1', start: 0, end: 2, page: 1 },
          { nodeId: 'node-2', start: 2, end: 4, page: 3 },
        ],
      }),
      undefined,
      digest,
    )

    expect(snapshot.pageCount).toBe(3)
  })
})

describe('analysis request key', () => {
  it('is stable for source and artifact ordering', async () => {
    const firstSource = await createSourceSnapshot(source(), undefined, digest)
    const secondSource = await createSourceSnapshot(
      source({ id: 'source-2', text: '碳反应', charCount: 3, anchors: [] }),
      undefined,
      digest,
    )
    const firstArtifacts: ArtifactKind[] = ['quiz', 'summary']
    const secondArtifacts: ArtifactKind[] = ['summary', 'quiz']

    const first = await createAnalysisRequestKey(
      {
        docId: 'doc-1',
        sources: [secondSource, firstSource],
        artifacts: firstArtifacts,
        options,
        engineCapabilityVersion: 'engine-v1',
      },
      digest,
    )
    const second = await createAnalysisRequestKey(
      {
        docId: 'doc-1',
        sources: [firstSource, secondSource],
        artifacts: secondArtifacts,
        options,
        engineCapabilityVersion: 'engine-v1',
      },
      digest,
    )

    expect(first).toBe(second)
  })

  it('changes when an analysis option changes', async () => {
    const snapshot = await createSourceSnapshot(source(), undefined, digest)
    const baseline = await createAnalysisRequestKey(
      {
        docId: 'doc-1',
        sources: [snapshot],
        artifacts: ['summary'],
        options,
        engineCapabilityVersion: 'engine-v1',
      },
      digest,
    )
    const changed = await createAnalysisRequestKey(
      {
        docId: 'doc-1',
        sources: [snapshot],
        artifacts: ['summary'],
        options: { ...options, summaryDetail: 'detailed' },
        engineCapabilityVersion: 'engine-v1',
      },
      digest,
    )

    expect(changed).not.toBe(baseline)
  })

  it('emits lowercase 64-character hashes', async () => {
    await expect(sha256Hex('abc', digest)).resolves.toMatch(/^[a-f0-9]{64}$/)
  })
})
