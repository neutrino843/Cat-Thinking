import { describe, expect, it } from 'vitest'
import type { ApplicationTask, AssessmentEvent, CourseSnapshot, KnowledgePoint, KnowledgeRelation, LearningArchive, PracticeAttempt, QuestionIssue, QuestionRef, ReviewSchedule } from './model'
import { addLearningDays, learningDate, LearningRuleError, previewTimeZoneChange, proposeReviewSchedule, type ReviewSignal } from './reviewScheduler'
import { buildDailyPlan, type DailyPlanCandidate } from './dailyPlan'
import { addConfirmedPrerequisite, buildLearningPath, findKnowledgeCandidates, LearningGraphError, mergeKnowledgePoints, prerequisiteCycle, questionRefKey, resolveKnowledgePointId, undoKnowledgeMerge } from './knowledgeGraph'
import { buildKnowledgeCoverage, summarizeLearningCoverage, type CoverageInput } from './coverageView'
import { assembleExamQuestions, buildExamPlan, examQuestionInventory } from './examPlan'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { coursePlanCandidates } from './planCandidates'

const at = Date.parse('2026-10-13T04:00:00Z')
const base = (id: string) => ({ version: 1 as const, id, courseId: 'course', revision: 1, createdAt: at, updatedAt: at })
const ref = (questionId = 'choice'): QuestionRef => ({ archiveId: 'archive', artifactId: 'synthetic-quiz', questionId, confirmed: true })
const point = (id = 'point', changes: Partial<KnowledgePoint> = {}): KnowledgePoint => ({ ...base(id), kind: 'point', title: id,
  definition: `定义 ${id}`, chapter: '第一章', aliases: [], notes: `笔记 ${id}`, sourceRefs: [{ archiveId: 'archive', sourceId: 'synthetic-source', start: 6, end: 8 }],
  questionRefs: [ref()], status: 'active', ...changes })
const schedule = (changes: Partial<ReviewSchedule> = {}): ReviewSchedule => ({ ...base('schedule'), kind: 'schedule', question: ref(),
  status: 'active', stage: 0, manual: false, ruleVersion: 'intervals-v1', dueDate: '2026-10-13', ...changes })
const signal = (changes: Partial<ReviewSignal> = {}): ReviewSignal => ({ attemptId: 'attempt-1', utcTimestamp: at, timeZone: 'Asia/Shanghai',
  outcome: 'success', answerProvided: true, answerRevealedBeforeSubmit: false, questionType: 'objective', selfAssessmentComplete: false, ...changes })
const relation = (id: string, fromPointId: string, toPointId: string, changes: Partial<KnowledgeRelation> = {}): KnowledgeRelation => ({ ...base(id),
  kind: 'relation', fromPointId, toPointId, type: 'prerequisite', confirmed: true, ...changes })
const candidate = (id: string, changes: Partial<DailyPlanCandidate> = {}): DailyPlanCandidate => ({ id, courseId: 'course', pointId: 'point',
  type: 'review', title: id, estimatedMinutes: 5, questionCount: 1, dueDate: '2026-10-13', ...changes })
const attempt = (id: string, date = '2026-10-13', changes: Partial<PracticeAttempt> = {}): PracticeAttempt => ({ ...base(id), kind: 'attempt',
  question: ref(), answer: 0, submittedAt: Date.parse(`${date}T04:00:00Z`), learningDate: date, answerRevealed: false, origin: 'practice', ...changes })
const assessment = (attemptId: string, changes: Partial<AssessmentEvent> = {}): AssessmentEvent => ({ ...base(`assessment-${attemptId}`), kind: 'assessment',
  attemptId, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true, ...changes })

async function coverageFixture(changes: Partial<CoverageInput> = {}): Promise<CoverageInput> {
  const fixture = await localArtifactFixtures()
  const archive: LearningArchive = { ...base('archive'), kind: 'archive', originDocId: fixture.doc.id, provenanceDocId: fixture.doc.id,
    runId: 'synthetic-run', title: '课程归档', manifest: fixture.task.request.manifest, sources: [fixture.source], artifacts: [fixture.quiz], contentHash: 'a'.repeat(64) }
  return { points: [point()], archives: [archive], attempts: [], assessments: [], schedules: [], ...changes }
}

async function courseFixture(changes: Partial<CourseSnapshot> = {}): Promise<CourseSnapshot> {
  const fixture = await coverageFixture()
  return { course: { ...base('course'), kind: 'course', name: '课程', goal: '', timeZone: 'Asia/Shanghai', dailyMinutes: 30, dailyQuestionLimit: 10, goalVersion: 1 },
    points: [...fixture.points], archives: [...fixture.archives], documents: [], docs: [], attempts: [], assessments: [], schedules: [],
    drafts: [], relations: [], merges: [], sessions: [], applicationTasks: [], issues: [], bindings: [], ...changes }
}

