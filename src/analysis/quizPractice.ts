import { canonicalizeJson, identifierSchema, quizArtifactEnvelopeSchema, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { db } from '../store/db'
import { sha256Hex } from './fingerprint'
import { LocalArtifactError, prepareArtifactIdentity, verifyPreparedArtifactIdentity } from './localArtifactIdentity'
import { findArchiveForArtifact, listEntities, recordArchivedQuizSubmission } from '../learning/repository'
import type { LearningArchive } from '../learning/model'

export type QuizEnvelope = Extract<ArtifactEnvelopeV1, { kind: 'quiz' }>
export type QuizAnswers = Record<string, number | boolean | string>
/** One explicit self-assessment checkbox per rubric line; never automatic correctness. */
export type QuizSelfAssessments = Record<string, boolean[]>
export interface QuizPracticeState {
  answers: QuizAnswers
  submitted: boolean
  selfAssessments: QuizSelfAssessments
  /** Absent on legacy records: unknown historical submission time is never invented. */
  submissionId?: string
  submittedAt?: number
}
export interface QuizPracticeRecord extends QuizPracticeState {
  version: 1
  id: string
  docId: string
  runId: string
  artifactId: string
  artifactHash: string
  sourceFingerprint: string
  questionIds: string[]
  revision: number
  updatedAt: number
}
export interface QuizPracticeContext { docId: string; runId: string; artifact: QuizEnvelope }
export interface QuizScore {
  objectiveTotal: number
  objectiveCorrect: number
  objectiveUnanswered: number
  shortAnswerTotal: number
  shortAnswerAnswered: number
  selfAssessed: number
}

const allowedKeys = new Set(['version', 'id', 'docId', 'runId', 'artifactId', 'artifactHash', 'sourceFingerprint', 'questionIds', 'revision', 'updatedAt', 'answers', 'submitted', 'selfAssessments', 'submissionId', 'submittedAt'])
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Reject implicit number/boolean conversions, unknown questions and unbounded local input. */
export function validateQuizState(artifact: QuizEnvelope, value: QuizPracticeState): QuizPracticeState {
  if (!isObject(value) || !['answers', 'submitted', 'selfAssessments'].every((key) => Object.hasOwn(value, key))
    || !isObject(value.answers) || !isObject(value.selfAssessments) || typeof value.submitted !== 'boolean') {
    throw new LocalArtifactError('invalid', '练习数据格式无效。')
  }
  const questions = new Map(artifact.payload.questions.map((question) => [question.id, question]))
  if ((value.submissionId !== undefined || value.submittedAt !== undefined)
    && (!value.submitted || !identifierSchema.safeParse(value.submissionId).success
      || typeof value.submittedAt !== 'number' || !Number.isInteger(value.submittedAt) || value.submittedAt < 0)) {
    throw new LocalArtifactError('invalid', '练习提交身份或时间无效。')
  }
  const answers: QuizAnswers = Object.create(null) as QuizAnswers
  for (const [id, answer] of Object.entries(value.answers)) {
    const question = questions.get(id)
    if (!question || question.type === 'multiple-choice' && (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= question.options.length)
      || question.type === 'true-false' && typeof answer !== 'boolean'
      || question.type === 'short-answer' && (typeof answer !== 'string' || answer.length > 10_000)) {
      throw new LocalArtifactError('invalid', '题目答案类型、选项或长度无效。')
    }
    answers[id] = answer
  }
  const selfAssessments: QuizSelfAssessments = Object.create(null) as QuizSelfAssessments
  for (const [id, assessment] of Object.entries(value.selfAssessments)) {
    const question = questions.get(id)
    if (!question || question.type !== 'short-answer' || !Array.isArray(assessment)
      || assessment.length !== question.rubric.length
      || Array.from(assessment).some((entry, index) => !Object.hasOwn(assessment, index) || typeof entry !== 'boolean') || !value.submitted) {
      throw new LocalArtifactError('invalid', '简答自评格式无效，请先提交练习。')
    }
    selfAssessments[id] = [...assessment]
  }
  return { answers, submitted: value.submitted, selfAssessments,
    ...(value.submissionId === undefined ? {} : { submissionId: value.submissionId, submittedAt: value.submittedAt }) }
}

export function scoreQuiz(artifactInput: QuizEnvelope, answers: QuizAnswers, selfAssessments: QuizSelfAssessments = {}): QuizScore {
  const artifact = quizArtifactEnvelopeSchema.parse(artifactInput)
  const validated = validateQuizState(artifact, { answers, submitted: true, selfAssessments })
  const score: QuizScore = { objectiveTotal: 0, objectiveCorrect: 0, objectiveUnanswered: 0, shortAnswerTotal: 0, shortAnswerAnswered: 0, selfAssessed: 0 }
  for (const question of artifact.payload.questions) {
    const answer = validated.answers[question.id]
    if (question.type === 'short-answer') {
      score.shortAnswerTotal++
      if (typeof answer === 'string' && answer.trim()) score.shortAnswerAnswered++
      if (validated.selfAssessments[question.id]) score.selfAssessed++
      continue
    }
    score.objectiveTotal++
    if (answer === undefined) score.objectiveUnanswered++
    else if (question.type === 'multiple-choice' ? answer === question.answerIndex : answer === question.answer) score.objectiveCorrect++
  }
  return score
}

export function parseQuizPracticeRecord(value: unknown, artifact: QuizEnvelope): QuizPracticeRecord {
  if (!isObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.version !== 1 || ['id', 'docId', 'runId', 'artifactId'].some((key) => !identifierSchema.safeParse(value[key]).success)
    || typeof value.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifactHash)
    || typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    || typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
    || !Array.isArray(value.questionIds) || value.questionIds.length > 100
    || canonicalizeJson(value.questionIds) !== canonicalizeJson(artifact.payload.questions.map((question) => question.id))) {
    throw new LocalArtifactError('corrupt', '本地练习记录损坏，清理后可重新作答。')
  }
  let state: QuizPracticeState
  try { state = validateQuizState(artifact, value as unknown as QuizPracticeState) }
  catch { throw new LocalArtifactError('corrupt', '本地练习答案损坏，清理后可重新作答。') }
  return { version: 1, id: value.id as string, docId: value.docId as string, runId: value.runId as string, artifactId: value.artifactId as string,
    artifactHash: value.artifactHash, sourceFingerprint: value.sourceFingerprint, questionIds: [...value.questionIds] as string[],
    revision: value.revision, updatedAt: value.updatedAt, ...state }
}

