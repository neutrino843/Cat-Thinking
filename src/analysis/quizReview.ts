import { quizArtifactEnvelopeSchema } from '@cat-thinking/analysis-contracts'
import { validateQuizState, type QuizEnvelope, type QuizPracticeState } from './quizPractice'

export type QuizReviewReason = 'objective-incorrect' | 'unanswered' | 'self-assessment-pending' | 'self-assessment-incomplete'

export interface QuizReviewItem {
  questionId: string
  questionIndex: number
  reason: QuizReviewReason
}

/** Derive review targets from this submitted practice only; no inferred mastery or saved queue. */
export function deriveQuizReviewItems(artifactInput: QuizEnvelope, stateInput: QuizPracticeState): QuizReviewItem[] {
  const artifact = quizArtifactEnvelopeSchema.parse(artifactInput)
  const state = validateQuizState(artifact, stateInput)
  if (!state.submitted) return []

  const items: QuizReviewItem[] = []
  artifact.payload.questions.forEach((question, questionIndex) => {
    const answer = Object.hasOwn(state.answers, question.id) ? state.answers[question.id] : undefined
    let reason: QuizReviewReason | undefined
    if (question.type === 'short-answer') {
      if (typeof answer !== 'string' || !answer.trim()) reason = 'unanswered'
      else if (!Object.hasOwn(state.selfAssessments, question.id)) reason = 'self-assessment-pending'
      else if (state.selfAssessments[question.id].some((checked) => !checked)) reason = 'self-assessment-incomplete'
    } else if (answer === undefined) reason = 'unanswered'
    else if (question.type === 'multiple-choice' ? answer !== question.answerIndex : answer !== question.answer) reason = 'objective-incorrect'

    if (reason) items.push({ questionId: question.id, questionIndex, reason })
  })
  return items
}
