import { artifactEnvelopeSchema, canonicalizeJson, identifierSchema, sourceKindSchema, sourceManifestSchema, validateArtifactAgainstManifest } from '@cat-thinking/analysis-contracts'
import { createSourceSnapshot, sha256Hex } from '../analysis/fingerprint'
import type { SourceDocument } from '../types'
import { LearningError, type ArchivedSourceRef, type LearningArchive, type LearningEntity, type QuestionRef } from './model'

const baseKeys = ['originId', 'version', 'id', 'courseId', 'revision', 'createdAt', 'updatedAt', 'kind']
const fields: Record<LearningEntity['kind'], string[]> = {
  journey: ['mode', 'title', 'status', 'step', 'note', 'position', 'scroll', 'dueDate', 'finishedAt', 'source', 'questionRef', 'archiveHash', 'attemptId', 'retryAttemptId', 'parentSessionId', 'originSessionId', 'blockedReason', 'planning'],
  course: ['firstStudyAt', 'name', 'goal', 'timeZone', 'dailyMinutes', 'dailyQuestionLimit', 'examDate', 'goalVersion', 'automaticReviews', 'goals', 'example'],
  document: ['docId', 'chapter', 'role'], point: ['title', 'definition', 'chapter', 'parentId', 'aliases', 'notes', 'sourceRefs', 'questionRefs', 'status', 'docId', 'nodeId', 'questionLevels', 'goalIncluded', 'archiveId', 'generatedNodeId'],
  archive: ['originDocId', 'provenanceDocId', 'runId', 'title', 'manifest', 'sources', 'artifacts', 'contentHash'],
  attempt: ['question', 'answer', 'submittedAt', 'learningDate', 'answerRevealed', 'origin', 'confidence', 'sessionId', 'assistance', 'recallText'],
  draft: ['question', 'answer', 'answerRevealed', 'attemptId', 'assistance', 'recallText'],
  assessment: ['attemptId', 'outcome', 'difficulty', 'selfAssessmentComplete', 'reason', 'rubricChecks', 'sequence', 'feedbackArchiveId', 'origin'],
  schedule: ['question', 'status', 'dueDate', 'stage', 'lastLearningDate', 'lastAttemptId', 'manual', 'ruleVersion', 'successfulLearningDates', 'suspendedReason'],
  relation: ['fromPointId', 'toPointId', 'type', 'confirmed', 'sourceRefs'],
  merge: ['fromPointId', 'toPointId', 'action', 'undoOf', 'beforePoints', 'beforeRelations', 'afterPointRevisions', 'afterRelationRevisions', 'undoDisabledReason'],
  session: ['title', 'pointIds', 'status', 'steps', 'endedAt', 'purpose', 'questions', 'checkpoint', 'examConfig', 'planning'],
  application: ['pointIds', 'title', 'prompt', 'response', 'rubric', 'checks', 'status', 'learningDate'],
  issue: ['question', 'reason', 'note', 'status'], binding: ['docId', 'archiveId', 'artifactId', 'mappings', 'status'],
  support: ['mode', 'docId', 'pointIds', 'sourceRefs', 'prompt', 'learnerAnswer', 'hintLevel', 'quizType', 'difficulty', 'status', 'generatedArchiveId', 'questionRef', 'attemptId', 'sessionId', 'viewedAt'],
}
function invalid(): never { throw new LearningError('invalid', '学习数据结构、版本或范围无效。') }
export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
function strictObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(v) || Object.keys(v).some((k) => !keys.includes(k))) invalid()
  return v as Record<string, unknown>
}
function text(v: unknown, max = 20_000): asserts v is string { if (typeof v !== 'string' || v.length > max) invalid() }
function id(v: unknown): asserts v is string { if (!identifierSchema.safeParse(v).success) invalid() }
function number(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) invalid() }
function bool(v: unknown): asserts v is boolean { if (typeof v !== 'boolean') invalid() }
function one(v: unknown, options: readonly string[]): void { if (typeof v !== 'string' || !options.includes(v)) invalid() }
function array(v: unknown, max: number): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > max) invalid()
  for (let index = 0; index < v.length; index++) if (!Object.hasOwn(v, index)) invalid()
}
export function validLearningDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
}
function date(v: unknown): void { if (!validLearningDate(v)) invalid() }
export function parseQuestionRef(v: unknown): QuestionRef {
  const r = strictObject(v, ['archiveId', 'artifactId', 'questionId', 'confirmed'])
  id(r.archiveId); id(r.artifactId); id(r.questionId); bool(r.confirmed)
  return structuredClone(r) as unknown as QuestionRef
}
export function parseArchivedSourceRef(v: unknown): ArchivedSourceRef {
  const r = strictObject(v, ['archiveId', 'sourceId', 'start', 'end'])
  id(r.archiveId); id(r.sourceId); number(r.start); number(r.end, 1); if ((r.end as number) <= (r.start as number)) invalid()
  return structuredClone(r) as unknown as ArchivedSourceRef
}
export function parseSourceDocument(v: unknown): SourceDocument {
  const r = strictObject(v, ['version', 'id', 'docId', 'name', 'kind', 'mime', 'size', 'lastModified', 'importedAt', 'extractor', 'text', 'contentHash', 'charCount', 'anchors', 'locators'])
  if (r.version !== 1) invalid(); id(r.id); id(r.docId); text(r.name, 500); if (!sourceKindSchema.safeParse(r.kind).success) invalid(); text(r.mime, 200); text(r.extractor, 100)
  number(r.size, 0, 64 * 1024 * 1024); number(r.lastModified); number(r.importedAt); text(r.text, 8_000_000); number(r.charCount)
  if (r.charCount !== (r.text as string).length || r.contentHash !== undefined && (typeof r.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.contentHash))) invalid()
  array(r.anchors, 100_000)
  for (const raw of r.anchors) {
    const a = strictObject(raw, ['nodeId', 'start', 'end', 'locator', 'page']); id(a.nodeId); number(a.start); number(a.end, 1, r.charCount as number)
    if ((a.end as number) <= (a.start as number)) invalid(); if (a.locator !== undefined) text(a.locator, 2000); if (a.page !== undefined) number(a.page, 1, 100_000)
  }
  if (r.locators !== undefined) { array(r.locators, 100_000); for (const raw of r.locators) {
    const a = strictObject(raw, ['start', 'end', 'titlePath', 'page']); number(a.start); number(a.end, 1, r.charCount as number); if ((a.end as number) <= (a.start as number)) invalid()
    array(a.titlePath, 50); a.titlePath.forEach((t) => text(t, 500)); if (a.page !== undefined) number(a.page, 1, 100_000)
  } }
  return JSON.parse(JSON.stringify(r)) as SourceDocument
}

