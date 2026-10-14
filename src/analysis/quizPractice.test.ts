import { describe, expect, it } from 'vitest'
import { parseQuizPracticeRecord, scoreQuiz, validateQuizState, type QuizAnswers, type QuizPracticeRecord } from './quizPractice'
import { localArtifactFixtures } from '../test/localArtifactFixtures'

describe('local quiz practice validation and scoring', () => {
  it('scores objective questions with an explicit denominator and counts self-assessment separately', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(scoreQuiz(quiz, {})).toEqual({ objectiveTotal: 2, objectiveCorrect: 0, objectiveUnanswered: 2, shortAnswerTotal: 1, shortAnswerAnswered: 0, selfAssessed: 0 })
    expect(scoreQuiz(quiz, { choice: 0, boolean: false, short: '我的答案' }, { short: [true, false] })).toEqual({ objectiveTotal: 2, objectiveCorrect: 2, objectiveUnanswered: 0, shortAnswerTotal: 1, shortAnswerAnswered: 1, selfAssessed: 1 })
    expect(scoreQuiz(quiz, { choice: 1, boolean: true, short: '   ' })).toMatchObject({ objectiveCorrect: 0, objectiveUnanswered: 0, shortAnswerAnswered: 0 })
  })

  it('rejects coercions, bounds and invalid self-assessment; keeps user text as text', async () => {
    const { quiz } = await localArtifactFixtures()
    const invalidAnswers: QuizAnswers[] = [{ choice: '0' }, { choice: -1 }, { choice: 2 }, { choice: 0.5 }, { boolean: 0 }, { boolean: 'false' }, { short: false }, { missing: 0 }, { short: 'x'.repeat(10_001) }]
    for (const answers of invalidAnswers) {
      expect(() => validateQuizState(quiz, { answers, submitted: false, selfAssessments: {} })).toThrow()
    }
    for (const selfAssessments of [{ short: [true] }, { choice: [true] }, { missing: [true] }, { short: ['yes', false] }]) {
      expect(() => validateQuizState(quiz, { answers: {}, submitted: true, selfAssessments } as never)).toThrow()
    }
    expect(() => validateQuizState(quiz, { answers: {}, submitted: false, selfAssessments: { short: [true, false] } })).toThrow()
    expect(() => validateQuizState(quiz, { answers: {}, submitted: true, selfAssessments: { short: new Array<boolean>(2) } })).toThrow()
    expect(() => validateQuizState(quiz, Object.create({ answers: {}, submitted: true, selfAssessments: {} }))).toThrow()
    expect(validateQuizState(quiz, { answers: { short: '<script>synthetic</script>' }, submitted: false, selfAssessments: {} }).answers.short).toBe('<script>synthetic</script>')
  })

  it('restores only versioned, whitelisted matching records and rejects corrupted rows safely', async () => {
    const { quiz, task } = await localArtifactFixtures()
    const record: QuizPracticeRecord = { version: 1, id: 'practice-id', docId: quiz.docId, runId: quiz.runId, artifactId: quiz.id,
      artifactHash: task.artifactIdentities!.quiz!.contentHash!, sourceFingerprint: 'a'.repeat(64), questionIds: quiz.payload.questions.map((question) => question.id),
      revision: 1, updatedAt: 1, answers: { choice: 0 }, submitted: true, selfAssessments: {} }
    expect(parseQuizPracticeRecord(record, quiz)).toEqual(record)
    expect(parseQuizPracticeRecord({ ...record, submissionId: 'genuine-submission', submittedAt: 2 }, quiz)).toMatchObject({ submissionId: 'genuine-submission', submittedAt: 2 })
    for (const patch of [{ version: 2 }, { answerIndex: 0 }, { payload: quiz.payload }, { revision: 0 }, { updatedAt: NaN }, { artifactHash: 'bad' },
      { questionIds: ['missing'] }, { answers: { choice: '0' } }, { submitted: undefined }, { selfAssessments: [] },
      { submissionId: 'missing-time' }, { submittedAt: 2 }, { submissionId: 'bad-time', submittedAt: -1 },
      { submitted: false, submissionId: 'false-submit', submittedAt: 2 }]) {
      expect(() => parseQuizPracticeRecord({ ...record, ...patch }, quiz)).toThrow('损坏')
    }
  })
})
