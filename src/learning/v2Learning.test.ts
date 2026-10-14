import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as storage from '../store/db'
import { installLearningTestStore } from './testStore'
import { createExampleCourse } from './exampleCourse'
import { advanceSession, bindSession, createGuidedSession, resumableSessions, sessionInvalidReason, sessionStepIndex } from './session'
import { buildPersonalPlan, parsePersonalCapacity } from './personalPlan'
import { loadPersonalCapacity, savePersonalCapacity } from './preferences'
import { courseGoalCoverage } from './goalCoverage'
import { prepareLearningSupport, supportGeneration, supportSources } from './learningSupport'
import { appendAssessment, appendAttempt, createCourse, deleteLearningArchive, deletePracticeHistory, loadCourseSnapshot, saveEntity, updateCourse } from './repository'
import { learningBase, type CourseSnapshot, type LearningSession, type SupportMode } from './model'
import { exportCoursePackage, previewCoursePackage, restoreCoursePackage } from './coursePackage'
import { parseLearningEntity } from './archiveValidation'
import { assembleExamQuestions, examQuestionInventory } from './examPlan'
import { buildKnowledgeCoverage } from './coverageView'
import { prepareFreshAnalysis } from './freshAnalysis'
import { coursePlanCandidates } from './planCandidates'
import { questionRefKey } from './knowledgeGraph'

