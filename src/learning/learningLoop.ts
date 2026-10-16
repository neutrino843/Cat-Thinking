import { db } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { LearningError, learningBase, type CourseSnapshot, type LearningJourney, type ReviewSchedule } from './model'
import { getCourse, getEntity, listCourses, listEntities, loadCourseSnapshot, saveLearningBatch, savePracticeBundle } from './repository'
import { archivedQuestions, sameQuestion } from './workspaceView'
import { addLearningDays, learningDate, proposeReviewSchedule, REVIEW_RULE_VERSION } from './reviewScheduler'
import { buildPersonalPlan } from './personalPlan'
import { loadPersonalCapacity } from './preferences'
import { loadTodayPlanPreferences } from './todayPlanPreferences'
import { createFocusedSession as createGuidedSession } from './session'
import { visibleQuestions } from './workspaceView'

export async function startFormalSession(snapshot: CourseSnapshot, pointId: string, practiceFirst: boolean) {
  const snapshots = await planningSnapshots()
  return transaction(async () => {
    const point = await getEntity(pointId, 'point')
    if (!point || point.courseId !== snapshot.course.id || point.status !== 'active' || point.questionRefs.some((ref) => !ref.confirmed)) throw new LearningError('invalid', '先核对知识点和题目归属。')
    const existing = (await listEntities(point.courseId, 'session')).find((item) => item.purpose !== 'exam' && item.status === 'active' && item.pointIds.length === 1 && item.pointIds[0] === pointId)
    if (existing) return existing
    const planning = await reserve(snapshots, point.courseId, 10)
    const candidate = createGuidedSession({ ...snapshot, points: snapshot.points.map((item) => item.id === pointId ? point : item) }, [point])
    if (!visibleQuestions(snapshot, pointId).length) candidate.steps = candidate.steps.filter((step) => step.action !== 'practice')
    if (practiceFirst && candidate.checkpoint && candidate.steps.some((step) => step.action === 'practice')) candidate.checkpoint = { ...candidate.checkpoint, stepIndex: candidate.steps.findIndex((step) => step.action === 'practice') }
    candidate.planning = planning
    return (await saveLearningBatch([{ entity: candidate, expectedRevision: null }]))[0] as import('./model').LearningSession
  })
}