describe('calendar dates and deterministic review rules', () => {
  it('uses the course timezone at midnight and crosses leap day independently of DST', () => {
    expect(learningDate('2026-10-12T15:59:59Z', 'Asia/Shanghai')).toBe('2026-10-12')
    expect(learningDate('2026-10-12T16:00:00Z', 'Asia/Shanghai')).toBe('2026-10-13')
    expect(addLearningDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addLearningDays('2026-03-07', 3)).toBe('2026-03-10')
    expect(previewTimeZoneChange(at, 'Asia/Shanghai', 'America/Los_Angeles')).toEqual({ previousDate: '2026-10-13', nextDate: '2026-10-12',
      changesCurrentLearningDate: true, historicalDatesRemainUnchanged: true })
  })
  it.each(['2026-02-30', '2026-1-01', 'not-a-date'])('rejects invalid learning date %s', (date) => {
    expect(() => addLearningDays(date, 1)).toThrow(LearningRuleError)
  })
  it('rejects an invalid timezone, timestamp and fractional interval', () => {
    expect(() => learningDate(at, 'invalid/timezone')).toThrow(LearningRuleError)
    expect(() => learningDate(Number.NaN)).toThrow(LearningRuleError)
    expect(() => addLearningDays('2026-10-13', 1.5)).toThrow(LearningRuleError)
    expect(() => proposeReviewSchedule(schedule(), signal(), { intervals: [1, 0] })).toThrow(LearningRuleError)
    expect(() => proposeReviewSchedule(schedule(), signal(), { intervals: [7, 3] })).toThrow(LearningRuleError)
    expect(() => proposeReviewSchedule(schedule(), signal(), { intervals: [] })).toThrow(LearningRuleError)
  })
  it('advances 1, 3, 7, 14 day intervals only across distinct learning days and caps the final stage', () => {
    let current = schedule()
    const actual: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const result = proposeReviewSchedule(current, signal({ attemptId: `attempt-${index}`, utcTimestamp: at + index * 86_400_000 }))
      expect(result.eligibleSuccess).toBe(true)
      current = result.schedule
      actual.push(current.dueDate)
    }
    expect(actual).toEqual(['2026-10-14', '2026-10-17', '2026-10-22', '2026-10-30', '2026-10-31'])
    expect(current.stage).toBe(4)
    expect(current.successfulLearningDates).toHaveLength(5)
  })
  it('accepts custom versioned intervals without modifying the input', () => {
    const previous = schedule()
    const before = JSON.stringify(previous)
    const result = proposeReviewSchedule(previous, signal(), { intervals: [2, 5], ruleVersion: 'custom-v2' })
    expect(result.schedule).toMatchObject({ stage: 1, dueDate: '2026-10-15', ruleVersion: 'custom-v2' })
    expect(JSON.stringify(previous)).toBe(before)
  })
  it('does not advance an immediately corrected answer, repeat submission, or same-day success', () => {
    const first = proposeReviewSchedule(schedule(), signal()).schedule
    expect(proposeReviewSchedule(first, signal()).schedule).toBe(first)
    expect(proposeReviewSchedule(first, signal({ attemptId: 'attempt-2' }))).toMatchObject({ eligibleSuccess: false, schedule: { stage: 1, dueDate: '2026-10-14' } })
    expect(proposeReviewSchedule(schedule(), signal({ answerRevealedBeforeSubmit: true }))).toMatchObject({ eligibleSuccess: false, schedule: { stage: 0, dueDate: '2026-10-14' } })
  })
  it('resets failure to remediation, schedules completed remediation next day, and retains partial stage', () => {
    const failure = proposeReviewSchedule(schedule({ stage: 3 }), signal({ outcome: 'failure' })).schedule
    expect(failure).toMatchObject({ stage: 0, status: 'remediation', dueDate: '2026-10-13' })
    expect(proposeReviewSchedule(failure, signal({ action: 'remediation-complete' })).schedule).toMatchObject({ status: 'active', dueDate: '2026-10-14', stage: 0 })
    expect(proposeReviewSchedule(schedule({ stage: 3 }), signal({ outcome: 'partial' })).schedule).toMatchObject({ stage: 3, dueDate: '2026-10-14' })
  })
  it('requires a nonempty short answer, completed self-assessment and recall difficulty', () => {
    expect(proposeReviewSchedule(schedule(), signal({ questionType: 'short-answer', selfAssessmentComplete: true })).eligibleSuccess).toBe(false)
    expect(proposeReviewSchedule(schedule(), signal({ questionType: 'short-answer', selfAssessmentComplete: false, recallDifficulty: 'good' })).eligibleSuccess).toBe(false)
    expect(proposeReviewSchedule(schedule(), signal({ questionType: 'short-answer', selfAssessmentComplete: true, recallDifficulty: 'good', answerProvided: false })).eligibleSuccess).toBe(false)
    expect(proposeReviewSchedule(schedule(), signal({ questionType: 'short-answer', selfAssessmentComplete: true, recallDifficulty: 'good' })).eligibleSuccess).toBe(true)
    expect(proposeReviewSchedule(schedule(), signal({ recallDifficulty: 'again' })).schedule.status).toBe('remediation')
  })
  it('does not grade skips, paused questions or application tasks; dispute pauses and resume preserves stage', () => {
    const original = schedule({ stage: 3 })
    expect(proposeReviewSchedule(original, signal({ outcome: 'skipped' })).schedule).toBe(original)
    expect(proposeReviewSchedule(original, signal({ action: 'skip' })).schedule).toBe(original)
    expect(proposeReviewSchedule(original, signal({ questionType: 'application' })).schedule).toBe(original)
    const paused = proposeReviewSchedule(original, signal({ outcome: 'disputed' })).schedule
    expect(paused).toMatchObject({ status: 'paused', stage: 3 })
    expect(proposeReviewSchedule(paused, signal()).schedule).toBe(paused)
    expect(proposeReviewSchedule(paused, signal({ action: 'resume' })).schedule).toMatchObject({ status: 'active', stage: 3, dueDate: original.dueDate })
    expect(proposeReviewSchedule(original, signal({ action: 'pause' })).schedule.status).toBe('paused')
  })
  it('preserves a manual date and rejects a backward clock without changing the schedule', () => {
    expect(proposeReviewSchedule(schedule({ manual: true, dueDate: '2026-11-01' }), signal()).schedule.dueDate).toBe('2026-11-01')
    expect(() => proposeReviewSchedule(schedule({ lastLearningDate: '2026-10-14' }), signal())).toThrow(LearningRuleError)
  })
  it('changes the learning day at course midnight and respects manual failure/partial/remediation dates', () => {
    const previous = proposeReviewSchedule(schedule(), signal({ utcTimestamp: Date.parse('2026-10-13T15:59:59Z') })).schedule
    const next = proposeReviewSchedule(previous, signal({ attemptId: 'midnight', utcTimestamp: Date.parse('2026-10-13T16:00:00Z') }))
    expect(next).toMatchObject({ eligibleSuccess: true, schedule: { stage: 2, lastLearningDate: '2026-10-14', dueDate: '2026-10-17' } })
    const manual = schedule({ manual: true, dueDate: '2026-12-01', stage: 3 })
    for (const change of [{ outcome: 'failure' as const }, { outcome: 'partial' as const }, { action: 'remediation-complete' as const }]) {
      expect(proposeReviewSchedule(manual, signal(change)).schedule.dueDate).toBe('2026-12-01')
    }
  })
  it('allows a first pending self-assessment to finish once, and lets a later failure revision stop its earlier success', () => {
    const pending = proposeReviewSchedule(schedule(), signal({ questionType: 'short-answer', outcome: 'partial' })).schedule
    const completed = proposeReviewSchedule(pending, signal({ questionType: 'short-answer', selfAssessmentComplete: true, recallDifficulty: 'good' }))
    expect(completed).toMatchObject({ eligibleSuccess: true, schedule: { stage: 1 } })
    expect(proposeReviewSchedule(completed.schedule, signal({ questionType: 'short-answer', selfAssessmentComplete: true, recallDifficulty: 'good' })).schedule).toBe(completed.schedule)
    expect(proposeReviewSchedule(completed.schedule, signal({ questionType: 'short-answer', outcome: 'failure', selfAssessmentComplete: true, recallDifficulty: 'again' })).schedule)
      .toMatchObject({ stage: 0, status: 'remediation' })
    const paused = proposeReviewSchedule(completed.schedule, signal({ outcome: 'disputed' })).schedule
    expect(paused.status).toBe('paused')
    expect(proposeReviewSchedule(paused, signal({ action: 'resume' })).schedule.status).toBe('active')
  })
})

