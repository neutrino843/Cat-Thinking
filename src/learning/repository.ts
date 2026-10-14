import Dexie from 'dexie'
import { canonicalizeJson, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { db } from '../store/db'
import { artifactContentHash, prepareArtifactIdentity, verifyPreparedArtifactIdentity } from '../analysis/localArtifactIdentity'
import { deriveKnowledgePracticeLinks } from '../analysis/knowledgePracticeLinks'
import { sha256Hex } from '../analysis/fingerprint'
import type { QuizPracticeRecord } from '../analysis/quizPractice'
import { prerequisiteCycle, questionRefKey } from './knowledgeGraph'
import { archiveHashPayload, parseLearningEntity, parseSourceDocument, validateLearningArchive } from './archiveValidation'
import {
  LearningError, learningBase, newLearningId,
  type Course, type CourseSnapshot, type EntityOf, type LearningEntity, type LearningKind, type LearningArchive,
  type KnowledgePoint, type QuestionRef, type PracticeAttempt, type AssessmentEvent, type ReviewSchedule,
  type NodeBinding, type KnowledgeRelation, type KnowledgeMergeEvent,
} from './model'

const immutable = new Set<LearningKind>(['archive', 'attempt', 'assessment', 'merge'])
function conflict(): never { throw new LearningError('conflict', '记录已在其他页面更新或删除，请重新载入后再保存。') }
export async function getEntity<K extends LearningKind>(id: string, kind: K): Promise<EntityOf<K> | undefined> {
  const row = await db.learningRecords.get(id); if (!row) return undefined
  const entity = parseLearningEntity(row); if (entity.kind !== kind) throw new LearningError('corrupt', '学习记录类型不一致。')
  return entity as EntityOf<K>
}
export async function listEntities<K extends LearningKind>(courseId: string, kind: K): Promise<EntityOf<K>[]> {
  return (await db.learningRecords.where('[courseId+kind]').equals([courseId, kind]).toArray()).map((r) => parseLearningEntity(r) as EntityOf<K>)
}
export async function getCourse(id: string): Promise<Course | undefined> { return getEntity(id, 'course') }
export async function listCourses(): Promise<Course[]> {
  return (await db.learningRecords.where('kind').equals('course').toArray()).map((r) => parseLearningEntity(r) as Course).sort((a, b) => b.updatedAt - a.updatedAt)
}
async function requireCourse(courseId: string): Promise<Course> {
  if (await db.learningCourseTombstones.get(courseId)) conflict()
  const course = await getCourse(courseId); if (!course) throw new LearningError('missing', '课程已经不存在。'); return course
}
async function goalScope(courseId: string): Promise<string[]> {
  return (await listEntities(courseId, 'point')).filter((p) => p.status === 'active' && p.goalIncluded !== false).map((p) => p.id).sort()
}
async function recordGoalScopeChange(courseId: string, before: readonly string[]): Promise<void> {
  const after = await goalScope(courseId); if (canonicalizeJson(before) === canonicalizeJson(after)) return
  const course = await requireCourse(courseId); await db.learningRecords.put({ ...course, goalVersion: course.goalVersion + 1, revision: course.revision + 1, updatedAt: Date.now() })
}
async function requirePoint(courseId: string, id: string): Promise<KnowledgePoint> {
  const point = await getEntity(id, 'point'); if (!point || point.courseId !== courseId) throw new LearningError('invalid', '知识点不属于当前课程。'); return point
}
async function requireQuestion(courseId: string, ref: QuestionRef): Promise<void> {
  const archive = await getEntity(ref.archiveId, 'archive'); if (!archive || archive.courseId !== courseId || !getArchivedQuestion(archive, ref)) throw new LearningError('invalid', '题目归档不存在或已失效。')
}
/** Only IndexedDB operations inside transactions; archived crypto checks happen at creation/read/export. */
async function requireReferences(entity: LearningEntity): Promise<void> {
  if (entity.kind !== 'course') await requireCourse(entity.courseId)
  if (entity.kind === 'course') for (const goal of entity.goals ?? []) for (const pointId of goal.pointIds) await requirePoint(entity.courseId, pointId)
  if (entity.kind === 'support') {
    if (!await db.docs.get(entity.docId)) throw new LearningError('missing', '辅助资料快照已不存在。')
    for (const id of entity.pointIds) await requirePoint(entity.courseId, id)
    for (const ref of entity.sourceRefs) { const archive = await getEntity(ref.archiveId, 'archive'); const source = archive?.sources.find((item) => item.id === ref.sourceId); if (!source || archive?.courseId !== entity.courseId || ref.end > source.text.length) throw new LearningError('invalid', '辅助来源已失效。') }
    if (entity.questionRef) await requireQuestion(entity.courseId, entity.questionRef)
    if (entity.generatedArchiveId && (await getEntity(entity.generatedArchiveId, 'archive'))?.courseId !== entity.courseId) throw new LearningError('invalid', '辅助归档不属于课程。')
    if (entity.attemptId && (await getEntity(entity.attemptId, 'attempt'))?.courseId !== entity.courseId) throw new LearningError('invalid', '辅助作答不属于课程。')
    if (entity.sessionId && (await getEntity(entity.sessionId, 'session'))?.courseId !== entity.courseId) throw new LearningError('invalid', '辅助会话不属于课程。')
  }
  if ('question' in entity) await requireQuestion(entity.courseId, entity.question)
  if (entity.kind === 'attempt' || entity.kind === 'draft' && entity.answer !== null) {
    const archive = await getEntity(entity.question.archiveId, 'archive'); const question = archive && getArchivedQuestion(archive, entity.question)
    if (!question || question.type === 'multiple-choice' && (typeof entity.answer !== 'number' || entity.answer < 0 || entity.answer >= question.options.length)
      || question.type === 'true-false' && typeof entity.answer !== 'boolean' || question.type === 'short-answer' && typeof entity.answer !== 'string') throw new LearningError('invalid', '作答类型与归档题目不一致。')
  }
  if (entity.kind === 'attempt' && entity.sessionId) {
    const session = await getEntity(entity.sessionId, 'session')
    if (session?.examConfig?.mode === 'simulation' && Date.now() >= session.createdAt + session.examConfig.durationMinutes * 60000) throw new LearningError('conflict', '模拟时间已结束，请结束场次并查看报告。')
    const matches = session?.purpose === 'exam' ? session.questions?.some((q) => q.archiveId === entity.question.archiveId && q.artifactId === entity.question.artifactId && q.questionId === entity.question.questionId)
      : session && (await listEntities(entity.courseId, 'point')).some((point) => point.status === 'active' && session.pointIds.includes(point.id) && point.questionRefs.some((q) => q.confirmed && q.archiveId === entity.question.archiveId && q.artifactId === entity.question.artifactId && q.questionId === entity.question.questionId))
    if (!session || session.status !== 'active') throw new LearningError('conflict', '学习场次已结束，请重新载入。')
    if (session.checkpoint?.paused) throw new LearningError('conflict', '学习场次已暂停，请继续会话后作答。')
    if (session.courseId !== entity.courseId || !matches) throw new LearningError('conflict', '题目不属于该场次，请重新载入。')
  }
  if (entity.kind === 'attempt' && entity.origin === 'practice' || entity.kind === 'schedule' && entity.status !== 'paused') {
    const question = entity.question; const issues = await listEntities(entity.courseId, 'issue')
    if (issues.some((r) => r.status === 'open' && r.question.archiveId === question.archiveId && r.question.artifactId === question.artifactId && r.question.questionId === question.questionId)) throw new LearningError('conflict', '题目有待核对疑问，已暂停提交与复习。')
  }
  if (entity.kind === 'schedule' || entity.kind === 'draft') {
    const others = await listEntities(entity.courseId, entity.kind)
    if (others.some((r) => r.id !== entity.id && r.question.archiveId === entity.question.archiveId && r.question.artifactId === entity.question.artifactId && r.question.questionId === entity.question.questionId)) throw new LearningError('conflict', '这道题已有有效草稿或复习安排，请重新读取。')
  }
  if (entity.kind === 'point' || entity.kind === 'relation') for (const ref of entity.sourceRefs ?? []) {
    const archive = await getEntity(ref.archiveId, 'archive'); const source = archive?.sources.find((s) => s.id === ref.sourceId)
    if (!archive || archive.courseId !== entity.courseId || !source || ref.end > source.text.length) throw new LearningError('invalid', '原文引用范围或归属无效。')
  }
  if (entity.kind === 'point') {
    for (const q of entity.questionRefs) await requireQuestion(entity.courseId, q)
    if (entity.parentId) {
      const seen = new Set([entity.id]); let next: string | undefined = entity.parentId
      while (next) { if (seen.has(next)) throw new LearningError('invalid', '知识章节不能循环包含。'); seen.add(next); next = (await requirePoint(entity.courseId, next)).parentId }
    }
  }
  if (entity.kind === 'assessment') {
    const attempt = await getEntity(entity.attemptId, 'attempt'); if (!attempt || attempt.courseId !== entity.courseId) throw new LearningError('invalid', '作答记录不属于当前课程。')
    if (entity.feedbackArchiveId && (await getEntity(entity.feedbackArchiveId, 'archive'))?.courseId !== entity.courseId) throw new LearningError('invalid', '反馈依据不属于当前课程。')
  }
  if (entity.kind === 'relation') {
    await requirePoint(entity.courseId, entity.fromPointId); await requirePoint(entity.courseId, entity.toPointId)
    if (entity.confirmed && entity.type === 'prerequisite') {
      const edges = (await listEntities(entity.courseId, 'relation')).filter((r) => r.id !== entity.id && r.confirmed && r.type === 'prerequisite')
      const pending = [entity.toPointId]; const seen = new Set<string>()
      while (pending.length) { const next = pending.pop(); if (next === undefined) break; if (next === entity.fromPointId) throw new LearningError('invalid', '前置关系形成循环，请调整关联。'); if (seen.has(next)) continue; seen.add(next); pending.push(...edges.filter((r) => r.fromPointId === next).map((r) => r.toPointId)) }
    }
  }
  if (entity.kind === 'merge') {
    await requirePoint(entity.courseId, entity.fromPointId); await requirePoint(entity.courseId, entity.toPointId)
    for (const snapshot of [...entity.beforePoints ?? [], ...entity.beforeRelations ?? []]) await requireReferences(snapshot)
  }
  if (entity.kind === 'session' || entity.kind === 'application') for (const pointId of entity.pointIds) await requirePoint(entity.courseId, pointId)
  if (entity.kind === 'session') {
    if (entity.status === 'active' && entity.checkpoint) {
      const course = await requireCourse(entity.courseId)
      if (entity.checkpoint.goalVersion !== course.goalVersion) throw new LearningError('conflict', '课程目标已变化，请重新核对会话。')
      for (const [id, revision] of Object.entries(entity.checkpoint.pointRevisions)) { const point = await requirePoint(entity.courseId, id); if (point.revision !== revision || point.status !== 'active') throw new LearningError('conflict', '会话知识点已变化，请重新核对。') }
      for (const [id, hash] of Object.entries(entity.checkpoint.archiveHashes)) if ((await getEntity(id, 'archive'))?.contentHash !== hash) throw new LearningError('conflict', '会话归档已变化或删除。')
    }
    for (const ref of entity.questions ?? []) await requireQuestion(entity.courseId, ref)
    if (entity.purpose === 'exam' && entity.status === 'completed') {
      const attempts = await listEntities(entity.courseId, 'attempt')
      if (entity.questions?.some((q) => !attempts.some((a) => a.sessionId === entity.id && a.question.archiveId === q.archiveId && a.question.artifactId === q.artifactId && a.question.questionId === q.questionId && (typeof a.answer !== 'string' || !!a.answer.trim())))) throw new LearningError('invalid', '测验仍有未提交的题目，可以结束但不能标记为全部完成。')
    }
  }
}

/** expectedRevision=null creates only an absent record; updates always compare-and-swap. */
export async function saveEntity<T extends LearningEntity>(input: T, expectedRevision: number | null): Promise<T> {
  const entity = parseLearningEntity(input) as T
  if (immutable.has(entity.kind)) {
    if (entity.kind === 'archive' || expectedRevision !== null) throw new LearningError('invalid', '归档与学习历史只能追加，不能覆盖。')
    return appendImmutable(entity as PracticeAttempt | AssessmentEvent | KnowledgeMergeEvent) as Promise<T>
  }
  return db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones, db.docs, db.documentTombstones], async () => {
    if (await db.learningCourseTombstones.get(entity.courseId)) conflict()
    if (await db.learningEntityTombstones.get(entity.id)) conflict()
    const current = await db.learningRecords.get(entity.id)
    if ((current?.revision ?? null) !== expectedRevision || current && (current.kind !== entity.kind || current.courseId !== entity.courseId)) conflict()
    await requireReferences(entity)
    const previousGoals = entity.kind === 'point' ? await goalScope(entity.courseId) : undefined
    if (entity.kind === 'document') {
      if (!await db.docs.get(entity.docId) || await db.documentTombstones.get(entity.docId)) throw new LearningError('missing', '可编辑文档已经不存在。')
      const membership = (await db.learningRecords.where('docId').equals(entity.docId).toArray()).find((r) => r.kind === 'document' && r.id !== entity.id)
      if (membership) throw new LearningError('conflict', '文档已加入另一门课程，请先移出。')
    }
    const goalChanged = entity.kind === 'course' && current?.kind === 'course' && (entity.goal !== current.goal || canonicalizeJson(entity.goals ?? []) !== canonicalizeJson(current.goals ?? []))
    const saved = { ...entity, ...(goalChanged ? { goalVersion: Math.max(entity.goalVersion, (current as Course).goalVersion + 1) } : {}), revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? entity.createdAt, updatedAt: Date.now() } as T
    await db.learningRecords.put(saved); if (previousGoals) await recordGoalScopeChange(entity.courseId, previousGoals); return saved
  })
}
export async function createCourse(input: { name: string; goal?: string; timeZone?: string; dailyMinutes?: number; dailyQuestionLimit?: number; examDate?: string }): Promise<Course> {
  const id = newLearningId()
  return saveEntity({ ...learningBase(id, id), kind: 'course', name: input.name.trim(), goal: input.goal ?? '', timeZone: input.timeZone ?? 'Asia/Shanghai', dailyMinutes: input.dailyMinutes ?? 30, dailyQuestionLimit: input.dailyQuestionLimit ?? 20, goalVersion: 1, automaticReviews: false, ...(input.examDate ? { examDate: input.examDate } : {}) }, null)
}
export async function updateCourse(course: Course, expectedRevision = course.revision): Promise<Course> { return saveEntity(course, expectedRevision) }
export async function attachDocument(courseId: string, docId: string, chapter = '') {
  const existing = (await listEntities(courseId, 'document')).find((d) => d.docId === docId)
  if (existing) return saveEntity({ ...existing, chapter }, existing.revision)
  return saveEntity({ ...learningBase(courseId), kind: 'document', docId, chapter }, null)
}
export async function detachDocument(courseId: string, docId: string): Promise<void> {
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones], async () => { await requireCourse(courseId); for (const row of await listEntities(courseId, 'document')) if (row.docId === docId) await db.learningRecords.delete(row.id) })
}
/** Removing course organisation and learning records never deletes editable documents or sources. */
export async function deleteCourseOrganisation(courseId: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones], async () => { const course = await requireCourse(courseId); if (course.revision !== expectedRevision) conflict(); await db.learningCourseTombstones.put({ id: courseId, deletedAt: Date.now() }); await db.learningRecords.where('courseId').equals(courseId).delete() })
}
export async function loadCourseSnapshot(courseId: string): Promise<CourseSnapshot> {
  const snapshot = await db.transaction('r', [db.learningRecords, db.learningCourseTombstones, db.docs], async () => {
    const course = await requireCourse(courseId); const records = (await db.learningRecords.where('courseId').equals(courseId).toArray()).map(parseLearningEntity)
    const rows = <K extends LearningKind>(kind: K) => records.filter((r): r is EntityOf<K> => r.kind === kind)
    const documents = rows('document'); const docs = []
    for (const membership of documents) { const doc = await db.docs.get(membership.docId); if (doc) docs.push({ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt }) }
    return { course, documents, docs, points: rows('point'), archives: rows('archive'), attempts: rows('attempt').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), drafts: rows('draft'), assessments: rows('assessment').sort((a, b) => a.attemptId === b.attemptId && a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.updatedAt - b.updatedAt || a.id.localeCompare(b.id)), schedules: rows('schedule'), relations: rows('relation'), merges: rows('merge'), sessions: rows('session'), applicationTasks: rows('application'), issues: rows('issue'), bindings: rows('binding'), supports: rows('support') }
  })
  await Promise.all(snapshot.archives.map(validateLearningArchive)); return snapshot
}
export async function loadLearningArchive(id: string): Promise<LearningArchive | undefined> { const row = await getEntity(id, 'archive'); return row ? validateLearningArchive(row) : undefined }
export function listArchiveQuestions(archive: LearningArchive) {
  return archive.artifacts.flatMap((artifact) => artifact.kind === 'quiz' ? artifact.payload.questions.map((question) => ({ question, ref: { archiveId: archive.id, artifactId: artifact.id, questionId: question.id, confirmed: false } as QuestionRef })) : [])
}
export function getArchivedQuestion(archive: LearningArchive, ref: QuestionRef) {
  if (archive.id !== ref.archiveId) return undefined
  const artifact = archive.artifacts.find((a) => a.id === ref.artifactId && a.kind === 'quiz')
  return artifact?.kind === 'quiz' ? artifact.payload.questions.find((q) => q.id === ref.questionId) : undefined
}
export async function findArchiveForArtifact(docId: string, runId: string, artifactId: string, expected?: { artifactHash?: string; sourceFingerprint?: string }): Promise<LearningArchive | undefined> {
  const archives = (await db.learningRecords.where('kind').equals('archive').toArray()).map((r) => parseLearningEntity(r) as LearningArchive)
  for (const candidate of archives) {
    if (candidate.originDocId !== docId || candidate.runId !== runId) continue
    const artifact = candidate.artifacts.find((v) => v.id === artifactId); if (!artifact) continue
    if (expected?.artifactHash !== undefined && await artifactContentHash(artifact) !== expected.artifactHash) continue
    if (expected?.sourceFingerprint !== undefined && await sha256Hex(canonicalizeJson(candidate.manifest.sources)) !== expected.sourceFingerprint) continue
    return validateLearningArchive(candidate)
  }
  return undefined
}
export async function createLearningArchive(input: { courseId: string; docId: string; runId: string; artifacts: ArtifactEnvelopeV1[]; title?: string }): Promise<LearningArchive> {
  if (!input.artifacts.length || input.artifacts.length > 5 || new Set(input.artifacts.map((a) => a.kind)).size !== input.artifacts.length) throw new LearningError('invalid', '请选择有效的分析结果归档。')
  const prepared = await Promise.all(input.artifacts.map((artifact) => prepareArtifactIdentity({ docId: input.docId, runId: input.runId, artifact })))
  const first = prepared[0]
  if (prepared.some((p) => canonicalizeJson(p.task.request.manifest) !== canonicalizeJson(first.task.request.manifest))) conflict()
  const archive: LearningArchive = { ...learningBase(input.courseId), kind: 'archive', originDocId: input.docId, provenanceDocId: input.docId, runId: input.runId, title: input.title ?? '学习资料归档', manifest: first.task.request.manifest, sources: first.sources.map(parseSourceDocument), artifacts: [...input.artifacts].sort((a, b) => a.kind.localeCompare(b.kind)), contentHash: '' }
  archive.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(archive)))
  const validated = await validateLearningArchive(archive)
  const points = deriveArchivePoints(validated).map((p) => parseLearningEntity(p) as KnowledgePoint)
  return db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.docs, db.sources, db.analysisTasks, db.documentTombstones], async () => {
    await requireCourse(input.courseId); for (const p of prepared) await verifyPreparedArtifactIdentity(p)
    const previous = (await listEntities(input.courseId, 'archive')).find((a) => a.contentHash === archive.contentHash && a.originDocId === archive.originDocId)
    if (previous) return previous
    const membership = (await db.learningRecords.where('docId').equals(input.docId).toArray()).find((r) => r.kind === 'document')
    if (membership && membership.courseId !== input.courseId) throw new LearningError('conflict', '文档已经归属其他课程。')
    if (!membership) await db.learningRecords.add({ ...learningBase(input.courseId), kind: 'document', docId: input.docId, chapter: '' })
    await db.learningRecords.bulkAdd([validated, ...points]); return validated
  })
}
function deriveArchivePoints(archive: LearningArchive): KnowledgePoint[] {
  const map = archive.artifacts.find((a) => a.kind === 'mindmap'); const quiz = archive.artifacts.find((a) => a.kind === 'quiz')
  const links = map?.kind === 'mindmap' && quiz?.kind === 'quiz' ? deriveKnowledgePracticeLinks({ mindmap: map, quiz }).links : []
  const sourceRefs = (citations: readonly { provenance: string; sourceId?: string; start?: number; end?: number }[]) => citations.flatMap((c) => c.provenance === 'source' && c.sourceId !== undefined && c.start !== undefined && c.end !== undefined ? [{ archiveId: archive.id, sourceId: c.sourceId, start: c.start, end: c.end }] : [])
  if (map?.kind === 'mindmap') {
    const ids = new Map(map.payload.nodes.map((n) => [n.id, newLearningId()]))
    return map.payload.nodes.map((node) => ({ ...learningBase(archive.courseId, ids.get(node.id)), kind: 'point', title: node.text, definition: node.note ?? '', chapter: '', aliases: [], notes: '', archiveId: archive.id, generatedNodeId: node.id,
      ...(node.parentId ? { parentId: ids.get(node.parentId) } : {}), sourceRefs: sourceRefs(node.citations), questionRefs: quiz ? links.filter((l) => l.nodeId === node.id).map((l) => ({ archiveId: archive.id, artifactId: quiz.id, questionId: l.questionId, confirmed: false })) : [], status: 'pending', goalIncluded: true }))
  }
  return listArchiveQuestions(archive).map(({ question, ref }) => ({ ...learningBase(archive.courseId), kind: 'point', title: `练习：${question.prompt}`.slice(0, 500), definition: '', chapter: '待整理练习', aliases: [], notes: '', archiveId: archive.id, sourceRefs: sourceRefs(question.citations), questionRefs: [ref], status: 'pending', goalIncluded: false }))
}
function sameImmutable(left: LearningEntity, right: LearningEntity): boolean {
  const withoutSequence = (r: LearningEntity) => { if (r.kind !== 'assessment') return r; const rest = { ...r }; delete rest.sequence; return rest }
  return canonicalizeJson(withoutSequence(left)) === canonicalizeJson(withoutSequence(right))
}
async function assignAssessmentSequence(event: AssessmentEvent): Promise<AssessmentEvent> {
  const previous = (await listEntities(event.courseId, 'assessment')).filter((r) => r.attemptId === event.attemptId)
  return { ...event, sequence: Math.max(0, ...previous.map((r) => r.sequence ?? 0)) + 1 }
}
async function appendImmutable<T extends PracticeAttempt | AssessmentEvent | KnowledgeMergeEvent>(input: T): Promise<T> {
  const entity = parseLearningEntity(input) as T
  return db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    await requireCourse(entity.courseId); const existing = await db.learningRecords.get(entity.id)
    if (await db.learningEntityTombstones.get(entity.id)) conflict()
    if (existing) { if (!sameImmutable(existing, entity)) conflict(); return existing as T }
    await requireReferences(entity)
    if (entity.revision !== 1) throw new LearningError('invalid', '新历史记录的版本必须为 1。')
    const saved = entity.kind === 'assessment' ? await assignAssessmentSequence(entity) : entity
    await db.learningRecords.add(saved); return saved as T
  })
}
export function appendAttempt(attempt: PracticeAttempt): Promise<PracticeAttempt> { return appendImmutable(attempt) }
export function appendAssessment(event: AssessmentEvent): Promise<AssessmentEvent> { return appendImmutable(event) }
export function saveSchedule(schedule: ReviewSchedule, expectedRevision: number | null): Promise<ReviewSchedule> { return saveEntity(schedule, expectedRevision) }