/** Strict discriminator/field whitelist with bounds; crypto identity is validated separately. */
export function parseLearningEntity(v: unknown): LearningEntity {
  if (!isRecord(v) || typeof v.kind !== 'string' || !Object.hasOwn(fields, v.kind)) invalid()
  const kind = v.kind as LearningEntity['kind']; const r = strictObject(v, [...baseKeys, ...fields[kind]])
  if (r.version !== 1) invalid(); id(r.id); if (r.originId !== undefined) id(r.originId); id(r.courseId); number(r.revision, 1); number(r.createdAt); number(r.updatedAt)
  switch (kind) {
    case 'journey': {
      one(r.mode, ['reading', 'remediation']); text(r.title, 500); if (!(r.title as string).trim()) invalid()
      one(r.status, ['active', 'paused', 'completed']); number(r.step, 0, 3); text(r.note, 10000); number(r.position, 0, 8_000_000); number(r.scroll, 0, 10_000_000)
      if (r.dueDate !== undefined) date(r.dueDate); if (r.finishedAt !== undefined) number(r.finishedAt)
      if (r.source !== undefined) { const s = strictObject(r.source, ['docId', 'sourceId', 'sourceHash']); id(s.docId); id(s.sourceId); if (typeof s.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(s.sourceHash)) invalid() }
      if (r.questionRef !== undefined) parseQuestionRef(r.questionRef)
      for (const key of ['attemptId', 'retryAttemptId', 'parentSessionId', 'originSessionId']) if (r[key] !== undefined) id(r[key])
      if (r.archiveHash !== undefined && (typeof r.archiveHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.archiveHash))) invalid()
      if (r.blockedReason !== undefined) text(r.blockedReason, 2000)
      if (r.mode === 'remediation' && (!r.questionRef || !r.attemptId || !r.archiveHash) || r.mode === 'reading' && (r.questionRef || r.attemptId || r.retryAttemptId)) invalid()
      if (r.planning !== undefined) { const p = strictObject(r.planning, ['date', 'minutes']); date(p.date); number(p.minutes, 0, 1440) }
      break
    }
    case 'course':
      if (r.firstStudyAt !== undefined) number(r.firstStudyAt)
      if (r.id !== r.courseId) invalid(); text(r.name, 200); if (!(r.name as string).trim()) invalid(); text(r.goal); text(r.timeZone, 100)
      try { new Intl.DateTimeFormat('en', { timeZone: r.timeZone as string }).format() } catch { invalid() }
      number(r.dailyMinutes, 1, 1440); number(r.dailyQuestionLimit, 1, 1000); number(r.goalVersion, 1); if (r.examDate !== undefined) date(r.examDate); if (r.automaticReviews !== undefined) bool(r.automaticReviews)
      if (r.example !== undefined) bool(r.example)
      if (r.goals !== undefined) {
        array(r.goals, 1000); const ids = new Set<string>()
        for (const raw of r.goals) { const g = strictObject(raw, ['id', 'title', 'level', 'priority', 'pointIds', 'confirmed']); id(g.id); text(g.title, 500); if (!(g.title as string).trim() || ids.has(g.id as string)) invalid(); ids.add(g.id as string); one(g.level, ['recall', 'explanation', 'application']); one(g.priority, ['normal', 'important', 'required']); array(g.pointIds, 1000); g.pointIds.forEach(id); if (new Set(g.pointIds).size !== g.pointIds.length) invalid(); bool(g.confirmed) }
      }
      break
    case 'document': id(r.docId); text(r.chapter, 500); if (r.role !== undefined) one(r.role, ['syllabus', 'slides', 'textbook', 'notes']); break
    case 'point':
      text(r.title, 500); text(r.definition); text(r.chapter, 500); text(r.notes); array(r.aliases, 100); r.aliases.forEach((x) => text(x, 500))
      array(r.sourceRefs, 200); r.sourceRefs.forEach(parseArchivedSourceRef); array(r.questionRefs, 500); r.questionRefs.forEach(parseQuestionRef); one(r.status, ['active', 'pending', 'retired'])
      if (!(r.title as string).trim() || new Set(r.questionRefs.map((q) => { const reference = q as QuestionRef; return canonicalizeJson([reference.archiveId, reference.artifactId, reference.questionId]) })).size !== r.questionRefs.length) invalid()
      for (const key of ['parentId', 'docId', 'nodeId', 'archiveId', 'generatedNodeId']) if (r[key] !== undefined) id(r[key])
      if (r.goalIncluded !== undefined) bool(r.goalIncluded)
      if (r.questionLevels !== undefined) {
        if (!isRecord(r.questionLevels) || Object.keys(r.questionLevels).length > 500) invalid()
        const references = new Set((r.questionRefs as QuestionRef[]).map((ref) => JSON.stringify([ref.archiveId, ref.artifactId, ref.questionId])))
        for (const [key, value] of Object.entries(r.questionLevels)) { if (!references.has(key)) id(key); one(value, ['recall', 'explanation', 'application']) }
      }
      break
    case 'archive':
      id(r.originDocId); id(r.provenanceDocId); id(r.runId); text(r.title, 500); if (typeof r.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.contentHash)) invalid()
      sourceManifestSchema.parse(r.manifest); array(r.sources, 100); r.sources.forEach(parseSourceDocument); array(r.artifacts, 5); r.artifacts.forEach((a) => artifactEnvelopeSchema.parse(a))
      if (!(r.artifacts as unknown[]).length) invalid(); break
    case 'attempt':
      parseQuestionRef(r.question); if (typeof r.answer === 'string') text(r.answer, 10_000); else if (typeof r.answer === 'number') number(r.answer, 0, 1000); else if (typeof r.answer !== 'boolean') { array(r.answer, 100); r.answer.forEach((x) => text(x, 10_000)) }
      if (r.submittedAt !== null) number(r.submittedAt); date(r.learningDate); bool(r.answerRevealed); one(r.origin, ['practice', 'legacy']); if (r.confidence !== undefined) number(r.confidence, 0, 100); if (r.sessionId !== undefined) id(r.sessionId); break
    case 'draft':
      parseQuestionRef(r.question); if (typeof r.answer === 'string') text(r.answer, 10_000); else if (typeof r.answer === 'number') number(r.answer, 0, 1000); else if (r.answer !== null) bool(r.answer)
      bool(r.answerRevealed); id(r.attemptId); break
    case 'assessment':
      if (r.feedbackArchiveId !== undefined) id(r.feedbackArchiveId); if (r.origin !== undefined) one(r.origin, ['self', 'ai-review'])
      id(r.attemptId); one(r.outcome, ['success', 'partial', 'failure', 'disputed', 'skipped']); one(r.difficulty, ['again', 'hard', 'good', 'easy']); bool(r.selfAssessmentComplete); if (r.reason !== undefined) text(r.reason, 2000); if (r.rubricChecks !== undefined) { array(r.rubricChecks, 100); r.rubricChecks.forEach(bool) } if (r.sequence !== undefined) number(r.sequence, 1); break
    case 'schedule':
      parseQuestionRef(r.question); one(r.status, ['active', 'paused', 'remediation']); date(r.dueDate); number(r.stage, 0, 4); bool(r.manual); text(r.ruleVersion, 100)
      if (r.lastLearningDate !== undefined) date(r.lastLearningDate); if (r.lastAttemptId !== undefined) id(r.lastAttemptId); if (r.successfulLearningDates !== undefined) { array(r.successfulLearningDates, 1000); r.successfulLearningDates.forEach(date) }
      if (r.suspendedReason !== undefined) text(r.suspendedReason, 2000); break
    case 'relation':
      id(r.fromPointId); id(r.toPointId); if (r.fromPointId === r.toPointId) invalid(); one(r.type, ['prerequisite', 'part', 'step', 'comparison', 'cause', 'application']); bool(r.confirmed); if (r.sourceRefs !== undefined) { array(r.sourceRefs, 100); r.sourceRefs.forEach(parseArchivedSourceRef) } break
    case 'merge':
      id(r.fromPointId); id(r.toPointId); if (r.fromPointId === r.toPointId) invalid(); one(r.action, ['merge', 'undo']); if (r.undoOf !== undefined) id(r.undoOf)
      if (r.undoDisabledReason !== undefined) text(r.undoDisabledReason, 2000)
      for (const key of ['beforePoints', 'beforeRelations']) if (r[key] !== undefined) { array(r[key], 10_000); (r[key] as unknown[]).forEach((x) => { if (!isRecord(x) || x.kind !== (key === 'beforePoints' ? 'point' : 'relation')) invalid(); parseLearningEntity(x) }) }
      for (const key of ['afterPointRevisions', 'afterRelationRevisions']) if (r[key] !== undefined) { if (!isRecord(r[key])) invalid(); for (const [name, value] of Object.entries(r[key] as Record<string, unknown>)) { id(name); if (key === 'afterRelationRevisions' && value === -1) continue; number(value, 1) } }
      if (['beforePoints', 'beforeRelations', 'afterPointRevisions', 'afterRelationRevisions'].some((key) => r[key] !== undefined)) {
        if (!Array.isArray(r.beforePoints) || !Array.isArray(r.beforeRelations) || !isRecord(r.afterPointRevisions) || !isRecord(r.afterRelationRevisions) || r.action !== 'merge' || r.undoDisabledReason !== undefined) invalid()
        const points = r.beforePoints.map(parseLearningEntity); const relations = r.beforeRelations.map(parseLearningEntity)
        if (points.length !== 2 || new Set(points.map((p) => p.id)).size !== 2 || points.some((p) => p.courseId !== r.courseId || ![r.fromPointId, r.toPointId].includes(p.id))
          || Object.keys(r.afterPointRevisions).length !== 2 || points.some((p) => !Object.hasOwn(r.afterPointRevisions as object, p.id))
          || relations.some((p) => p.courseId !== r.courseId) || new Set(relations.map((p) => p.id)).size !== relations.length
          || Object.keys(r.afterRelationRevisions).length !== relations.length || relations.some((p) => !Object.hasOwn(r.afterRelationRevisions as object, p.id))) invalid()
      }
      break
    case 'session':
      text(r.title, 500); array(r.pointIds, 1000); r.pointIds.forEach(id); one(r.status, ['active', 'completed', 'ended']); if (r.endedAt !== undefined) number(r.endedAt); array(r.steps, 5000)
      for (const raw of r.steps) { const s = strictObject(raw, ['pointId', 'action', 'status', 'note']); id(s.pointId); if (!r.pointIds.includes(s.pointId)) invalid(); one(s.action, ['read', 'recall', 'practice', 'source', 'explain']); one(s.status, ['pending', 'completed', 'skipped']); text(s.note) }
      if (r.purpose !== undefined) one(r.purpose, ['guided', 'exam'])
      if (r.questions !== undefined) {
        array(r.questions, 1000); r.questions.forEach(parseQuestionRef)
        if (!r.questions.length || new Set(r.questions.map((q) => { const ref = q as QuestionRef; return canonicalizeJson([ref.archiveId, ref.artifactId, ref.questionId]) })).size !== r.questions.length) invalid()
      }
      if (r.purpose === 'exam' && r.questions === undefined || r.purpose !== 'exam' && r.questions !== undefined) invalid()
      if (r.examConfig !== undefined) { if (r.purpose !== 'exam') invalid(); const c = strictObject(r.examConfig, ['durationMinutes', 'mode']); number(c.durationMinutes, 1, 180); one(c.mode, ['simulation', 'guided']) }
      if (r.planning !== undefined) { const p = strictObject(r.planning, ['date', 'minutes']); date(p.date); number(p.minutes, 0, 1440) }
      if (r.checkpoint !== undefined) {
        const c = strictObject(r.checkpoint, ['stepIndex', 'paused', 'hidden', 'goalVersion', 'pointRevisions', 'archiveHashes', 'questionKey', 'position', 'endedReason'])
        number(c.stepIndex, 0, Math.max(0, r.steps.length - 1)); bool(c.paused); bool(c.hidden); number(c.goalVersion, 1)
        if (!isRecord(c.pointRevisions) || Object.keys(c.pointRevisions).length > 1000 || !isRecord(c.archiveHashes) || Object.keys(c.archiveHashes).length > 1000) invalid()
        for (const [key, value] of Object.entries(c.pointRevisions)) { id(key); if (!r.pointIds.includes(key)) invalid(); number(value, 1) }
        for (const [key, value] of Object.entries(c.archiveHashes)) { id(key); if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid() }
        if (c.questionKey !== undefined) text(c.questionKey, 1000); if (c.position !== undefined) number(c.position, 0, 10_000_000); if (c.endedReason !== undefined) one(c.endedReason, ['completed', 'user'])
      }
      break
    case 'application':
      array(r.pointIds, 1000); r.pointIds.forEach(id); text(r.title, 500); text(r.prompt); text(r.response); array(r.rubric, 100); r.rubric.forEach((x) => text(x, 2000)); array(r.checks, 100); r.checks.forEach(bool)
      if (!r.rubric.length || r.rubric.some((x) => !(x as string).trim()) || r.rubric.length !== r.checks.length) invalid()
      one(r.status, ['pending', 'completed', 'skipped']); if (r.status === 'completed' && (!(r.response as string).trim() || !r.checks.every(Boolean))) invalid()
      if (r.learningDate !== undefined) date(r.learningDate); break
    case 'issue': parseQuestionRef(r.question); one(r.reason, ['answer', 'ambiguous', 'outside-source']); text(r.note); one(r.status, ['open', 'resolved']); break
    case 'support':
      one(r.mode, ['explain', 'compare', 'hint', 'feedback', 'goals', 'variation', 'supplement']); id(r.docId); text(r.prompt, 3000); if (!(r.prompt as string).trim()) invalid()
      array(r.pointIds, 1000); r.pointIds.forEach(id); array(r.sourceRefs, 100); r.sourceRefs.forEach(parseArchivedSourceRef); if (!r.sourceRefs.length) invalid()
      one(r.status, ['prepared', 'viewed', 'accepted', 'rejected']); if (r.learnerAnswer !== undefined) text(r.learnerAnswer, 10000); if (r.hintLevel !== undefined) number(r.hintLevel, 1, 3)
      for (const key of ['generatedArchiveId', 'attemptId', 'sessionId']) if (r[key] !== undefined) id(r[key]); if (r.questionRef !== undefined) parseQuestionRef(r.questionRef)
      if (r.quizType !== undefined) one(r.quizType, ['mixed', 'multiple-choice', 'true-false', 'short-answer']); if (r.difficulty !== undefined) one(r.difficulty, ['easy', 'medium', 'hard']); if (r.viewedAt !== undefined) number(r.viewedAt)
      break
    case 'binding':
      id(r.docId); id(r.archiveId); id(r.artifactId); one(r.status, ['active', 'pending', 'retired']); array(r.mappings, 100_000)
      for (const raw of r.mappings) { const m = strictObject(raw, ['generatedNodeId', 'localNodeId', 'pointId', 'originalText', 'originalNote']); id(m.generatedNodeId); id(m.localNodeId); id(m.pointId); text(m.originalText, 500); if (m.originalNote !== undefined) text(m.originalNote) } break
  }
  if ((kind === 'attempt' || kind === 'draft') && r.assistance !== undefined) {
    const a = strictObject(r.assistance, ['hints', 'fullExplanation', 'sourceViewed', 'recorded']); number(a.hints, 0, 1000); bool(a.fullExplanation); bool(a.sourceViewed); bool(a.recorded)
  }
  if ((kind === 'attempt' || kind === 'draft') && r.recallText !== undefined) text(r.recallText, 10000)
  return JSON.parse(JSON.stringify(r)) as LearningEntity
}