describe('daily capacity and visible backlog', () => {
  it('prioritizes fixed tasks then overdue remediation/review, confirmed prerequisites, new learning and application', () => {
    const tasks = [candidate('application', { type: 'application', questionCount: 0 }), candidate('new', { type: 'new' }),
      candidate('prerequisite', { type: 'prerequisite' }), candidate('review'), candidate('remediation', { type: 'remediation', dueDate: '2026-10-12' }),
      candidate('pinned', { pinned: true, dueDate: '2026-10-20' })]
    expect(buildDailyPlan(tasks, { learningDate: '2026-10-13', timeBudgetMinutes: 30, questionLimit: 5 }).selected.map((task) => task.id))
      .toEqual(['pinned', 'remediation', 'review', 'prerequisite', 'new', 'application'])
    expect(tasks[0]).not.toHaveProperty('recommendationReason')
  })
  it('keeps unavailable, paused, future and capacity-excluded items visible with separate reasons', () => {
    const plan = buildDailyPlan([candidate('first'), candidate('over-limit'), candidate('future', { dueDate: '2026-10-20' }),
      candidate('paused', { paused: true }), candidate('missing', { sourceStatus: 'missing' }), candidate('time', { type: 'application', questionCount: 0 })],
    { learningDate: '2026-10-13', timeBudgetMinutes: 5, questionLimit: 1 })
    expect(plan.selected).toHaveLength(1)
    expect(plan.backlog.map((task) => task.deferredBecause)).toEqual(expect.arrayContaining(['question-capacity', 'not-due', 'paused', 'source-invalid', 'time-capacity']))
    expect(plan.unscheduledCount).toBe(2)
    expect(plan.selected[0].recommendationReason).toBeTruthy()
    expect(plan.backlog.every((task) => !!task.deferredReason)).toBe(true)
  })
  it('has an empty first-day plan, handles zero capacity and rejects malformed tasks', () => {
    expect(buildDailyPlan([], { learningDate: '2026-10-13', timeBudgetMinutes: 0, questionLimit: 0 }).selected).toEqual([])
    expect(buildDailyPlan([candidate('one')], { learningDate: '2026-10-13', timeBudgetMinutes: 0, questionLimit: 0 }).unscheduledCount).toBe(1)
    expect(() => buildDailyPlan([candidate('same'), candidate('same')], { learningDate: '2026-10-13', timeBudgetMinutes: 20, questionLimit: 5 })).toThrow(LearningRuleError)
    expect(() => buildDailyPlan([candidate('bad', { estimatedMinutes: 0 })], { learningDate: '2026-10-13', timeBudgetMinutes: 20, questionLimit: 5 })).toThrow(LearningRuleError)
    expect(() => buildDailyPlan([], { learningDate: '2026-10-13', timeBudgetMinutes: 20, questionLimit: 0.5 })).toThrow(LearningRuleError)
  })
})

