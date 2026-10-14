import { describe, expect, it } from 'vitest'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { sha256Hex } from '../analysis/fingerprint'
import { archiveHashPayload, parseLearningEntity, parseSourceDocument, validateLearningArchive, validLearningDate } from './archiveValidation'
import { learningBase } from './model'
import { archivedFixture } from './testFixtures'

describe('strict learning schemas and archive identity', () => {
  it('retains a verified immutable archive without requiring a live task', async () => {
    const { archive } = await archivedFixture(); expect(await validateLearningArchive(archive)).toEqual(archive)
  })
  it('rejects changed original text even when the outer hash is recomputed', async () => {
    const { archive } = await archivedFixture(); archive.sources[0].text = archive.sources[0].text.replace('公开', '其他')
    archive.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(archive)))
    await expect(validateLearningArchive(archive)).rejects.toThrow()
  })
  it('rejects artifact payload modifications and identity substitution', async () => {
    const { archive } = await archivedFixture(); const changed = structuredClone(archive); changed.artifacts[0].id = 'other-artifact'
    await expect(validateLearningArchive(changed)).rejects.toThrow(/校验失败/)
    changed.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(changed))); changed.artifacts[0].docId = 'foreign-doc'
    await expect(validateLearningArchive(changed)).rejects.toThrow()
  })
  it('rejects unknown keys, future versions and invalid scheduling stages', async () => {
    const { archive } = await archivedFixture()
    expect(() => parseLearningEntity({ ...archive, apiKey: 'must-never-be-stored' })).toThrow()
    expect(() => parseLearningEntity({ ...archive, version: 2 })).toThrow()
    const schedule = { ...learningBase(archive.courseId), kind: 'schedule', question: { archiveId: archive.id, artifactId: 'synthetic-quiz', questionId: 'choice', confirmed: false }, status: 'active', dueDate: '2026-10-13', stage: 5, manual: false, ruleVersion: 'v1' }
    expect(() => parseLearningEntity(schedule)).toThrow()
    expect(() => parseLearningEntity({ ...schedule, stage: 0, dueDate: '2026-02-30' })).toThrow()
  })
  it('rejects malformed source bounds and preserves UTF-16 char count', async () => {
    const { source } = await archivedFixture(); expect(parseSourceDocument(source).charCount).toBe(source.text.length)
    expect(() => parseSourceDocument({ ...source, charCount: source.text.length - 1 })).toThrow()
    expect(() => parseSourceDocument({ ...source, anchors: [{ nodeId: 'n', start: 0, end: source.text.length + 1 }] })).toThrow()
  })
  it('rejects sparse or inconsistent review dates', () => {
    expect(validLearningDate('2028-02-29')).toBe(true); expect(validLearningDate('2026-02-29')).toBe(false); expect(validLearningDate('2026-2-3')).toBe(false)
  })
  it('does not accept an empty application rubric or claim completion from an empty response', () => {
    const task = { ...learningBase('synthetic-course'), kind: 'application', pointIds: [], title: '案例解释', prompt: '解释一个案例', response: '', rubric: ['说明原因'], checks: [false], status: 'pending' }
    expect(parseLearningEntity(task).kind).toBe('application')
    expect(() => parseLearningEntity({ ...task, rubric: [], checks: [] })).toThrow()
    expect(() => parseLearningEntity({ ...task, rubric: ['  '] })).toThrow()
    expect(() => parseLearningEntity({ ...task, status: 'completed', checks: [true] })).toThrow()
    expect(() => parseLearningEntity({ ...task, status: 'completed', response: '有具体解释' })).toThrow()
    expect(parseLearningEntity({ ...task, status: 'completed', response: '有具体解释', checks: [true] }).kind).toBe('application')
  })
  it('rejects sparse alias arrays and duplicate question identities with contradictory confirmation', () => {
    const ref = { archiveId: 'a', artifactId: 'b', questionId: 'c', confirmed: false }
    const point = { ...learningBase('synthetic-course'), kind: 'point', title: '概念', definition: '', chapter: '', notes: '', aliases: [], sourceRefs: [], questionRefs: [ref], status: 'pending' }
    expect(() => parseLearningEntity({ ...point, aliases: new Array(1) })).toThrow()
    expect(() => parseLearningEntity({ ...point, questionRefs: [ref, { ...ref, confirmed: true }] })).toThrow()
  })
})