/** Append a complete submission once. Self-assessment revisions append separate events; no timestamp is invented for legacy imports. */
export async function recordArchivedQuizSubmission(archiveId: string, record: QuizPracticeRecord & { submittedAt?: number; submissionId?: string }, submissionId = record.submissionId ?? `legacy:${record.id}`): Promise<PracticeAttempt[]> {
  if (!record.submitted) return []
  const archive = await loadLearningArchive(archiveId); if (!archive) throw new LearningError('missing', '学习归档已经不存在。')
  const artifact = archive.artifacts.find((a) => a.id === record.artifactId && a.kind === 'quiz')
  if (!artifact || artifact.kind !== 'quiz' || archive.runId !== record.runId || archive.originDocId !== record.docId) conflict()
  if (record.artifactHash !== await artifactContentHash(artifact) || record.sourceFingerprint !== await sha256Hex(canonicalizeJson(archive.manifest.sources))
    || canonicalizeJson(record.questionIds) !== canonicalizeJson(artifact.payload.questions.map((q) => q.id))
    || Object.keys(record.answers).some((id) => !artifact.payload.questions.some((q) => q.id === id))) throw new LearningError('invalid', '当前练习与归档内容不一致。')
  const course = await requireCourse(archive.courseId); const timestamp = record.submittedAt ?? record.updatedAt
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: course.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
  const attempts: PracticeAttempt[] = []; const assessments: AssessmentEvent[] = []
  for (const q of artifact.payload.questions) {
    const answer = record.answers[q.id]; if (answer === undefined || typeof answer === 'string' && !answer.trim()) continue
    const attemptId = await sha256Hex(canonicalizeJson({ archiveId, submissionId, questionId: q.id }))
    const attempt: PracticeAttempt = { ...learningBase(archive.courseId, attemptId, timestamp), kind: 'attempt', question: { archiveId, artifactId: artifact.id, questionId: q.id, confirmed: false }, answer, submittedAt: record.submittedAt ?? null, learningDate: day, answerRevealed: false, origin: record.submittedAt === undefined ? 'legacy' : 'practice' }
    attempts.push(attempt)
    const checks = record.selfAssessments[q.id]; const completed = q.type !== 'short-answer' || !!checks
    if (checks && (q.type !== 'short-answer' || checks.length !== q.rubric.length || checks.some((v) => typeof v !== 'boolean'))) throw new LearningError('invalid', '简答自评与归档要点不一致。')
    if (!completed) continue
    const outcome = q.type === 'short-answer' ? (checks.every(Boolean) ? 'success' : checks.some(Boolean) ? 'partial' : 'failure') : (q.type === 'multiple-choice' ? answer === q.answerIndex : answer === q.answer) ? 'success' : 'failure'
    const eventId = await sha256Hex(canonicalizeJson({ attemptId, recordRevision: q.type === 'short-answer' ? record.revision : 0, outcome, checks: checks ?? [] }))
    assessments.push({ ...learningBase(archive.courseId, eventId, record.updatedAt), kind: 'assessment', attemptId, outcome, difficulty: outcome === 'success' ? 'good' : 'again', selfAssessmentComplete: completed, ...(checks ? { rubricChecks: checks } : {}) })
  }
  return db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    await requireCourse(archive.courseId); const current = await getEntity(archiveId, 'archive'); if (!current || current.contentHash !== archive.contentHash) conflict()
    const saved: PracticeAttempt[] = []
    for (const attempt of attempts) { if (await db.learningEntityTombstones.get(attempt.id)) continue; const existing = await db.learningRecords.get(attempt.id); if (existing && !(attempt.origin === 'legacy' && existing.kind === 'attempt' && canonicalizeJson(existing.answer) === canonicalizeJson(attempt.answer)) && !sameImmutable(existing, attempt)) conflict(); if (!existing) { await requireReferences(attempt); await db.learningRecords.add(parseLearningEntity(attempt)) } saved.push(existing as PracticeAttempt ?? attempt) }
    for (const event of assessments) if (!await db.learningEntityTombstones.get(event.id) && await db.learningRecords.get(event.attemptId) && !await db.learningRecords.get(event.id)) await db.learningRecords.add(await assignAssessmentSequence(parseLearningEntity(event) as AssessmentEvent))
    return saved
  })
}
export async function saveNodeBinding(input: { courseId: string; docId: string; archiveId: string; artifactId: string; mappings: { generatedNodeId: string; localNodeId: string; originalText: string; originalNote?: string; pointId?: string }[] }): Promise<NodeBinding> {
  if (!input.mappings.length || new Set(input.mappings.map((m) => m.generatedNodeId)).size !== input.mappings.length || new Set(input.mappings.map((m) => m.localNodeId)).size !== input.mappings.length) throw new LearningError('invalid', '生成节点与本地节点须有唯一明确映射。')
  const inside = async () => {
    await requireCourse(input.courseId); const archive = await getEntity(input.archiveId, 'archive'); const doc = await db.docs.get(input.docId)
    const artifact = archive?.artifacts.find((a) => a.id === input.artifactId && a.kind === 'mindmap')
    if (!archive || archive.courseId !== input.courseId || !doc || !artifact || artifact.kind !== 'mindmap') conflict()
    const nodes = (JSON.parse(doc.payload) as { nodes: Record<string, { text: string; note?: string; richNote?: unknown }> }).nodes; const points = await listEntities(input.courseId, 'point')
    const mappings = input.mappings.map((m) => {
      const node = artifact.payload.nodes.find((n) => n.id === m.generatedNodeId); const point = points.find((p) => p.archiveId === archive.id && p.generatedNodeId === m.generatedNodeId)
      if (!node || node.text !== m.originalText || node.note !== m.originalNote || nodes[m.localNodeId]?.text !== m.originalText || nodes[m.localNodeId]?.note !== m.originalNote || nodes[m.localNodeId]?.richNote !== undefined || !point || m.pointId && m.pointId !== point.id) conflict()
      return { generatedNodeId: m.generatedNodeId, localNodeId: m.localNodeId, originalText: m.originalText, pointId: point.id, ...(m.originalNote === undefined ? {} : { originalNote: m.originalNote }) }
    })
    const previous = (await listEntities(input.courseId, 'binding')).find((b) => b.docId === input.docId && b.archiveId === input.archiveId && b.artifactId === input.artifactId)
    if (previous) { if (canonicalizeJson(previous.mappings) !== canonicalizeJson(mappings)) conflict(); return previous }
    const binding: NodeBinding = { ...learningBase(input.courseId), kind: 'binding', docId: input.docId, archiveId: input.archiveId, artifactId: input.artifactId, mappings, status: 'active' }
    await db.learningRecords.add(parseLearningEntity(binding)); return binding
  }
  return Dexie.currentTransaction ? inside() : db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.docs], inside)
}
/** Graph mutations save all changed identities together and reject stale snapshots. */
export async function commitGraphChanges(courseId: string, result: { points: KnowledgePoint[]; relations: KnowledgeRelation[]; event?: KnowledgeMergeEvent }, expected: { points: Record<string, number>; relations: Record<string, number> }): Promise<void> {
  const records = [...result.points, ...result.relations, ...(result.event ? [result.event] : [])].map(parseLearningEntity)
  if (new Set(records.map((r) => r.id)).size !== records.length) throw new LearningError('invalid', '图变更含重复身份。')
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    await requireCourse(courseId)
    if (records.some((r) => r.courseId !== courseId)) throw new LearningError('invalid', '合并记录课程归属无效。')
    const beforePoints = await listEntities(courseId, 'point'); const beforeRelations = await listEntities(courseId, 'relation')
    const previousGoals = await goalScope(courseId)
    if (beforePoints.length !== Object.keys(expected.points).length || beforeRelations.length !== Object.keys(expected.relations).length) conflict()
    for (const [id, revision] of Object.entries({ ...expected.points, ...expected.relations })) if ((await db.learningRecords.get(id))?.revision !== revision) conflict()
    if (result.event && await db.learningRecords.get(result.event.id)) conflict()
    if (prerequisiteCycle(result.relations)) throw new LearningError('invalid', '前置关系形成循环，请调整关联。')
    const pointIds = new Set(result.points.map((p) => p.id)); if (beforePoints.some((p) => !pointIds.has(p.id))) throw new LearningError('invalid', '知识点须保留历史身份，不能通过图变更删除。')
    let originalMerge: KnowledgeMergeEvent | undefined
    if (result.event?.action === 'undo') { originalMerge = result.event.undoOf ? await getEntity(result.event.undoOf, 'merge') : undefined; if (!originalMerge || originalMerge.action !== 'merge') conflict() }
    for (const record of records) {
      const current = await db.learningRecords.get(record.id)
      if (current && (current.courseId !== courseId || current.kind !== record.kind)) conflict()
      if (current && (record.revision !== current.revision && record.revision !== current.revision + 1 || record.revision === current.revision && canonicalizeJson(current) !== canonicalizeJson(record))) conflict()
      if (!current && record.revision !== 1 && !(record.kind === 'relation' && originalMerge?.beforeRelations?.some((r) => r.id === record.id))) conflict()
      if (await db.learningEntityTombstones.get(record.id)) {
        if (record.kind !== 'relation' || !originalMerge?.beforeRelations?.some((r) => r.id === record.id)) conflict()
        await db.learningEntityTombstones.delete(record.id)
      }
    }
    const nextRelationIds = new Set(result.relations.map((r) => r.id))
    await eraseRows(beforeRelations.filter((r) => !nextRelationIds.has(r.id)))
    for (const record of records) await db.learningRecords.put(record)
    for (const record of records) await requireReferences(record)
    await recordGoalScopeChange(courseId, previousGoals)
  })
}