describe('confirmed course knowledge relationships and reversible merges', () => {
  it('uses exact normalized title or alias as candidates only, without changing concepts', () => {
    const origin = point('one', { title: '  RC4 ', aliases: ['流密码'] })
    const other = point('two', { title: 'rc4', chapter: '另一章' })
    expect(findKnowledgeCandidates(origin, [origin, other, point('alias', { title: '另一个名', aliases: ['流密码'] }),
      point('retired', { title: 'RC4', status: 'retired' }), point('different-course', { title: 'RC4', courseId: 'other' })]))
      .toMatchObject([{ toPointId: 'alias', reason: 'shared-alias', requiresConfirmation: true }, { toPointId: 'two', reason: 'same-title', requiresConfirmation: true }])
    expect(origin.status).toBe('active')
  })
  it('rejects confirmed cycles and ignores unconfirmed or non-prerequisite relationships', () => {
    const state = { points: [point('a'), point('b'), point('c')], relations: [relation('ab', 'a', 'b'), relation('bc', 'b', 'c')] }
    expect(() => addConfirmedPrerequisite(state, relation('ca', 'c', 'a'))).toThrow(LearningGraphError)
    expect(prerequisiteCycle([...state.relations, relation('ca', 'c', 'a')])).toEqual(['a', 'b', 'c', 'a'])
    expect(prerequisiteCycle([relation('ab', 'a', 'b'), relation('ba', 'b', 'a', { confirmed: false })])).toBeNull()
    expect(prerequisiteCycle([relation('same', 'a', 'a', { type: 'part' })])).toBeNull()
    expect(() => addConfirmedPrerequisite(state, relation('new', 'a', 'c', { confirmed: false }))).toThrow(LearningGraphError)
    expect(() => addConfirmedPrerequisite(state, relation('new', 'missing', 'c'))).toThrow(LearningGraphError)
    expect(() => addConfirmedPrerequisite(state, relation('ab2', 'a', 'b'))).toThrow(LearningGraphError)
    expect(addConfirmedPrerequisite(state, relation('ac', 'a', 'c'))).toHaveLength(3)
  })
  it('orders confirmed prerequisites while allowing free starts; tree parents do not imply a prerequisite', () => {
    const points = [point('child', { parentId: 'parent' }), point('parent'), point('advanced')]
    const path = buildLearningPath({ points, relations: [relation('needed', 'parent', 'advanced')] }, [], ['advanced', 'child', 'parent'])
    expect(path.map((unit) => unit.pointId)).toEqual(['parent', 'advanced', 'child'])
    expect(path.find((unit) => unit.pointId === 'advanced')).toMatchObject({ unpracticedPrerequisiteIds: ['parent'], mayStartFreely: true })
    expect(path.find((unit) => unit.pointId === 'child')?.prerequisiteIds).toEqual([])
    expect(buildLearningPath({ points, relations: [relation('needed', 'parent', 'advanced')] }, ['parent'])[2].unpracticedPrerequisiteIds).toEqual([])
  })
  it('merges only after user confirmation and restores all original content and relationships on undo', () => {
    const from = point('from', { questionRefs: [ref('boolean')], aliases: ['别名'], sourceRefs: [{ archiveId: 'other-archive', sourceId: 'other-source', start: 1, end: 2 }] })
    const to = point('to')
    const state = { points: [from, to, point('third')], relations: [relation('from-third', 'from', 'third'), relation('from-to', 'from', 'to')], merges: [] }
    const before = JSON.stringify(state)
    expect(() => mergeKnowledgePoints(state, 'from', 'to', { eventId: 'merge', at })).toThrow(LearningGraphError)
    const merged = mergeKnowledgePoints(state, 'from', 'to', { eventId: 'merge', at, confirmed: true })
    const target = merged.points.find((item) => item.id === 'to')!
    expect(target).toMatchObject({ definition: to.definition, notes: to.notes, questionRefs: [ref(), ref('boolean')], aliases: ['from', '别名'] })
    expect(target.sourceRefs).toHaveLength(2)
    expect(merged.points.find((item) => item.id === 'from')).toMatchObject({ status: 'retired', definition: from.definition, notes: from.notes })
    expect(merged.relations).toMatchObject([{ id: 'from-third', fromPointId: 'to', toPointId: 'third' }])
    const undone = undoKnowledgeMerge({ ...merged, merges: [merged.event] }, 'merge', { eventId: 'undo', at: at + 1 })
    expect(undone.points.find((item) => item.id === 'from')).toMatchObject({ status: 'active', sourceRefs: from.sourceRefs, questionRefs: from.questionRefs })
    expect(undone.points.find((item) => item.id === 'to')).toMatchObject({ sourceRefs: to.sourceRefs, questionRefs: to.questionRefs, aliases: [] })
    expect(undone.relations.map((item) => [item.id, item.fromPointId, item.toPointId])).toEqual(state.relations.map((item) => [item.id, item.fromPointId, item.toPointId]))
    expect(JSON.stringify(state)).toBe(before)
  })
  it('refuses a merge that would create a prerequisite cycle and an undo that would overwrite edits', () => {
    const state = { points: [point('a'), point('b'), point('c')], relations: [relation('ab', 'a', 'b'), relation('bc', 'b', 'c')] }
    expect(() => mergeKnowledgePoints(state, 'c', 'a', { eventId: 'cycle', at, confirmed: true })).toThrow(LearningGraphError)
    const merged = mergeKnowledgePoints({ ...state, relations: [] }, 'a', 'c', { eventId: 'merge', at, confirmed: true })
    merged.points[0].revision += 1
    expect(() => undoKnowledgeMerge({ ...merged, merges: [merged.event] }, 'merge', { eventId: 'undo', at })).toThrow(LearningGraphError)
    expect(() => undoKnowledgeMerge({ ...state, merges: [] }, 'missing', { eventId: 'undo', at })).toThrow(LearningGraphError)
  })
  it('protects later relation edits and resolves original task aliases through merge and undo', () => {
    const state = { points: [point('a'), point('b'), point('c')], relations: [relation('ac', 'a', 'c')] }
    const merged = mergeKnowledgePoints(state, 'a', 'b', { eventId: 'merge', at, confirmed: true })
    expect(resolveKnowledgePointId('a', [merged.event])).toBe('b')
    merged.relations[0].revision += 1
    expect(() => undoKnowledgeMerge({ ...merged, merges: [merged.event] }, 'merge', { eventId: 'undo', at })).toThrow(LearningGraphError)
    const undoEvent = { ...merged.event, id: 'undo', action: 'undo' as const, undoOf: 'merge' }
    expect(resolveKnowledgePointId('a', [merged.event, undoEvent])).toBe('a')
    expect(() => resolveKnowledgePointId('a', [merged.event, { ...merged.event, id: 'reverse', fromPointId: 'b', toPointId: 'a' }])).toThrow(LearningGraphError)
  })
})

