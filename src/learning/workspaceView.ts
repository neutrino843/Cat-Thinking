import type { ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import type { CourseSnapshot, LearningArchive, QuestionRef } from './model'

type QuizArtifact = Extract<ArtifactEnvelopeV1, { kind: 'quiz' }>
export interface ArchivedQuestion { ref: QuestionRef; archive: LearningArchive; question: QuizArtifact['payload']['questions'][number] }
export const questionKey = (ref: QuestionRef): string => `${ref.archiveId}/${ref.artifactId}/${ref.questionId}`
export const sameQuestion = (a: QuestionRef, b: QuestionRef): boolean => questionKey(a) === questionKey(b)
export function archivedQuestions(archives: readonly LearningArchive[]): ArchivedQuestion[] {
  return archives.flatMap((archive) => archive.artifacts.flatMap((artifact) => artifact.kind === 'quiz'
    ? artifact.payload.questions.map((question) => ({ archive, question, ref: { archiveId: archive.id, artifactId: artifact.id, questionId: question.id, confirmed: false } })) : []))
}
export function visibleQuestions(snapshot: CourseSnapshot, pointId?: string): ArchivedQuestion[] {
  const questions = archivedQuestions(snapshot.archives)
  if (!pointId) return questions
  const point = snapshot.points.find((item) => item.id === pointId && item.status === 'active')
  return point ? questions.filter((item) => point.questionRefs.some((ref) => ref.confirmed && sameQuestion(ref, item.ref))) : []
}
export function referenceAnswer(item: ArchivedQuestion): string {
  const q = item.question
  return q.type === 'multiple-choice' ? q.options[q.answerIndex] : q.type === 'true-false' ? q.answer ? '正确' : '错误' : q.answer
}
export function safeLearningMessage(error: unknown): string {
  return error instanceof Error && ['LearningError', 'LearningRuleError', 'LearningGraphError'].includes(error.name) ? error.message : '保存或读取未完成，请重新读取后再试。'
}
export function sourceExcerpt(archive: LearningArchive, sourceId: string, start: number, end: number) {
  const source = archive.sources.find((item) => item.id === sourceId)
  if (!source || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length) return undefined
  return { name: source.name, quote: source.text.slice(start, Math.min(end, start + 4_000)), location: `字符 ${start}–${end}`, truncated: end - start > 4_000 }
}