async function preparePractice(context: QuizPracticeContext) {
  const artifact = quizArtifactEnvelopeSchema.parse(context.artifact)
  const prepared = await prepareArtifactIdentity({ ...context, artifact })
  const id = await sha256Hex(canonicalizeJson({ docId: context.docId, runId: context.runId, artifactId: artifact.id }))
  const sourceFingerprint = await sha256Hex(canonicalizeJson(prepared.task.request.manifest.sources))
  return { prepared, artifact, id, sourceFingerprint }
}

function requireRecordIdentity(record: QuizPracticeRecord, context: QuizPracticeContext, artifactHash: string, sourceFingerprint: string): void {
  if (record.docId !== context.docId || record.runId !== context.runId || record.artifactId !== context.artifact.id
    || record.artifactHash !== artifactHash || record.sourceFingerprint !== sourceFingerprint) {
    throw new LocalArtifactError('conflict', '练习与当前产物不一致，请重新读取。')
  }
}

export async function loadQuizPractice(context: QuizPracticeContext): Promise<QuizPracticeRecord | undefined> {
  const { prepared, artifact, id, sourceFingerprint } = await preparePractice(context)
  const record = await db.transaction('r', [db.docs, db.sources, db.analysisTasks, db.quizPractices], async () => {
    await verifyPreparedArtifactIdentity(prepared)
    const stored = await db.quizPractices.get(id)
    if (!stored) return undefined
    const record = parseQuizPracticeRecord(stored, artifact)
    requireRecordIdentity(record, context, prepared.artifactHash, sourceFingerprint)
    return record
  })
  // Retry a durable submission whose history append was interrupted. Never create an archive implicitly.
  if (record?.submitted) await syncArchivedSubmission(record)
  return record
}

async function syncArchivedSubmission(record: QuizPracticeRecord): Promise<void> {
  const archive = await findArchiveForArtifact(record.docId, record.runId, record.artifactId,
    { artifactHash: record.artifactHash, sourceFingerprint: record.sourceFingerprint })
  if (archive) await recordArchivedQuizSubmission(archive.id, record)
}