describe('coverage facts without automatic mastery', () => {
  it('starts with separate source, confirmed question coverage and unpracticed state', async () => {
    const input = await coverageFixture()
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ sourceStatus: 'valid', coverageStatus: 'recall-only', observation: 'unpracticed',
      availableQuestionCount: 1, practiced: false, delayedSuccessTargetCount: 0, needsApplicationVerification: true })
    input.points = [point('pending', { status: 'pending' }), point('missing', { sourceRefs: [] }), point('unconfirmed', { questionRefs: [{ ...ref(), confirmed: false }] })]
    expect(buildKnowledgeCoverage(input).map((item) => [item.sourceStatus, item.availableQuestionCount])).toEqual([['pending', 0], ['missing', 0], ['valid', 0]])
  })
  it('requires unpeeked successful answers on distinct days for the same specific target', async () => {
    const input = await coverageFixture({ attempts: [attempt('one'), attempt('repeat', '2026-10-13', { submittedAt: at + 1000 })] })
    expect(buildKnowledgeCoverage(input)[0].delayedSuccessTargetCount).toBe(0)
    input.attempts = [...input.attempts, attempt('peek', '2026-10-14', { answerRevealed: true }), attempt('delayed', '2026-10-15')]
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ observation: 'delayed-success', delayedSuccessTargetCount: 1 })
    expect(buildKnowledgeCoverage(input)[0]).not.toHaveProperty('mastery')
  })
  it('does not count a correction after an earlier same-day failure or legacy records as delayed success', async () => {
    const input = await coverageFixture({ attempts: [attempt('wrong', '2026-10-13', { answer: 1 }),
      attempt('corrected', '2026-10-13', { submittedAt: at + 1000 }), attempt('legacy', '2026-10-14', { origin: 'legacy', submittedAt: null }), attempt('next', '2026-10-15')] })
    expect(buildKnowledgeCoverage(input)[0].delayedSuccessTargetCount).toBe(0)
    expect(buildKnowledgeCoverage(input)[0].evidence.find((item) => item.attemptId === 'legacy')).toMatchObject({ learningDate: null, importedHistory: true })
  })
  it('uses objective comparison and never a self-assessment success override for a wrong answer', async () => {
    const input = await coverageFixture({ attempts: [attempt('wrong', '2026-10-13', { answer: 1 })], assessments: [assessment('wrong')] })
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ observation: 'needs-remediation', evidence: [{ outcome: 'failure' }] })
    input.attempts = [attempt('right')]
    input.schedules = [schedule()]
    expect(buildKnowledgeCoverage(input)[0].observation).toBe('awaiting-review')
  })
  it('requires short-answer self-assessment and preserves partial/blank outcomes', async () => {
    const input = await coverageFixture({ points: [point('short', { questionRefs: [ref('short')] })], attempts: [attempt('short', '2026-10-13', { question: ref('short'), answer: '我的解释' })] })
    expect(buildKnowledgeCoverage(input)[0].observation).toBe('assessment-pending')
    input.assessments = [assessment('short', { rubricChecks: [true, false] })]
    expect(buildKnowledgeCoverage(input)[0].observation).toBe('needs-remediation')
    input.assessments = [assessment('short', { rubricChecks: [true, true] })]
    expect(buildKnowledgeCoverage(input)[0].observation).toBe('self-assessed')
    input.attempts = [attempt('blank', '2026-10-13', { question: ref('short'), answer: ' ' })]
    input.assessments = [assessment('blank')]
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ practiced: false, observation: 'unpracticed', evidence: [{ outcome: 'unanswered' }] })
  })
  it('keeps application completion separate from recall evidence and uses explicit goal denominators', async () => {
    const task: ApplicationTask = { ...base('application'), kind: 'application', pointIds: ['point'], title: '应用', prompt: '解释实验现象', response: '观察', rubric: ['说明'], checks: [true], status: 'completed' }
    const input = await coverageFixture({ points: [point('point', { goalIncluded: true, questionLevels: { [questionRefKey(ref())]: 'application' } }), point('not-goal')],
      attempts: [attempt('one'), attempt('two', '2026-10-14')], applicationTasks: [task] })
    const coverage = buildKnowledgeCoverage(input)
    expect(coverage[0]).toMatchObject({ coverageStatus: 'has-application', delayedSuccessTargetCount: 0, completedApplicationSelfAssessments: 1 })
    expect(coverage[0].reasons).toContain('应用任务完成的是用户自评，不自动认定迁移能力达标。')
    expect(summarizeLearningCoverage(input.points, coverage, 2)).toMatchObject({ goalVersion: 2, confirmedGoalCount: 1, practicedGoalCount: 1 })
  })
  it('shows disputed and source issues without including them in valid statistics', async () => {
    const issue: QuestionIssue = { ...base('issue'), kind: 'issue', question: ref(), reason: 'answer', note: '答案有疑问', status: 'open' }
    const input = await coverageFixture({ issues: [issue], attempts: [attempt('one')] })
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ availableQuestionCount: 0, disputedQuestionCount: 1, practiced: false })
    input.issues = []
    input.sourceStatuses = { point: 'changed' }
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ sourceStatus: 'changed', availableQuestionCount: 0 })
    input.sourceStatuses = {}
    input.points = [point('point', { sourceRefs: [{ archiveId: 'archive', sourceId: 'synthetic-source', start: 0, end: 9999 }] })]
    expect(buildKnowledgeCoverage(input)[0].sourceStatus).toBe('missing')
  })
  it('invalidates old confirmed coverage when the knowledge definition is pending, including old successful attempts', async () => {
    const input = await coverageFixture({ points: [point('point', { status: 'pending' })], attempts: [attempt('first'), attempt('second', '2026-10-14')] })
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ sourceStatus: 'pending', availableQuestionCount: 0, practiced: false, delayedSuccessTargetCount: 0 })
  })
  it('uses transaction sequence for assessment revisions instead of a timestamp/ID tie and rejects empty completed applications', async () => {
    const input = await coverageFixture({ points: [point('point', { questionRefs: [ref('short')] })],
      attempts: [attempt('short', '2026-10-13', { question: ref('short'), answer: '说明' })],
      assessments: [assessment('short', { id: 'z-old', sequence: 1, rubricChecks: [true, true] }),
        assessment('short', { id: 'a-new', sequence: 2, outcome: 'failure', rubricChecks: [false, false] })],
      applicationTasks: [{ ...base('empty-application'), kind: 'application', pointIds: ['point'], title: '任务', prompt: '', response: '', rubric: [], checks: [], status: 'completed' }] })
    expect(buildKnowledgeCoverage(input)[0]).toMatchObject({ observation: 'needs-remediation', completedApplicationSelfAssessments: 0 })
  })
})

