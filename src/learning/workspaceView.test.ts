import { describe, expect, it } from 'vitest'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { learningBase, LearningError, type CourseSnapshot, type LearningArchive } from './model'
import { archivedQuestions, referenceAnswer, safeLearningMessage, sourceExcerpt, visibleQuestions } from './workspaceView'

async function fixture() {
  const f = await localArtifactFixtures()
  const archive: LearningArchive = { ...learningBase('course'), kind: 'archive', originDocId: f.doc.id, provenanceDocId: f.doc.id, runId: f.quiz.runId, title: '公开测试', manifest: f.task.request.manifest, sources: [f.source], artifacts: [f.quiz, f.mindmap], contentHash: 'unused' }
  return { f, archive }
}
describe('archive workspace views', () => {
  it('only confirmed question associations appear in a point-specific practice list', async () => {
    const { archive } = await fixture(); const questions = archivedQuestions([archive])
    const point = { id: 'point', status: 'active', questionRefs: [{ ...questions[0].ref, confirmed: false }, { ...questions[1].ref, confirmed: true }] }
    const snapshot = { archives: [archive], points: [point] } as CourseSnapshot
    expect(visibleQuestions(snapshot)).toHaveLength(3); expect(visibleQuestions(snapshot, 'point').map((q) => q.ref.questionId)).toEqual([questions[1].ref.questionId])
    expect(visibleQuestions(snapshot, 'missing')).toEqual([])
    expect(visibleQuestions({ ...snapshot, points: [{ ...point, status: 'pending' }] } as CourseSnapshot, 'point')).toEqual([])
  })
  it('compares each supported reference answer and never renders unknown exception details', async () => {
    const { archive } = await fixture(); const questions = archivedQuestions([archive])
    expect(referenceAnswer(questions[0])).toBe('正确项'); expect(referenceAnswer(questions[1])).toBe('错误'); expect(referenceAnswer(questions[2])).toBe(questions[2].question.type === 'short-answer' ? questions[2].question.answer : '')
    const trueItem = { ...questions[1], question: { ...questions[1].question, type: 'true-false' as const, answer: true } }
    expect(referenceAnswer(trueItem)).toBe('正确')
    expect(safeLearningMessage(new LearningError('conflict', '请重新读取'))).toBe('请重新读取')
    expect(safeLearningMessage(new Error('secret detail'))).not.toContain('secret'); expect(safeLearningMessage(null)).toContain('未完成')
  })
  it('rejects invalid source offsets and truncates large source quotes without changing the archive', async () => {
    const { archive, f } = await fixture(); expect(sourceExcerpt(archive, f.source.id, 0, f.source.text.length)?.quote).toBe(f.source.text)
    for (const [start, end] of [[-1, 2], [0.5, 2], [2, 2], [0, f.source.text.length + 1]]) expect(sourceExcerpt(archive, f.source.id, start, end)).toBeUndefined()
    expect(sourceExcerpt(archive, 'missing', 0, 1)).toBeUndefined()
    const large = { ...archive, sources: [{ ...f.source, text: '文'.repeat(6000) }] }
    expect(sourceExcerpt(large, f.source.id, 0, 6000)).toMatchObject({ quote: '文'.repeat(4000), truncated: true })
  })
})