async function archivedIssueQuestionIds(archive: LearningArchive | undefined, artifact: QuizEnvelope): Promise<string[]> {
  if (!archive) return []
  const current = await db.learningRecords.get(archive.id)
  if (!current) return []
  if (current.kind !== 'archive' || current.contentHash !== archive.contentHash) throw new LocalArtifactError('conflict', '学习归档已经变化，请重新读取练习。')
  const questionIds = new Set(artifact.payload.questions.map((question) => question.id))
  return [...new Set((await listEntities(archive.courseId, 'issue')).filter((issue) => issue.status === 'open'
    && issue.question.archiveId === archive.id && issue.question.artifactId === artifact.id && questionIds.has(issue.question.questionId))
    .map((issue) => issue.question.questionId))].sort()
}

/** Tracks only the exact archived source/artifact snapshot; no same-title or old-version issues leak in. */
export async function readQuizArchiveIssueIds(context: QuizPracticeContext): Promise<string[]> {
  const { prepared, artifact, sourceFingerprint } = await preparePractice(context)
  const archive = await findArchiveForArtifact(context.docId, context.runId, artifact.id,
    { artifactHash: prepared.artifactHash, sourceFingerprint })
  return db.transaction('r', [db.docs, db.sources, db.analysisTasks, db.learningRecords], async () => {
    await verifyPreparedArtifactIdentity(prepared)
    return archivedIssueQuestionIds(archive, artifact)
  })
}

/** expectedRevision=null creates only an absent record; every other write is a strict CAS. */
export async function saveQuizPractice(context: QuizPracticeContext, state: QuizPracticeState, expectedRevision: number | null): Promise<QuizPracticeRecord> {
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new LocalArtifactError('invalid', '练习版本无效。')
  const { prepared, artifact, id, sourceFingerprint } = await preparePractice(context)
  const validated = validateQuizState(artifact, state)
  const archive = validated.submitted ? await findArchiveForArtifact(context.docId, context.runId, artifact.id,
    { artifactHash: prepared.artifactHash, sourceFingerprint }) : undefined
  const record = await db.transaction('rw', [db.docs, db.sources, db.analysisTasks, db.quizPractices, db.learningRecords], async () => {
    await verifyPreparedArtifactIdentity(prepared)
    const stored = await db.quizPractices.get(id)
    const current = stored === undefined ? undefined : parseQuizPracticeRecord(stored, artifact)
    if (current) requireRecordIdentity(current, context, prepared.artifactHash, sourceFingerprint)
    if ((current?.revision ?? null) !== expectedRevision) throw new LocalArtifactError('conflict', '练习已在另一个页面更新，请重新读取。')
    if (validated.submitted) {
      const disputed = await archivedIssueQuestionIds(archive, artifact)
      if ((!current?.submitted || current.submissionId !== validated.submissionId) && disputed.length > 0
        || current?.submitted && disputed.some((questionId) => canonicalizeJson(current.selfAssessments[questionId] ?? null)
          !== canonicalizeJson(validated.selfAssessments[questionId] ?? null))) {
        throw new LocalArtifactError('conflict', '这份测验有待核对的题目，提交和相关自评已暂停。请在课程记录中解决疑问后再练习。')
      }
    }
    const record: QuizPracticeRecord = { version: 1, id, docId: context.docId, runId: context.runId, artifactId: artifact.id,
      artifactHash: prepared.artifactHash, sourceFingerprint, questionIds: artifact.payload.questions.map((question) => question.id),
      revision: (current?.revision ?? 0) + 1, updatedAt: Date.now(), ...validated }
    await db.quizPractices.put(record)
    return record
  })
  if (record.submitted) await syncArchivedSubmission(record)
  return record
}

/** Call from the binding deletion/expiry transaction, or independently for corrupt local practice. */
export async function cleanupQuizPractices(docId: string): Promise<void> {
  await db.quizPractices.where('docId').equals(docId).delete()
}

export async function clearQuizPractice(context: QuizPracticeContext): Promise<void> {
  const { prepared, artifact, id } = await preparePractice(context)
  await db.transaction('rw', [db.docs, db.sources, db.analysisTasks, db.quizPractices], async () => {
    await verifyPreparedArtifactIdentity(prepared)
    const stored = await db.quizPractices.get(id)
    if (stored) {
      let corrupt = false
      try { parseQuizPracticeRecord(stored, artifact) }
      catch (error) { if (error instanceof LocalArtifactError && error.code === 'corrupt') corrupt = true; else throw error }
      if (!corrupt) throw new LocalArtifactError('conflict', '练习已恢复为有效记录，请重新读取，避免删除其他页面的作答。')
    }
    await db.quizPractices.delete(id)
  })
}