describe('persisted facts adapted to a daily plan', () => {
  it('prioritizes the actual confirmed prerequisite, not the advanced point, and retains the correct source', async () => {
    const snapshot = await courseFixture({ points: [point('advanced', { questionRefs: [] }), point('foundation', { questionRefs: [] })],
      relations: [relation('dependency', 'foundation', 'advanced')] })
    const candidates = coursePlanCandidates(snapshot)
    expect(candidates.find((item) => item.pointId === 'foundation')).toMatchObject({ type: 'prerequisite', sourceStatus: 'valid' })
    expect(candidates.find((item) => item.pointId === 'advanced')).toMatchObject({ type: 'new' })
    const plan = buildDailyPlan(candidates, { learningDate: '2026-10-13', timeBudgetMinutes: 10, questionLimit: 10 })
    expect(plan.selected[0].pointId).toBe('foundation')
  })
  it('retains new learning after skipped or empty submissions and recommends unscheduled remediation after failure', async () => {
    const snapshot = await courseFixture({ attempts: [attempt('skipped')], assessments: [assessment('skipped', { outcome: 'skipped' })] })
    expect(coursePlanCandidates(snapshot).find((item) => item.pointId === 'point')?.type).toBe('new')
    snapshot.attempts = [attempt('empty', '2026-10-13', { answer: '' })]
    snapshot.assessments = []
    expect(coursePlanCandidates(snapshot).find((item) => item.pointId === 'point')?.type).toBe('new')
    snapshot.attempts = [attempt('failed', '2026-10-13', { answer: 1 })]
    expect(coursePlanCandidates(snapshot).find((item) => item.pointId === 'point')?.type).toBe('remediation')
    snapshot.schedules = [schedule({ status: 'remediation' })]
    expect(coursePlanCandidates(snapshot).filter((item) => item.pointId === 'point' && item.type === 'remediation')).toHaveLength(1)
  })
  it('keeps pending knowledge, disputed queues and missing question snapshots visibly unavailable', async () => {
    const issue: QuestionIssue = { ...base('issue'), kind: 'issue', question: ref(), reason: 'answer', note: '', status: 'open' }
    const snapshot = await courseFixture({ points: [point('point', { status: 'pending' })], schedules: [schedule()], issues: [issue] })
    const candidates = coursePlanCandidates(snapshot)
    expect(candidates.find((item) => item.id === 'schedule')).toMatchObject({ paused: true, pointId: undefined })
    expect(candidates.find((item) => item.id === 'point:point')).toMatchObject({ sourceStatus: 'pending' })
    snapshot.archives = []
    expect(coursePlanCandidates(snapshot).find((item) => item.id === 'schedule')?.sourceStatus).toBe('missing')
    expect(buildDailyPlan(coursePlanCandidates(snapshot), { learningDate: '2026-10-13', timeBudgetMinutes: 30, questionLimit: 10 }).selected).toEqual([])
  })
  it('allows honest personal reading without original sources and keeps application tasks on the merged destination', async () => {
    const task: ApplicationTask = { ...base('task'), kind: 'application', pointIds: ['from'], title: '解释实验', prompt: '解释', response: '', rubric: ['说明'], checks: [false], status: 'pending' }
    const from = point('from', { sourceRefs: [], questionRefs: [] })
    const to = point('to', { sourceRefs: [], questionRefs: [] })
    const snapshot = await courseFixture({ points: [from, to], applicationTasks: [task] })
    expect(coursePlanCandidates(snapshot).find((item) => item.id === 'point:from')).toMatchObject({ sourceStatus: 'valid', reason: expect.stringContaining('个人整理') })
    const merged = mergeKnowledgePoints(snapshot, 'from', 'to', { eventId: 'merge', at, confirmed: true })
    snapshot.points = merged.points
    snapshot.relations = merged.relations
    snapshot.merges = [merged.event]
    expect(coursePlanCandidates(snapshot).find((item) => item.id === 'task')).toMatchObject({ type: 'application', pointId: 'to', questionCount: 0 })
    snapshot.applicationTasks[0].status = 'completed'
    snapshot.applicationTasks[0].response = '我的实验解释'
    snapshot.applicationTasks[0].checks = [true]
    expect(buildKnowledgeCoverage(snapshot).find((item) => item.pointId === 'to')?.completedApplicationSelfAssessments).toBe(1)
  })
})