export function archiveHashPayload(archive: LearningArchive): unknown {
  return { version: 1, provenanceDocId: archive.provenanceDocId, runId: archive.runId, manifest: archive.manifest, sources: archive.sources, artifacts: archive.artifacts }
}
export async function validateLearningArchive(input: unknown): Promise<LearningArchive> {
  const entity = parseLearningEntity(input); if (entity.kind !== 'archive') invalid(); const archive = entity as LearningArchive
  if (new Set(archive.sources.map((s) => s.id)).size !== archive.sources.length || new Set(archive.artifacts.map((a) => a.kind)).size !== archive.artifacts.length) invalid()
  for (const snapshot of archive.manifest.sources) {
    const source = archive.sources.find((s) => s.id === snapshot.sourceId)
    if (!source || source.docId !== archive.provenanceDocId || canonicalizeJson(await createSourceSnapshot(source, snapshot.selectedRange)) !== canonicalizeJson(snapshot)) invalid()
    if (source.contentHash !== undefined && await sha256Hex(source.text) !== source.contentHash) invalid()
  }
  if (archive.sources.length !== archive.manifest.sources.length) invalid()
  for (const artifact of archive.artifacts) if (artifact.docId !== archive.provenanceDocId || artifact.runId !== archive.runId || validateArtifactAgainstManifest(artifact, archive.manifest).length
    || canonicalizeJson([...artifact.sourceContentHashes].sort()) !== canonicalizeJson(archive.manifest.sources.map((s) => s.contentHash).sort())) invalid()
  if (await sha256Hex(canonicalizeJson(archiveHashPayload(archive))) !== archive.contentHash) throw new LearningError('corrupt', '学习归档校验失败，原文或产物已经改变。')
  return archive
}
