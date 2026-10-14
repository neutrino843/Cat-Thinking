import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../store/db'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { installLearningTestStore } from './testStore'
import { learningBase, type AssessmentEvent, type KnowledgeRelation, type PracticeAttempt, type ReviewSchedule } from './model'
import { appendAssessment, appendAttempt, attachDocument, commitGraphChanges, createCourse, createLearningArchive, deleteCourseOrganisation, deleteLearningArchive, deletePracticeHistory, loadCourseSnapshot, loadLearningArchive, saveEntity, saveLearningBatch, savePracticeBundle } from './repository'
import { mergeKnowledgePoints, undoKnowledgeMerge } from './knowledgeGraph'

beforeEach(() => { installLearningTestStore() })
afterEach(() => { vi.restoreAllMocks() })
async function setup() {
  const fixture = await localArtifactFixtures(); const course = await createCourse({ name: '公开合成测试课程' })
  await db.docs.add({ id: fixture.doc.id, title: fixture.doc.title, createdAt: 1, updatedAt: 1, payload: JSON.stringify(fixture.doc) }); await db.sources.add(fixture.source); await db.analysisTasks.add(fixture.task)
  const archive = await createLearningArchive({ courseId: course.id, docId: fixture.doc.id, runId: fixture.quiz.runId, artifacts: [fixture.mindmap, fixture.quiz] })
  const question = { archiveId: archive.id, artifactId: fixture.quiz.id, questionId: 'choice', confirmed: false }
  const attempt: PracticeAttempt = { ...learningBase(course.id, 'synthetic-attempt', 1), kind: 'attempt', question, answer: 0, submittedAt: 1, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' }
  return { ...fixture, course, archive, question, attempt }
}
const eventFor = (attempt: PracticeAttempt, id: string, outcome: AssessmentEvent['outcome'] = 'success'): AssessmentEvent => ({ ...learningBase(attempt.courseId, id, 1), kind: 'assessment', attemptId: attempt.id, outcome, difficulty: 'good', selfAssessmentComplete: true })
const scheduleFor = (attempt: PracticeAttempt): ReviewSchedule => ({ ...learningBase(attempt.courseId, 'synthetic-schedule', 1), kind: 'schedule', question: attempt.question, status: 'active', dueDate: '2026-10-14', stage: 0, manual: true, ruleVersion: 'manual-v1' })

describe('learning repository transactional contracts', () => {
  it('archives once, retains original docs, and works after live task and sources expire', async () => {
    const f = await setup(); const repeated = await createLearningArchive({ courseId: f.course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.mindmap, f.quiz] })
    expect(repeated.id).toBe(f.archive.id); await db.analysisTasks.delete(f.doc.id); await db.sources.delete(f.source.id)
    expect((await loadLearningArchive(f.archive.id))?.sources[0].text).toBe(f.source.text)
    expect((await loadCourseSnapshot(f.course.id)).points.every((p) => p.status === 'pending' && p.questionRefs.every((r) => !r.confirmed))).toBe(true)
    expect(await db.docs.get(f.doc.id)).toBeDefined()
  })
  it('does not create duplicate archives when the same verified artifact set is selected in another order', async () => {
    const f = await setup(); const reversed = await createLearningArchive({ courseId: f.course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.quiz, f.mindmap] })
    expect(reversed.id).toBe(f.archive.id); expect((await loadCourseSnapshot(f.course.id)).archives).toHaveLength(1)
  })
  it('does not duplicate a live document into two courses', async () => {
    const f = await setup(); const other = await createCourse({ name: '另一课程' }); await expect(attachDocument(other.id, f.doc.id)).rejects.toThrow(/另一门课程/)
  })
  it('rejects stale CAS writes and cross-course reference substitution', async () => {
    const f = await setup(); const snapshot = await loadCourseSnapshot(f.course.id); const point = snapshot.points[0]
    await saveEntity({ ...point, notes: '先保存' }, point.revision); await expect(saveEntity({ ...point, notes: '过期覆盖' }, point.revision)).rejects.toThrow(/其他页面/)
    const other = await createCourse({ name: '其他课程' }); await expect(appendAttempt({ ...f.attempt, courseId: other.id })).rejects.toThrow(/题目归档/)
  })
  it('concurrent duplicate submissions persist only one immutable attempt', async () => {
    const f = await setup(); await Promise.all([appendAttempt(f.attempt), appendAttempt(f.attempt)])
    expect((await loadCourseSnapshot(f.course.id)).attempts).toHaveLength(1)
    await expect(appendAttempt({ ...f.attempt, answer: 1 })).rejects.toThrow(/其他页面/)
  })
  it('preserves same-timestamp assessment append order independently of key sorting', async () => {
    const f = await setup(); await appendAttempt(f.attempt)
    const first = eventFor(f.attempt, 'z-first', 'failure'); const second = eventFor(f.attempt, 'a-second', 'success')
    await appendAssessment(first); await appendAssessment(second); await appendAssessment(first)
    const events = (await loadCourseSnapshot(f.course.id)).assessments
    expect(events.map((e) => [e.id, e.sequence])).toEqual([['z-first', 1], ['a-second', 2]])
  })
  it('rolls back attempt and assessment if schedule has a conflict', async () => {
    const f = await setup(); const schedule = await saveEntity(scheduleFor(f.attempt), null)
    await expect(savePracticeBundle(f.attempt, eventFor(f.attempt, 'synthetic-event'), { ...schedule, dueDate: '2026-10-15' }, null)).rejects.toThrow(/其他页面/)
    const snapshot = await loadCourseSnapshot(f.course.id); expect(snapshot.attempts).toHaveLength(0); expect(snapshot.assessments).toHaveLength(0); expect(snapshot.schedules[0].dueDate).toBe('2026-10-14')
  })
  it('submits the durable draft and clears it atomically; later writes cannot resurrect it', async () => {
    const f = await setup(); const draft = await saveEntity({ ...learningBase(f.course.id, 'synthetic-draft', 1), kind: 'draft', question: f.question, answer: 0, answerRevealed: false, attemptId: f.attempt.id }, null)
    await savePracticeBundle(f.attempt, eventFor(f.attempt, 'synthetic-event'), undefined, null, { kind: 'draft', id: draft.id, expectedRevision: draft.revision })
    const snapshot = await loadCourseSnapshot(f.course.id); expect(snapshot.drafts).toHaveLength(0); expect(snapshot.attempts).toHaveLength(1)
    await expect(saveEntity(draft, null)).rejects.toThrow(/其他页面/)
  })
  it('validates answer types against immutable question schema, not only generic JSON', async () => {
    const f = await setup(); await expect(appendAttempt({ ...f.attempt, answer: 'fake choice' })).rejects.toThrow(/作答类型/)
    await expect(appendAttempt({ ...f.attempt, answer: 50 })).rejects.toThrow(/作答类型/)
  })
  it('refuses a second schedule identity for the same archived question', async () => {
    const f = await setup(); await saveEntity(scheduleFor(f.attempt), null)
    await expect(saveEntity({ ...scheduleFor(f.attempt), id: 'duplicate-schedule' }, null)).rejects.toThrow(/已有有效/)
  })
  it('clearing history pauses derived schedules and fences deleted answers', async () => {
    const f = await setup(); await savePracticeBundle(f.attempt, eventFor(f.attempt, 'synthetic-event'), scheduleFor(f.attempt))
    await deletePracticeHistory(f.course.id, f.course.revision); const snapshot = await loadCourseSnapshot(f.course.id)
    expect(snapshot.attempts).toHaveLength(0); expect(snapshot.assessments).toHaveLength(0); expect(snapshot.schedules[0].status).toBe('paused')
    await expect(appendAttempt(f.attempt)).rejects.toThrow(/其他页面/)
  })
  it('deletes archive answer content and generated definitions while retaining explicit user notes and documents', async () => {
    const f = await setup(); await savePracticeBundle(f.attempt, eventFor(f.attempt, 'synthetic-event'), scheduleFor(f.attempt))
    const snapshot = await loadCourseSnapshot(f.course.id); await saveEntity({ ...snapshot.points[0], notes: '个人笔记' }, snapshot.points[0].revision)
    await deleteLearningArchive(f.course.id, f.archive.id, f.archive.revision); const result = await loadCourseSnapshot(f.course.id)
    expect(result.archives).toHaveLength(0); expect(result.attempts).toHaveLength(0); expect(result.assessments).toHaveLength(0); expect(result.schedules).toHaveLength(0)
    expect(result.points.every((p) => p.title === '已删除学习资料' && !p.definition && !p.sourceRefs.length && !p.questionRefs.length && p.status === 'retired')).toBe(true)
    expect(result.points.some((p) => p.notes === '个人笔记')).toBe(true); expect(await db.docs.get(f.doc.id)).toBeDefined()
  })
  it('course destruction leaves editable docs and prevents stale course recreation', async () => {
    const f = await setup(); await deleteCourseOrganisation(f.course.id, f.course.revision)
    await expect(saveEntity(f.course, null)).rejects.toThrow(/其他页面/); expect(await db.docs.get(f.doc.id)).toBeDefined()
  })
  it('enforces whole-graph CAS and detects concurrently added prerequisite edges', async () => {
    const f = await setup(); const s = await loadCourseSnapshot(f.course.id); const [a, b] = s.points
    const active = s.points.map((p) => ({ ...p, status: 'active' as const })); await saveLearningBatch(active.map((entity) => ({ entity, expectedRevision: entity.revision })))
    const current = await loadCourseSnapshot(f.course.id); const expected = { points: Object.fromEntries(current.points.map((p) => [p.id, p.revision])), relations: {} }
    const relation: KnowledgeRelation = { ...learningBase(f.course.id, 'edge-a'), kind: 'relation', fromPointId: a.id, toPointId: b.id, type: 'prerequisite', confirmed: true }
    await commitGraphChanges(f.course.id, { points: current.points, relations: [relation] }, expected)
    await expect(commitGraphChanges(f.course.id, { points: current.points, relations: [{ ...relation, id: 'edge-b', fromPointId: b.id, toPointId: a.id }] }, expected)).rejects.toThrow(/其他页面/)
    const next = await loadCourseSnapshot(f.course.id)
    await expect(commitGraphChanges(f.course.id, { points: next.points, relations: [relation, { ...relation, id: 'edge-b', fromPointId: b.id, toPointId: a.id }] }, { points: expected.points, relations: { [relation.id]: relation.revision } })).rejects.toThrow(/循环/)
  })
  it('merge removes self-relations and undo restores both identity and old association atomically', async () => {
    const f = await setup(); const s = await loadCourseSnapshot(f.course.id)
    await saveLearningBatch(s.points.map((p) => ({ entity: { ...p, status: 'active' }, expectedRevision: p.revision })))
    let current = await loadCourseSnapshot(f.course.id); const [a, b] = current.points
    const edge: KnowledgeRelation = { ...learningBase(f.course.id, 'compare-edge'), kind: 'relation', fromPointId: a.id, toPointId: b.id, type: 'comparison', confirmed: true }; await saveEntity(edge, null)
    current = await loadCourseSnapshot(f.course.id)
    const expected = () => ({ points: Object.fromEntries(current.points.map((p) => [p.id, p.revision])), relations: Object.fromEntries(current.relations.map((p) => [p.id, p.revision])) })
    await commitGraphChanges(f.course.id, mergeKnowledgePoints(current, a.id, b.id, { eventId: 'merge-event', at: 10, confirmed: true }), expected())
    current = await loadCourseSnapshot(f.course.id); expect(current.relations).toHaveLength(0)
    await commitGraphChanges(f.course.id, undoKnowledgeMerge(current, 'merge-event', { eventId: 'undo-event', at: 20 }), expected())
    current = await loadCourseSnapshot(f.course.id); expect(current.points.every((p) => p.status === 'active')).toBe(true); expect(current.relations[0].id).toBe(edge.id)
  })
  it('versions the confirmed goal scope, while notes and pending goals do not change its denominator', async () => {
    const f = await setup(); let current = await loadCourseSnapshot(f.course.id); expect(current.course.goalVersion).toBe(1)
    const first = await saveEntity({ ...current.points[0], status: 'active' }, current.points[0].revision)
    current = await loadCourseSnapshot(f.course.id); expect(current.course.goalVersion).toBe(2); expect(current.course.revision).toBe(f.course.revision + 1)
    const edited = await saveEntity({ ...first, notes: '笔记变化' }, first.revision); current = await loadCourseSnapshot(f.course.id); expect(current.course.goalVersion).toBe(2)
    await saveEntity({ ...edited, goalIncluded: false }, edited.revision); current = await loadCourseSnapshot(f.course.id); expect(current.course.goalVersion).toBe(3)
    await expect(saveEntity({ ...f.course, name: '过期课程设置' }, f.course.revision)).rejects.toThrow(/其他页面/)
  })
  it('archive removal preserves unrelated merges and scrubs affected snapshots without losing identity aliases', async () => {
    const f = await setup(); let current = await loadCourseSnapshot(f.course.id)
    await saveLearningBatch(current.points.map((p) => ({ entity: { ...p, status: 'active' }, expectedRevision: p.revision })))
    const manual = (id: string) => ({ ...learningBase(f.course.id, id), kind: 'point' as const, title: id, definition: '个人定义', chapter: '', aliases: [], notes: '', sourceRefs: [], questionRefs: [], status: 'active' as const })
    await saveEntity(manual('manual-a'), null); await saveEntity(manual('manual-b'), null)
    const expected = () => ({ points: Object.fromEntries(current.points.map((p) => [p.id, p.revision])), relations: Object.fromEntries(current.relations.map((p) => [p.id, p.revision])) })
    current = await loadCourseSnapshot(f.course.id); await commitGraphChanges(f.course.id, mergeKnowledgePoints(current, 'manual-a', 'manual-b', { eventId: 'unrelated-merge', at: 10, confirmed: true }), expected())
    current = await loadCourseSnapshot(f.course.id); const generated = current.points.filter((p) => p.archiveId === f.archive.id)
    await commitGraphChanges(f.course.id, mergeKnowledgePoints(current, generated[0].id, generated[1].id, { eventId: 'related-merge', at: 20, confirmed: true }), expected())
    current = await loadCourseSnapshot(f.course.id); const version = current.course.goalVersion
    await deleteLearningArchive(f.course.id, f.archive.id, f.archive.revision); current = await loadCourseSnapshot(f.course.id)
    expect(current.course.goalVersion).toBe(version + 1)
    expect(current.merges.find((e) => e.id === 'unrelated-merge')?.beforePoints).toHaveLength(2)
    expect(current.merges.find((e) => e.id === 'related-merge')).toMatchObject({ fromPointId: generated[0].id, toPointId: generated[1].id, undoDisabledReason: expect.any(String) })
    expect(current.merges.find((e) => e.id === 'related-merge')?.beforePoints).toBeUndefined()
  })
  it('keeps grouped exam attempts within the selected questions and supports partial ending without false completion', async () => {
    const f = await setup(); const session = await saveEntity({ ...learningBase(f.course.id, 'exam-session', 1), kind: 'session', purpose: 'exam', title: '合成模拟练习', pointIds: [], steps: [], questions: [f.question], status: 'active' }, null)
    await expect(saveEntity({ ...session, status: 'completed' }, session.revision)).rejects.toThrow(/未提交/)
    await expect(appendAttempt({ ...f.attempt, id: 'outside-exam', sessionId: session.id, question: { ...f.question, questionId: 'boolean' }, answer: false })).rejects.toThrow(/不属于该场次/)
    const attempt = { ...f.attempt, sessionId: session.id }; await appendAttempt(attempt)
    await saveEntity({ ...session, status: 'completed' }, session.revision)
    await expect(appendAttempt({ ...attempt, id: 'late-exam-attempt' })).rejects.toThrow(/场次已结束/)
    expect((await appendAttempt(attempt)).id).toBe(attempt.id)
    await deletePracticeHistory(f.course.id, f.course.revision); const snapshot = await loadCourseSnapshot(f.course.id)
    expect(snapshot.sessions[0].status).toBe('ended'); expect(snapshot.attempts).toHaveLength(0)
  })
})