describe('explicit exam scope and existing question assembly', () => {
  it('splits only in-scope tasks within daily capacities and exposes unfinished and no-task scope', () => {
    const points = [point(), point('outside'), point('no-questions')]
    const tasks = [candidate('one'), candidate('two'), candidate('three'), candidate('outside', { pointId: 'outside' })]
    const result = buildExamPlan(points, tasks, { startDate: '2026-10-13', examDate: '2026-10-15', scopePointIds: ['point', 'no-questions'], timeBudgetMinutes: 5, questionLimit: 1 })
    expect(result.days.map((day) => day.selected.length)).toEqual([1, 1])
    expect(result.unplannedCount).toBe(1)
    expect(result.outsideScope.map((task) => task.id)).toEqual(['outside'])
    expect(result.noTaskPointIds).toEqual(['no-questions'])
    expect(result.days.every((day) => day.estimatedMinutes <= 5 && day.questionCount <= 1)).toBe(true)
  })
  it('does not pull future reviews forward merely because the point is an exam priority', () => {
    const result = buildExamPlan([point()], [candidate('future', { dueDate: '2026-10-20' })], { startDate: '2026-10-13', examDate: '2026-10-15',
      scopePointIds: ['point'], priorityPointIds: ['point'], timeBudgetMinutes: 30, questionLimit: 10 })
    expect(result.days.flatMap((day) => day.selected)).toEqual([])
    expect(result.remaining).toHaveLength(1)
  })
  it('handles an exam today, excluded unavailable sources, and invalid date or scope', () => {
    const options = { startDate: '2026-10-13', examDate: '2026-10-13', scopePointIds: ['point'], timeBudgetMinutes: 30, questionLimit: 10 }
    const result = buildExamPlan([point()], [candidate('one'), candidate('paused', { paused: true })], options)
    expect(result.days).toEqual([])
    expect(result.unplannedCount).toBe(2)
    expect(buildExamPlan([point()], [candidate('one')], { ...options, includeExamDate: true }).days[0].selected).toHaveLength(1)
    expect(() => buildExamPlan([point()], [], { ...options, examDate: '2026-10-12' })).toThrow(LearningRuleError)
    expect(() => buildExamPlan([point()], [], { ...options, scopePointIds: ['missing'] })).toThrow()
    expect(() => buildExamPlan([point()], [], { ...options, examDate: '2028-10-13' })).toThrow(LearningRuleError)
  })
  it('assembles existing confirmed nonduplicate questions, reports shortages and untested scope', async () => {
    const input = await coverageFixture({ points: [point('point', { questionRefs: [ref(), ref('boolean'), ref('short')] }), point('no-questions', { questionRefs: [] })] })
    const inventory = examQuestionInventory(input.points, input.archives)
    const duplicate = { ...inventory[0], question: { ...inventory[0].question, archiveId: 'duplicate' } }
    const result = assembleExamQuestions([...inventory, duplicate], { scopePointIds: ['point', 'no-questions'], count: 5 })
    expect(result).toMatchObject({ availableCount: 3, requestedCount: 5, missingCount: 2, uncoveredPointIds: ['no-questions'], generatedQuestionCount: 0,
      typeCounts: { 'multiple-choice': 1, 'true-false': 1, 'short-answer': 1 }, levelCounts: { recall: 3, explanation: 0, application: 0 } })
    expect(result.reasons).toHaveLength(2)
    expect(assembleExamQuestions(inventory, { scopePointIds: ['point'], count: 0 }).selected).toEqual([])
    expect(() => assembleExamQuestions(inventory, { scopePointIds: ['point'], count: 1.5 })).toThrow()
  })
  it('prefers questions covering missing selected points and excludes disputed or unconfirmed questions', async () => {
    const input = await coverageFixture({ points: [point('a', { questionRefs: [ref(), ref('boolean')] }), point('b', { questionRefs: [ref()] })] })
    const inventory = examQuestionInventory(input.points, input.archives)
    expect(assembleExamQuestions(inventory, { scopePointIds: ['a', 'b'], count: 1 }).coveredPointIds).toEqual(['a', 'b'])
    const issue: QuestionIssue = { ...base('issue'), kind: 'issue', question: ref(), reason: 'ambiguous', note: '', status: 'open' }
    const filtered = examQuestionInventory(input.points, input.archives, [issue])
    filtered[1].question.confirmed = false
    expect(assembleExamQuestions(filtered, { scopePointIds: ['a', 'b'], count: 3 }).selected).toEqual([])
  })
})