export function documentLearningState(snapshot: CourseSnapshot, docId: string, archiveId?: string) {
  const archives = snapshot.archives.filter((item) => archiveId ? item.id === archiveId : item.originDocId === docId)
  const ids = new Set(archives.map((item) => item.id))
  const points = snapshot.points.filter((item) => item.status !== 'retired' && (ids.has(item.archiveId ?? '') || item.docId === docId || item.sourceRefs.some((ref) => ids.has(ref.archiveId))))
  const pending = points.filter((item) => item.status === 'pending' || item.questionRefs.some((ref) => !ref.confirmed))
  const ready = points.filter((item) => item.status === 'active' && !pending.includes(item))
  return { archives, points, pending, ready, questions: archivedQuestions(archives) }
}
export function readingExcerpt(text: string, position: number) {
  const start = Math.min(Math.max(0, position), text.length)
  let end = Math.min(text.length, start + 1200)
  if (end < text.length) { const split = text.lastIndexOf('\n', end); if (split > start + 200) end = split + 1 }
  return { start, end, quote: text.slice(start, end), hasNext: end < text.length }
}
const transaction = <T,>(job: () => Promise<T>) => db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones, db.docs, db.sources, db.documentTombstones], job)
async function planningSnapshots() { return Promise.all((await listCourses()).map((course) => loadCourseSnapshot(course.id))) }
export async function saveRemediationAttempt(...args: Parameters<typeof savePracticeBundle>) {
  const snapshots = await planningSnapshots()
  return transaction(async () => {
    if (!await getEntity(args[0].id, 'attempt')) {
      const current = await Promise.all(snapshots.map(async (item) => ({ ...item, attempts: await listEntities(item.course.id, 'attempt'), sessions: await listEntities(item.course.id, 'session'), journeys: await listEntities(item.course.id, 'journey') })))
      const plan = buildPersonalPlan(current, Date.now(), loadPersonalCapacity())
      const course = await getCourse(args[0].courseId)
      const own = current.find((item) => item.course.id === args[0].courseId)
      const ownPlan = own && course && buildPersonalPlan([own], Date.now(), { minutes: course.dailyMinutes, questions: course.dailyQuestionLimit })
      if (!ownPlan || plan.remainingQuestions < 1 || ownPlan.remainingQuestions < 1) throw new LearningError('limit', '今天的题数额度已用完。修正笔记保留，可暂停后下次重试，或回首页调整安排。')
    }
    return savePracticeBundle(...args)
  })
}
async function reserve(snapshotList: CourseSnapshot[], courseId: string, minutes: number, parentSessionId?: string) {
  const at = Date.now(), date = learningDate(at)
  const current = await Promise.all(snapshotList.map(async (snapshot) => ({ ...snapshot, course: await getCourse(snapshot.course.id) ?? snapshot.course,
    journeys: await listEntities(snapshot.course.id, 'journey'), sessions: await listEntities(snapshot.course.id, 'session'), attempts: await listEntities(snapshot.course.id, 'attempt') })))
  if (parentSessionId && current.find((item) => item.course.id === courseId)?.sessions.some((item) => item.id === parentSessionId && item.planning?.date === date)) return { date, minutes: 0 }
  const plan = buildPersonalPlan(current, at, loadPersonalCapacity(), '', loadTodayPlanPreferences())
  const course = current.find((item) => item.course.id === courseId)
  const used = course ? buildPersonalPlan([course], at, { minutes: course.course.dailyMinutes, questions: course.course.dailyQuestionLimit }) : undefined
  if (!course || plan.remainingMinutes < minutes || (used?.remainingMinutes ?? 0) < minutes) throw new LearningError('limit', '今天的时间额度不足。进度保留，可在首页调整完整安排或下次继续。')
  return { date, minutes }
}
/** Validate current local source before every transition, not just when first opened. */
export async function journeySource(journey: LearningJourney, snapshot: CourseSnapshot) {
  if (journey.blockedReason) throw new LearningError('missing', journey.blockedReason)
  if (journey.mode === 'reading') {
    const binding = journey.source
    const source = binding && await db.sources.get(binding.sourceId)
    if (!binding || !source || source.docId !== binding.docId || !await db.docs.get(binding.docId) || !snapshot.documents.some((item) => item.docId === binding.docId)) throw new LearningError('missing', '阅读原文已缺失或移出课程。笔记保留，请回课程检查资料。')
    if (await sha256Hex(source.text) !== binding.sourceHash) throw new LearningError('conflict', '原文版本已变化。旧笔记保留，请核对后从这份资料重新开始。')
    return { text: source.text, name: source.name }
  }
  const item = archivedQuestions(snapshot.archives).find((item) => journey.questionRef && sameQuestion(item.ref, journey.questionRef))
  if (!item || item.archive.contentHash !== journey.archiveHash) throw new LearningError('missing', '补学原题或原文版本已失效，请先检查课程资料。')
  if (snapshot.issues.some((item) => item.status === 'open' && journey.questionRef && sameQuestion(item.question, journey.questionRef))) throw new LearningError('conflict', '这道题有待核对疑问，请先检查题目，明确恢复后再继续。')
  const citations = item.question.citations.filter((ref) => ref.provenance === 'source')
  const text = citations.map((ref) => item.archive.sources.find((source) => source.id === ref.sourceId)?.text.slice(ref.start, ref.end) ?? '').join('\n\n')
  if (!text.trim()) throw new LearningError('missing', '本题没有可用原文依据，请先回课程核对。')
  return { name: '原题的原文依据', text }
}
export async function startReadingJourney(courseId: string, docId: string): Promise<LearningJourney> {
  const snapshots = await planningSnapshots()
  const source = (await db.sources.where('docId').equals(docId).toArray()).find((item) => item.text.trim())
  if (!source) throw new LearningError('missing', '这份资料没有可读取的原文，请查看导图或换一份资料。')
  const hash = await sha256Hex(source.text)
  return transaction(async () => {
    const course = await getCourse(courseId)
    if (!course || !(await listEntities(courseId, 'document')).some((item) => item.docId === docId) || (await db.sources.get(source.id))?.text !== source.text) throw new LearningError('missing', '资料或课程归属已变化，请重新读取。')
    const journeys = await listEntities(courseId, 'journey')
    const existing = journeys.find((item) => item.mode === 'reading' && item.source?.docId === docId && item.source.sourceHash === hash && item.status !== 'completed')
    const previous = journeys.filter((item) => item.mode === 'reading' && item.source?.docId === docId && item.source.sourceHash === hash && item.status === 'completed').sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const planning = existing?.planning?.date === learningDate(Date.now()) ? existing.planning : await reserve(snapshots, courseId, 5)
    const candidate: LearningJourney = existing ? { ...existing, status: 'active', planning } : { ...learningBase(courseId), kind: 'journey', mode: 'reading', title: source.name.slice(0, 500), status: 'active', step: 0, note: previous?.note ?? '', position: previous?.position ?? 0, scroll: previous?.scroll ?? 0, source: { docId, sourceId: source.id, sourceHash: hash }, planning }
    const consumed = journeys.filter((item) => item.id === previous?.id && item.dueDate).map((item) => { const changed = { ...item }; delete changed.dueDate; return { entity: changed, expectedRevision: item.revision } })
    return (await saveLearningBatch([{ entity: candidate, expectedRevision: existing?.revision ?? null }, ...consumed]))[0] as LearningJourney
  })
}
export async function startRemediationJourney(snapshot: CourseSnapshot, attemptId: string, originSessionId?: string): Promise<LearningJourney> {
  const snapshots = await planningSnapshots()
  return transaction(async () => {
    const attempt = await getEntity(attemptId, 'attempt')
    if (!attempt || attempt.courseId !== snapshot.course.id) throw new LearningError('missing', '原回答已不存在，请重新读取。')
    const existing = (await listEntities(snapshot.course.id, 'journey')).find((item) => item.mode === 'remediation' && item.attemptId === attemptId && item.status !== 'completed')
    const archive = await getEntity(attempt.question.archiveId, 'archive')
    if (!archive) throw new LearningError('missing', '原题已经不可用。')
    const parent = attempt.sessionId ? await getEntity(attempt.sessionId, 'session') : undefined
    const parentId = parent?.purpose !== 'exam' ? parent?.id : undefined
    const planning = existing?.planning?.date === learningDate(Date.now()) ? existing.planning : await reserve(snapshots, snapshot.course.id, 5, parentId)
    const candidate: LearningJourney = existing ? { ...existing, status: 'active', planning } : { ...learningBase(snapshot.course.id), kind: 'journey', mode: 'remediation', title: '核对这一题，再试一次', status: 'active', step: 0, note: '', position: 0, scroll: 0, questionRef: attempt.question, archiveHash: archive.contentHash, attemptId, planning, ...(parentId ? { parentSessionId: parentId } : {}), ...(originSessionId ? { originSessionId } : {}) }
    if ((await listEntities(snapshot.course.id, 'issue')).some((item) => item.status === 'open' && sameQuestion(item.question, attempt.question))) throw new LearningError('conflict', '题目有疑问，请先核对，不能直接进入补学。')
    return (await saveLearningBatch([{ entity: candidate, expectedRevision: existing?.revision ?? null }]))[0] as LearningJourney
  })
}
export async function saveJourney(journey: LearningJourney): Promise<LearningJourney> {
  const snapshot = await loadCourseSnapshot(journey.courseId)
  const original = await journeySource(journey, snapshot)
  return transaction(async () => {
    if (journey.source && (await db.sources.get(journey.source.sourceId))?.text !== original.text) throw new LearningError('conflict', '原文在保存时变化，请保留文字后重新读取。')
    if (journey.questionRef && (await getEntity(journey.questionRef.archiveId, 'archive'))?.contentHash !== journey.archiveHash) throw new LearningError('conflict', '归档版本已经变化。')
    return (await saveLearningBatch([{ entity: journey, expectedRevision: journey.revision }]))[0] as LearningJourney
  })
}
export async function resumeJourney(journey: LearningJourney): Promise<LearningJourney> {
  if (journey.status === 'completed') return journey
  const snapshot = await loadCourseSnapshot(journey.courseId)
  const actual = snapshot.journeys?.find((item) => item.id === journey.id)
  if (!actual) throw new LearningError('missing', '这轮学习已不存在。')
  const original = await journeySource(actual, snapshot)
  const snapshots = await planningSnapshots()
  return transaction(async () => {
    const current = await getEntity(journey.id, 'journey')
    if (!current) throw new LearningError('missing', '这轮学习已不存在。')
    if (current.source && (await db.sources.get(current.source.sourceId))?.text !== original.text) throw new LearningError('conflict', '原文在恢复时变化，请回资料检查。')
    if (current.questionRef && (await getEntity(current.questionRef.archiveId, 'archive'))?.contentHash !== current.archiveHash) throw new LearningError('conflict', '补学原题版本已变化。')
    if (current.status === 'active' && current.planning?.date === learningDate(Date.now()) && current.source?.sourceHash === actual.source?.sourceHash && current.archiveHash === actual.archiveHash) return current
    if (current.revision !== actual.revision) throw new LearningError('conflict', '进度已变化，请重新打开。')
    const planning = current.planning?.date === learningDate(Date.now()) ? current.planning : await reserve(snapshots, journey.courseId, 5, current.parentSessionId)
    return (await saveLearningBatch([{ entity: { ...current, planning, status: 'active' }, expectedRevision: current.revision }]))[0] as LearningJourney
  })
}
export async function completeJourney(journey: LearningJourney, date: string | undefined, useAutomatic: boolean): Promise<LearningJourney> {
  const snapshot = await loadCourseSnapshot(journey.courseId)
  const original = await journeySource(journey, snapshot)
  if (date && date <= learningDate(Date.now(), snapshot.course.timeZone)) throw new LearningError('invalid', '请选择今天之后的回看或复习日期。')
  if (!journey.note.trim()) throw new LearningError('invalid', '先记下一点自己的理解或修正，再结束这一轮。')
  return transaction(async () => {
    const latest = await getEntity(journey.id, 'journey')
    if (latest?.status === 'completed') return latest
    if (!latest || latest.revision !== journey.revision) throw new LearningError('conflict', '学习进度已被其他窗口更新，请保留文字并重新读取。')
    if (journey.source && (await db.sources.get(journey.source.sourceId))?.text !== original.text) throw new LearningError('conflict', '原文在保存时变化。')
    if (journey.questionRef && (await getEntity(journey.questionRef.archiveId, 'archive'))?.contentHash !== journey.archiveHash) throw new LearningError('conflict', '补学版本已变化。')
    const course = await getCourse(journey.courseId)
    if (!course) throw new LearningError('missing', '课程已不存在。')
    const next: LearningJourney = { ...journey, status: 'completed', step: 3, finishedAt: Date.now() }
    delete next.dueDate
    const changes: Parameters<typeof saveLearningBatch>[0] = []
    if (journey.mode === 'reading') {
      if (date) next.dueDate = date
      const id = `${journey.id}:personal`
      if (!await getEntity(id, 'point')) changes.push({ entity: { ...learningBase(journey.courseId, id), kind: 'point', title: journey.title.slice(0, 200), definition: journey.note, chapter: '', aliases: [], notes: '来自个人阅读解释，尚未正式测验。', sourceRefs: [], questionRefs: [], status: 'active', goalIncluded: false, ...(journey.source ? { docId: journey.source.docId } : {}) }, expectedRevision: null })
    }
    else if (journey.questionRef) {
      const questionRef = journey.questionRef
      if ((await listEntities(journey.courseId, 'issue')).some((item) => item.status === 'open' && sameQuestion(item.question, questionRef))) throw new LearningError('conflict', '题目仍有疑问，不能结束补学并恢复安排。')
      const retry = journey.retryAttemptId && await getEntity(journey.retryAttemptId, 'attempt')
      if (!retry || !sameQuestion(retry.question, journey.questionRef) || retry.submittedAt === null || retry.createdAt < journey.createdAt) throw new LearningError('invalid', '先提交这次重试，原回答仍会保留。')
      const assessment = (await listEntities(journey.courseId, 'assessment')).filter((item) => item.attemptId === retry.id).at(-1)
      if (!assessment?.selfAssessmentComplete) throw new LearningError('invalid', '请先完成这次重试的简答自评。')
      const previous = (await listEntities(journey.courseId, 'schedule')).find((item) => sameQuestion(item.question, questionRef))
      if (previous?.status === 'paused') throw new LearningError('conflict', '这道题的复习已暂停，请先明确恢复，再结束补学。')
      if (previous || date || useAutomatic && course.automaticReviews) {
        const base: ReviewSchedule = previous ?? { ...learningBase(journey.courseId), kind: 'schedule', question: journey.questionRef, status: 'active', dueDate: date ?? learningDate(Date.now(), course.timeZone), manual: !!date, stage: 0, ruleVersion: REVIEW_RULE_VERSION }
        if (date && !previous?.manual) { base.dueDate = date; base.manual = true }
        // Failure remains remediation. Reading an explanation must never turn failure into success.
        const nextSchedule = assessment.outcome === 'failure' || assessment.difficulty === 'again' ? { ...base, status: 'remediation' as const } : proposeReviewSchedule(base, { attemptId: retry.id, utcTimestamp: Date.now(), timeZone: course.timeZone, action: 'remediation-complete', outcome: assessment.outcome, answerProvided: true, answerRevealedBeforeSubmit: true, questionType: 'objective', selfAssessmentComplete: true }).schedule
        if (previous?.manual) nextSchedule.dueDate = previous.dueDate
        else if (!date && (!useAutomatic || !course.automaticReviews)) nextSchedule.dueDate = base.dueDate
        else if (!nextSchedule.manual && nextSchedule.status === 'active') nextSchedule.dueDate = addLearningDays(learningDate(Date.now(), course.timeZone), 1)
        changes.push({ entity: nextSchedule, expectedRevision: previous?.revision ?? null })
      }
    }
    const saved = await saveLearningBatch([{ entity: next, expectedRevision: journey.revision }, ...changes])
    return saved[0] as LearningJourney
  })
}