export interface LearningChange { entity: LearningEntity; expectedRevision: number | null }
export interface LearningDeletion { kind: LearningKind; id: string; expectedRevision: number }
/** Atomic history/assessment/schedule/draft writes. Duplicate immutable IDs replay only identical content. */
export async function saveLearningBatch(changes: LearningChange[], deletions: LearningDeletion[] = []): Promise<LearningEntity[]> {
  if (!changes.length || changes.length > 10_000 || new Set(changes.map((c) => c.entity.id)).size !== changes.length) throw new LearningError('invalid', '学习保存批次无效。')
  const parsed = changes.map((c) => ({ ...c, entity: parseLearningEntity(c.entity) }))
  return db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones, db.docs, db.documentTombstones], async () => {
    const previousGoals = new Map<string, string[]>()
    for (const { entity } of parsed) if (entity.kind === 'point' && !previousGoals.has(entity.courseId)) previousGoals.set(entity.courseId, await goalScope(entity.courseId))
    for (const { entity, expectedRevision } of parsed) {
      await requireCourse(entity.courseId); if (await db.learningEntityTombstones.get(entity.id)) conflict()
      const current = await db.learningRecords.get(entity.id)
      if (entity.kind === 'archive' || entity.kind === 'course' || entity.kind === 'document') throw new LearningError('invalid', '此批次不允许修改课程、文档归属或归档。')
      if (immutable.has(entity.kind) && current && sameImmutable(current, entity)) continue
      if ((current?.revision ?? null) !== expectedRevision || current && (current.courseId !== entity.courseId || current.kind !== entity.kind || immutable.has(entity.kind))) conflict()
    }
    const saved: LearningEntity[] = []
    for (const { entity } of parsed) {
      const current = await db.learningRecords.get(entity.id)
      if (immutable.has(entity.kind)) { if (entity.revision !== 1) throw new LearningError('invalid', '历史只能以初始版本追加。'); const row = current ?? (entity.kind === 'assessment' ? await assignAssessmentSequence(entity) : entity); saved.push(row); if (!current) await db.learningRecords.add(row) }
      else { const row = { ...entity, revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? entity.createdAt, updatedAt: Date.now() }; await db.learningRecords.put(row); saved.push(row) }
    }
    // All proposed identities exist before validating references, so parent/assessment order is irrelevant.
    for (const entity of saved) await requireReferences(entity)
    for (const deletion of deletions) await deleteDraftInside(deletion)
    for (const [courseId, before] of previousGoals) await recordGoalScopeChange(courseId, before)
    return saved
  })
}
async function deleteDraftInside(deletion: LearningDeletion): Promise<void> {
  if (deletion.kind !== 'draft') throw new LearningError('invalid', '此操作只删除作答草稿。')
  const current = await getEntity(deletion.id, 'draft'); if (!current || current.revision !== deletion.expectedRevision) conflict()
  await requireCourse(current.courseId); await db.learningEntityTombstones.put({ id: current.id, courseId: current.courseId, deletedAt: Date.now() }); await db.learningRecords.delete(current.id)
}
export async function deleteEntity(kind: LearningKind, id: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], () => deleteDraftInside({ kind, id, expectedRevision }))
}
export async function savePracticeBundle(attempt: PracticeAttempt, assessment?: AssessmentEvent, schedule?: ReviewSchedule, expectedScheduleRevision: number | null = null, draftDeletion?: LearningDeletion): Promise<LearningEntity[]> {
  return saveLearningBatch([{ entity: attempt, expectedRevision: null }, ...(assessment ? [{ entity: assessment, expectedRevision: null }] : []), ...(schedule ? [{ entity: schedule, expectedRevision: expectedScheduleRevision }] : [])], draftDeletion ? [draftDeletion] : [])
}
async function eraseRows(rows: LearningEntity[]): Promise<void> {
  for (const row of rows) { await db.learningEntityTombstones.put({ id: row.id, courseId: row.courseId, deletedAt: Date.now() }); await db.learningRecords.delete(row.id) }
}
export async function deletePracticeHistory(courseId: string, expectedCourseRevision: number): Promise<void> {
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    const course = await requireCourse(courseId); if (course.revision !== expectedCourseRevision) conflict()
    const attempts = await listEntities(courseId, 'attempt'); const attemptIds = new Set(attempts.map((a) => a.id))
    await eraseRows([...attempts, ...(await listEntities(courseId, 'assessment'))])
    for (const support of await listEntities(courseId, 'support')) if (support.attemptId && attemptIds.has(support.attemptId)) {
      const changed = { ...support, status: 'rejected' as const, revision: support.revision + 1, updatedAt: Date.now() }; delete changed.attemptId; delete changed.learnerAnswer; await db.learningRecords.put(changed)
    }
    for (const draft of await listEntities(courseId, 'draft')) if (attemptIds.has(draft.attemptId)) await db.learningRecords.put({ ...draft, attemptId: newLearningId(), revision: draft.revision + 1, updatedAt: Date.now() })
    for (const session of await listEntities(courseId, 'session')) if (session.purpose === 'exam') await db.learningRecords.put({ ...session, status: 'ended', endedAt: Date.now(), revision: session.revision + 1, updatedAt: Date.now() })
    for (const row of await listEntities(courseId, 'schedule')) {
      const paused = { ...row, status: 'paused' as const, stage: 0, successfulLearningDates: [], revision: row.revision + 1, updatedAt: Date.now(), suspendedReason: '作答历史已清除，请重新安排' }
      delete paused.lastAttemptId; delete paused.lastLearningDate; await db.learningRecords.put(paused)
    }
    await db.learningRecords.put({ ...course, revision: course.revision + 1, updatedAt: Date.now() })
  })
}
export async function deleteLearningArchive(courseId: string, archiveId: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    await requireCourse(courseId); const archive = await getEntity(archiveId, 'archive'); if (!archive || archive.courseId !== courseId || archive.revision !== expectedRevision) conflict()
    const previousGoals = await goalScope(courseId)
    const rows = (await db.learningRecords.where('courseId').equals(courseId).toArray()).map(parseLearningEntity)
    const attempts = rows.filter((r) => r.kind === 'attempt' && r.question.archiveId === archiveId); const attemptIds = new Set(attempts.map((a) => a.id))
    await eraseRows(rows.filter((r) => r.id === archiveId || r.kind === 'attempt' && attemptIds.has(r.id) || r.kind === 'assessment' && (attemptIds.has(r.attemptId) || r.feedbackArchiveId === archiveId) || 'question' in r && r.question.archiveId === archiveId || r.kind === 'binding' && r.archiveId === archiveId || r.kind === 'support' && (r.generatedArchiveId === archiveId || r.sourceRefs.some((ref) => ref.archiveId === archiveId) || r.questionRef?.archiveId === archiveId || r.attemptId && attemptIds.has(r.attemptId))))
    for (const row of rows) if (row.kind === 'point') {
      const sourceRefs = row.sourceRefs.filter((r) => r.archiveId !== archiveId); const questionRefs = row.questionRefs.filter((r) => r.archiveId !== archiveId)
      if (sourceRefs.length !== row.sourceRefs.length || questionRefs.length !== row.questionRefs.length || row.archiveId === archiveId) {
        const removedKeys = new Set(row.questionRefs.filter((ref) => ref.archiveId === archiveId).map(questionRefKey))
        const changed = { ...row, sourceRefs, questionRefs, ...(row.questionLevels ? { questionLevels: Object.fromEntries(Object.entries(row.questionLevels).filter(([key]) => !removedKeys.has(key))) } : {}), revision: row.revision + 1, updatedAt: Date.now(), ...(row.archiveId === archiveId ? { status: 'retired' as const, title: '已删除学习资料', definition: '', aliases: [], questionLevels: {} } : {}) }
        if (row.archiveId === archiveId) { delete changed.archiveId; delete changed.generatedNodeId }
        await db.learningRecords.put(changed)
      }
    }
    for (const row of rows) if (row.kind === 'relation' && row.sourceRefs?.some((r) => r.archiveId === archiveId)) {
      await db.learningRecords.put({ ...row, sourceRefs: row.sourceRefs.filter((r) => r.archiveId !== archiveId), revision: row.revision + 1, updatedAt: Date.now() })
    }
    for (const row of rows) if (row.kind === 'session' && row.questions?.some((q) => q.archiveId === archiveId)) {
      const questions = row.questions.filter((q) => q.archiveId !== archiveId)
      if (!questions.length) await eraseRows([row])
      else await db.learningRecords.put({ ...row, questions, status: 'ended', endedAt: Date.now(), revision: row.revision + 1, updatedAt: Date.now() })
    }
    for (const row of rows) if (row.kind === 'merge' && (row.beforePoints?.some((p) => p.archiveId === archiveId || p.sourceRefs.some((r) => r.archiveId === archiveId) || p.questionRefs.some((r) => r.archiveId === archiveId)) || row.beforeRelations?.some((r) => r.sourceRefs?.some((ref) => ref.archiveId === archiveId)))) {
      const scrubbed = { ...row, undoDisabledReason: '相关学习资料已删除；保留概念身份对应，删除前的内容快照已清除。' }
      delete scrubbed.beforePoints; delete scrubbed.beforeRelations; delete scrubbed.afterPointRevisions; delete scrubbed.afterRelationRevisions
      await db.learningRecords.put(scrubbed)
    }
    await recordGoalScopeChange(courseId, previousGoals)
  })
}