let store: ReturnType<typeof installLearningTestStore>
beforeEach(() => {
  store = installLearningTestStore(); vi.stubGlobal('Blob', NodeBlob); localStorage.clear()
  vi.spyOn(storage, 'saveDocumentBundle').mockImplementation(async (doc, sources) => {
    await storage.db.docs.put({ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, payload: JSON.stringify(doc) })
    await storage.db.sources.bulkPut(sources)
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function setup(): Promise<CourseSnapshot> {
  const example = await createExampleCourse(); await updateCourse({ ...example, example: false }); return loadCourseSnapshot(example.id)
}
describe('V2 resumable learning and real records', () => {
  it('creates checked offline example once and keeps it outside personal statistics', async () => {
    const course = await createExampleCourse(); expect((await createExampleCourse()).id).toBe(course.id)
    const data = await loadCourseSnapshot(course.id); expect(data.archives[0].artifacts[0].kind).toBe('quiz'); expect(data.points[0].status).toBe('active')
    expect(buildPersonalPlan([data], 0, { minutes: 20, questions: 10 }).selected).toEqual([])
    expect(resumableSessions([data])).toEqual([])
  })
  it('rolls back a failed example write as one transaction', async () => {
    store.failWritesTo('learningRecords'); await expect(createExampleCourse()).rejects.toThrow(); expect(await storage.db.docs.count()).toBe(0)
  })
  it('serializes concurrent example creation without creating duplicate demonstration data', async () => {
    const [first, second] = await Promise.all([createExampleCourse(), createExampleCourse()]); expect(first.id).toBe(second.id); expect(await storage.db.docs.count()).toBe(1)
  })
  it('persists checkpoint, recall text, hidden state and pause; rejects stale concurrent edits', async () => {
    const data = await setup(); const session = await saveEntity(createGuidedSession(data, data.points), null)
    expect(sessionStepIndex(session)).toBe(0)
    const reading = await saveEntity(advanceSession(session, 'completed', ''), session.revision)
    const paused = await saveEntity({ ...reading, steps: reading.steps.map((step, i) => i === 1 ? { ...step, note: '我独立回忆的内容' } : step), checkpoint: { ...reading.checkpoint!, paused: true, position: 42 } }, reading.revision)
    const reload = await loadCourseSnapshot(data.course.id); expect(reload.sessions[0]).toMatchObject({ checkpoint: { stepIndex: 1, paused: true, hidden: true, position: 42 } }); expect(reload.sessions[0].steps[1].note).toBe('我独立回忆的内容')
    expect(resumableSessions([reload])[0].session.id).toBe(session.id)
    await expect(saveEntity({ ...reading, title: '过期覆盖' }, reading.revision)).rejects.toThrow(/其他页面/)
    await expect(appendAttempt({ ...learningBase(data.course.id), kind: 'attempt', question: data.points[0].questionRefs[0], answer: 0, submittedAt: Date.now(), learningDate: '2026-10-14', answerRevealed: false, origin: 'practice', sessionId: paused.id })).rejects.toThrow(/暂停/)
  })
  it('blocks changed goals, knowledge, unavailable references and missing archives', async () => {
    const data = await setup(); const session = createGuidedSession(data, data.points)
    expect(sessionInvalidReason(session, { ...data, course: { ...data.course, id: 'another' } })).toMatch(/不属于/)
    expect(sessionInvalidReason(session, { ...data, course: { ...data.course, goalVersion: 10 } })).toMatch(/目标/)
    expect(sessionInvalidReason(session, { ...data, points: [] })).toMatch(/删除/)
    expect(sessionInvalidReason(session, { ...data, points: data.points.map((point) => ({ ...point, revision: 10 })) })).toMatch(/更新/)
    expect(sessionInvalidReason(session, { ...data, archives: [] })).toMatch(/归档/)
    const legacy = { ...session }; delete legacy.checkpoint
    expect(sessionInvalidReason(legacy, { ...data, points: data.points.map((point) => ({ ...point, sourceRefs: [{ ...point.sourceRefs[0], end: 9999 }] })) })).toMatch(/依据/)
    expect(sessionInvalidReason(bindSession(session, data), data)).toBeUndefined()
    expect(() => createGuidedSession(data, [])).toThrow(); expect(() => createGuidedSession(data, [{ ...data.points[0], status: 'pending' }])).toThrow()
  })
  it('upgrades a legacy session and preserves skipped and completed outcomes', async () => {
    const data = await setup(); let session = createGuidedSession(data, data.points)
    const legacy = { ...session }; delete legacy.checkpoint; expect(sessionStepIndex(legacy)).toBe(0); expect(bindSession(legacy, data).checkpoint?.goalVersion).toBe(1)
    session = advanceSession(session, 'skipped', '保留解释')
    while (session.status === 'active') session = advanceSession(session, 'completed', '文字')
    expect(session.status).toBe('ended'); expect(session.steps[0].status).toBe('skipped'); expect(() => advanceSession(session, 'completed', '')).toThrow(/结束/)
    let all = createGuidedSession(data, data.points); while (all.status === 'active') all = advanceSession(all, 'completed', '文字'); expect(all.status).toBe('completed')
    expect(sessionStepIndex({ ...legacy, steps: legacy.steps.map((step) => ({ ...step, status: 'completed' })) })).toBe(0)
  })
  it('validates session and assistance fields without inventing old history', async () => {
    const data = await setup(); const session = createGuidedSession(data, data.points)
    for (const checkpoint of [{ ...session.checkpoint, stepIndex: 99 }, { ...session.checkpoint, paused: 'yes' }, { ...session.checkpoint, archiveHashes: { invalid: 'bad' } }, { ...session.checkpoint, pointRevisions: { unknown: 1 } }]) expect(() => parseLearningEntity({ ...session, checkpoint })).toThrow()
    expect(() => parseLearningEntity({ ...session, examConfig: { durationMinutes: 30, mode: 'simulation' } })).toThrow()
    const question = data.points[0].questionRefs[0]
    expect(parseLearningEntity({ ...learningBase(data.course.id), kind: 'draft', question, answer: null, answerRevealed: false, attemptId: 'draft-attempt', recallText: '先回忆', assistance: { hints: 0, fullExplanation: false, sourceViewed: true, recorded: true } }).kind).toBe('draft')
    expect(() => parseLearningEntity({ ...learningBase(data.course.id), kind: 'draft', question, answer: null, answerRevealed: false, attemptId: 'draft-attempt', assistance: { hints: -1, fullExplanation: false, sourceViewed: false, recorded: true } })).toThrow()
  })
})
describe('V2 personal capacities and goal evidence', () => {
  it('shares 20 minutes across three courses and retains the excluded task', async () => {
    const first = await setup(); const copies = [first, ...['第二课', '第三课'].map((id) => ({ ...first, course: { ...first.course, id, courseId: id, name: id }, archives: [], schedules: [], attempts: [], points: first.points.map((point) => ({ ...point, id: `${id}-point`, courseId: id, sourceRefs: [], questionRefs: [] })) }))]
    const now = Date.UTC(2026, 9, 14, 4)
    const plan = buildPersonalPlan(copies, now, { minutes: 20, questions: 10 }); expect(plan.minutes).toBe(20); expect(plan.selected).toHaveLength(2); expect(plan.backlog.some((task) => task.deferredReason.includes('跨课程'))).toBe(true)
    expect(buildPersonalPlan(copies, now, { minutes: 0, questions: 0 }).selected).toEqual([])
  })
  it('reorders later tasks and fills capacity after a user defers one until tomorrow', async () => {
    const first = await setup()
    const copies = [first, ...['第二课', '第三课'].map((id) => ({ ...first, course: { ...first.course, id, courseId: id, name: id }, archives: [], schedules: [], attempts: [], points: first.points.map((point) => ({ ...point, id: `${id}-point`, courseId: id, sourceRefs: [], questionRefs: [] })) }))]
    const now = Date.UTC(2026, 9, 14, 4)
    const baseline = buildPersonalPlan(copies, now, { minutes: 20, questions: 10 })
    expect(baseline.selected).toHaveLength(2)
    const [firstTask, secondTask] = baseline.selected
    const later = buildPersonalPlan(copies, now, { minutes: 20, questions: 10 }, '', [{ date: '2026-10-14', courseId: firstTask.courseId, taskId: firstTask.id, action: 'later', updatedAt: now }])
    expect(later.selected.map((task) => task.id)).toEqual([secondTask.id, firstTask.id])
    const tomorrow = buildPersonalPlan(copies, now, { minutes: 20, questions: 10 }, '', [{ date: '2026-10-14', courseId: firstTask.courseId, taskId: firstTask.id, action: 'tomorrow', updatedAt: now }])
    expect(tomorrow.selected).toHaveLength(2)
    expect(tomorrow.selected.some((task) => task.courseId === firstTask.courseId && task.id === firstTask.id)).toBe(false)
    expect(tomorrow.backlog.find((task) => task.courseId === firstTask.courseId && task.id === firstTask.id)).toMatchObject({ deferredBecause: 'user-deferred' })
    expect(buildPersonalPlan(copies, now + 86_400_000, { minutes: 20, questions: 10 }, '', [{ date: '2026-10-14', courseId: firstTask.courseId, taskId: firstTask.id, action: 'tomorrow', updatedAt: now }]).selected).toHaveLength(2)
    const oneCourse = { ...first, points: [first.points[0], ...['b', 'c'].map((id) => ({ ...first.points[0], id, title: id, sourceRefs: [], questionRefs: [] }))], course: { ...first.course, dailyMinutes: 20 } }
    const courseBaseline = buildPersonalPlan([oneCourse], now, { minutes: 20, questions: 10 })
    expect(courseBaseline.selected).toHaveLength(2)
    const deferred = courseBaseline.selected[0]
    const filled = buildPersonalPlan([oneCourse], now, { minutes: 20, questions: 10 }, '', [{ date: '2026-10-14', courseId: deferred.courseId, taskId: deferred.id, action: 'tomorrow', updatedAt: now }])
    expect(filled.selected).toHaveLength(2)
    expect(filled.selected.some((task) => task.id === deferred.id)).toBe(false)
  })
  it('enforces total question capacity and distinct course calendars', async () => {
    const first = await setup(); first.course.timeZone = 'America/Los_Angeles'
    first.schedules = first.points[0].questionRefs.map((question, index) => ({ ...learningBase(first.course.id, `review-${index}`), kind: 'schedule', question, status: 'active', dueDate: '2026-10-13', stage: 0, manual: true, ruleVersion: 'manual' }))
    const plan = buildPersonalPlan([first], Date.UTC(2026, 9, 14, 0), { minutes: 30, questions: 1 }); expect(plan.questions).toBe(1); expect(plan.backlog.some((task) => task.deferredBecause === 'question-capacity')).toBe(true)
    expect(() => parsePersonalCapacity(null)).toThrow(); for (const capacity of [{ minutes: -1, questions: 1 }, { minutes: 1441, questions: 1 }, { minutes: 1.5, questions: 1 }, { minutes: 20, questions: -1 }]) expect(() => parsePersonalCapacity(capacity)).toThrow()
  })
  it('stores explicit preferences, tolerates corrupt reads and reports failed writes', () => {
    expect(loadPersonalCapacity()).toEqual({ minutes: 30, questions: 20 }); savePersonalCapacity({ minutes: 20, questions: 3 }); expect(loadPersonalCapacity().minutes).toBe(20)
    localStorage.setItem('msz.learning.capacity.v1', 'broken'); expect(loadPersonalCapacity().minutes).toBe(30)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('unavailable') } }); expect(() => savePersonalCapacity({ minutes: 10, questions: 1 })).toThrow()
  })
  it('allows goals without material and changes goal version on confirmation', async () => {
    const data = await setup(); const goal = { id: 'goal-one', title: '能解释原文核对', level: 'explanation' as const, priority: 'required' as const, pointIds: [data.points[0].id], confirmed: false }
    const course = await updateCourse({ ...data.course, goals: [goal] }); expect(course.goalVersion).toBe(2)
    const rows = courseGoalCoverage({ ...data, course }); expect(rows[0].material).toBe(true); expect(rows[0].questions).toBe(false); expect(rows[0].reasons).toContain('范围尚待确认')
    expect(courseGoalCoverage({ ...data, course: { ...course, goals: [{ ...goal, pointIds: [] }] } })[0].material).toBe(false)
    expect(() => parseLearningEntity({ ...course, goals: [{ ...goal, priority: 'automatic' }] })).toThrow()
    expect(() => parseLearningEntity({ ...course, goals: [goal, goal] })).toThrow()
    await expect(updateCourse({ ...course, goals: [{ ...goal, pointIds: ['foreign'] }] })).rejects.toThrow(/不属于/)
    for (const level of ['recall', 'application'] as const) expect(courseGoalCoverage({ ...data, course: { ...course, goals: [{ ...goal, level, confirmed: true }] } })[0].questions).toBe(level === 'recall')
  })
  it('assembles only requested exam types and never fills shortages by substitution', async () => {
    const data = await setup(); const candidates = examQuestionInventory(data.points, data.archives)
    const result = assembleExamQuestions(candidates, { scopePointIds: data.points.map((point) => point.id), count: 3, typeCounts: { 'multiple-choice': 3 } })
    expect(result.selected).toHaveLength(1); expect(result.missingCount).toBe(2); expect(result.reasons.join()).toMatch(/不以其他题型/)
    expect(() => assembleExamQuestions(candidates, { scopePointIds: [], count: 3, typeCounts: { 'short-answer': 1 } })).toThrow(/合计/)
  })
  it('plans only confirmed course goals and their explicit prerequisites while preserving existing review dates', async () => {
    const data = await setup(); const target = data.points[0]; const prior = { ...target, id: 'prior', title: '前置', sourceRefs: [], questionRefs: [] }; const outside = { ...prior, id: 'outside', title: '不在范围内' }
    const scoped: CourseSnapshot = { ...data, points: [target, prior, outside], course: { ...data.course, goals: [{ id: 'goal', title: '已确认目标', pointIds: [target.id], priority: 'important', level: 'recall', confirmed: true }] }, relations: [{ ...learningBase(data.course.id), kind: 'relation', fromPointId: prior.id, toPointId: target.id, type: 'prerequisite', confirmed: true }] }
    const plan = coursePlanCandidates(scoped); expect(plan.map((task) => task.pointId).sort()).toEqual([prior.id, target.id].sort()); expect(plan.find((task) => task.pointId === target.id)?.order).toBeLessThan(0)
    expect(coursePlanCandidates({ ...scoped, course: { ...scoped.course, goals: scoped.course.goals?.map((goal) => ({ ...goal, confirmed: false })) } })).toEqual([])
    expect(coursePlanCandidates({ ...scoped, course: { ...scoped.course, goals: undefined } })).toHaveLength(3)
  })
})
describe('V2 scoped AI support, history and portable sessions', () => {
  it('starts new analysis from already saved text while keeping the original document and archive', async () => {
    const data = await setup(); const originalId = data.documents[0].docId
    const fresh = await prepareFreshAnalysis(data.course.id, originalId, '新范围')
    expect(fresh.id).not.toBe(originalId); const copySources = await storage.db.sources.where('docId').equals(fresh.id).toArray(); expect(copySources[0].text).toBe(data.archives[0].sources[0].text)
    const reloaded = await loadCourseSnapshot(data.course.id); expect(reloaded.documents).toHaveLength(2); expect(reloaded.archives[0].id).toBe(data.archives[0].id); expect(await storage.db.analysisTasks.count()).toBe(0)
    await expect(prepareFreshAnalysis(data.course.id, 'missing')).rejects.toThrow(/不可用/)
    const before = await storage.db.docs.count(); await expect(prepareFreshAnalysis('missing-course', originalId)).rejects.toThrow(); expect(await storage.db.docs.count()).toBe(before)
  })
  it('copies only selected original characters and keeps all modes typed and bounded', async () => {
    const data = await setup(); const ref = data.points[0].sourceRefs[0]
    const support = await prepareLearningSupport(data, { mode: 'hint', pointIds: [data.points[0].id], sourceRefs: [{ ...ref, start: 0, end: 10 }], prompt: '帮助理解，不要直接作答', hintLevel: 1 })
    const sources = await storage.db.sources.where('docId').equals(support.docId).toArray(); expect(sources[0].text).toBe(data.archives[0].sources[0].text.slice(0, 10)); expect(sources[0].id).not.toBe(ref.sourceId)
    for (const mode of ['explain', 'compare', 'hint', 'feedback', 'goals', 'variation', 'supplement'] as SupportMode[]) expect(supportGeneration({ ...support, mode, learnerAnswer: '我的解释', quizType: 'short-answer', difficulty: 'hard', hintLevel: 3 }).options.learningSupport?.mode).toBe(mode)
    expect(supportGeneration({ ...support, mode: 'variation' }).kinds).toEqual(['quiz']); expect(supportGeneration({ ...support, mode: 'goals' }).kinds).toEqual(['outline'])
    expect(supportSources(data, data.points.map((point) => point.id))).toHaveLength(1); expect(supportSources(data, [])).toHaveLength(1)
  })
  it('rejects invalid or excessive scopes and rolls back a failed support registration', async () => {
    const data = await setup(); const input = { mode: 'explain' as const, pointIds: [data.points[0].id], sourceRefs: data.points[0].sourceRefs, prompt: '解释' }
    await expect(prepareLearningSupport({ ...data, course: { ...data.course, example: true } }, input)).rejects.toThrow(/示例/)
    await expect(prepareLearningSupport(data, { ...input, sourceRefs: [] })).rejects.toThrow(); await expect(prepareLearningSupport(data, { ...input, prompt: ' ' })).rejects.toThrow()
    for (const ref of [{ ...input.sourceRefs[0], start: -1 }, { ...input.sourceRefs[0], end: 99999 }, { ...input.sourceRefs[0], sourceId: 'missing' }]) await expect(prepareLearningSupport(data, { ...input, sourceRefs: [ref] })).rejects.toThrow(/范围/)
    const large = structuredClone(data); large.archives[0].sources[0].text = '字'.repeat(24001)
    await expect(prepareLearningSupport(large, { ...input, sourceRefs: [{ ...input.sourceRefs[0], end: 24001 }] })).rejects.toThrow(/24,000/)
    const before = await storage.db.docs.count(); store.failWritesTo('learningRecords'); await expect(prepareLearningSupport(data, input)).rejects.toThrow(); expect(await storage.db.docs.count()).toBe(before)
  })
  it('restores goals, checkpoints, guided attempts and support identities without model jobs', async () => {
    let data = await setup(); const course = await updateCourse({ ...data.course, goals: [{ id: 'target', title: '回忆与核对', level: 'recall', priority: 'required', pointIds: [data.points[0].id], confirmed: true }] }); data = await loadCourseSnapshot(course.id)
    const point = data.points[0]; await saveEntity({ ...point, questionLevels: { [questionRefKey(point.questionRefs[0])]: 'explanation' } }, point.revision); data = await loadCourseSnapshot(course.id)
    const created = createGuidedSession(data, data.points)
    const session = await saveEntity({ ...created, checkpoint: { ...created.checkpoint!, questionKey: `${point.questionRefs[0].archiveId}/${point.questionRefs[0].artifactId}/${point.questionRefs[0].questionId}` } }, null)
    const question = data.points[0].questionRefs[0]
    const attempt = await appendAttempt({ ...learningBase(course.id), kind: 'attempt', question, answer: 0, submittedAt: Date.now(), learningDate: '2026-10-14', answerRevealed: false, origin: 'practice', sessionId: session.id, assistance: { hints: 1, sourceViewed: false, fullExplanation: false, recorded: true }, recallText: '我的回忆' })
    const support = await prepareLearningSupport(data, { mode: 'feedback', pointIds: [data.points[0].id], sourceRefs: data.points[0].sourceRefs, prompt: '核对', learnerAnswer: '我的解释', questionRef: question, attemptId: attempt.id, sessionId: session.id })
    await appendAssessment({ ...learningBase(course.id), kind: 'assessment', attemptId: attempt.id, outcome: 'partial', difficulty: 'hard', selfAssessmentComplete: false, origin: 'ai-review', feedbackArchiveId: data.archives[0].id })
    const restored = await restoreCoursePackage(await previewCoursePackage(await exportCoursePackage(course.id)))
    const reloaded = await loadCourseSnapshot(restored.id)
    expect(reloaded.course.goals?.[0].pointIds).toEqual([reloaded.points[0].id]); expect(reloaded.sessions[0].checkpoint?.pointRevisions).toHaveProperty(reloaded.points[0].id)
    expect(reloaded.attempts[0].sessionId).toBe(reloaded.sessions[0].id); expect(reloaded.attempts[0].recallText).toBe('我的回忆')
    const restoredRef = reloaded.points[0].questionRefs[0]; expect(reloaded.points[0].questionLevels?.[questionRefKey(restoredRef)]).toBe('explanation'); expect(reloaded.sessions[0].checkpoint?.questionKey).toBe(`${restoredRef.archiveId}/${restoredRef.artifactId}/${restoredRef.questionId}`)
    expect(reloaded.supports?.[0].docId).not.toBe(support.docId); expect(reloaded.supports?.[0].sourceRefs[0].archiveId).toBe(reloaded.archives[0].id); expect(reloaded.supports?.[0].attemptId).toBe(reloaded.attempts[0].id)
    expect(reloaded.assessments[0].feedbackArchiveId).toBe(reloaded.archives[0].id); expect(reloaded.assessments[0].selfAssessmentComplete).toBe(false)
    expect(await storage.db.analysisTasks.count()).toBe(0); expect(sessionInvalidReason(reloaded.sessions[0], reloaded)).toBeUndefined()
    expect(buildKnowledgeCoverage(reloaded)[0].delayedSuccessTargetCount).toBe(0)
    await deletePracticeHistory(course.id, (await loadCourseSnapshot(course.id)).course.revision); expect((await loadCourseSnapshot(course.id)).supports?.[0]).not.toHaveProperty('learnerAnswer')
    await deleteLearningArchive(course.id, data.archives[0].id, data.archives[0].revision); expect((await loadCourseSnapshot(course.id)).supports).toEqual([])
  })
  it('rejects expired simulation submissions and preserves legacy guided submissions', async () => {
    const data = await setup(); const question = data.points[0].questionRefs[0]
    const session: LearningSession = await saveEntity({ ...learningBase(data.course.id, 'exam-one', 1), kind: 'session', title: '限时模拟', pointIds: [data.points[0].id], steps: [], questions: [question], purpose: 'exam', status: 'active', examConfig: { durationMinutes: 1, mode: 'simulation' } }, null)
    await expect(appendAttempt({ ...learningBase(data.course.id), kind: 'attempt', question, answer: 0, submittedAt: Date.now(), learningDate: '2026-10-14', answerRevealed: false, origin: 'practice', sessionId: session.id })).rejects.toThrow(/时间已结束/)
    const other = await createCourse({ name: '其他课程' }); await expect(saveEntity({ ...data.course, courseId: other.id }, data.course.revision)).rejects.toThrow()
  })
})
