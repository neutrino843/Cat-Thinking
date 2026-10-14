import { describe, expect, it } from 'vitest'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import type { QuizPracticeState } from './quizPractice'
import { deriveQuizReviewItems } from './quizReview'

const submitted = (patch: Partial<QuizPracticeState> = {}): QuizPracticeState => ({ answers: {}, submitted: true, selfAssessments: {}, ...patch })

describe('review targets from submitted local quiz practice', () => {
  it('returns nothing before submission even when answers are incorrect or missing', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(deriveQuizReviewItems(quiz, { answers: { choice: 1 }, submitted: false, selfAssessments: {} })).toEqual([])
  })

  it('keeps unanswered questions in artifact order with zero-based indexes', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(deriveQuizReviewItems(quiz, submitted())).toEqual([
      { questionId: 'choice', questionIndex: 0, reason: 'unanswered' },
      { questionId: 'boolean', questionIndex: 1, reason: 'unanswered' },
      { questionId: 'short', questionIndex: 2, reason: 'unanswered' },
    ])
  })

  it('lists wrong objective answers without treating a valid false answer as missing', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(deriveQuizReviewItems(quiz, submitted({ answers: { choice: 1, boolean: false, short: '已答' }, selfAssessments: { short: [true, true] } }))).toEqual([
      { questionId: 'choice', questionIndex: 0, reason: 'objective-incorrect' },
    ])
    expect(deriveQuizReviewItems(quiz, submitted({ answers: { choice: 0, boolean: true, short: '已答' }, selfAssessments: { short: [true, true] } }))).toEqual([
      { questionId: 'boolean', questionIndex: 1, reason: 'objective-incorrect' },
    ])
  })

  it('distinguishes unassessed short answers from incomplete explicit self-assessment', async () => {
    const { quiz } = await localArtifactFixtures()
    const answers = { choice: 0, boolean: false, short: '自己的解释' }
    expect(deriveQuizReviewItems(quiz, submitted({ answers }))).toEqual([
      { questionId: 'short', questionIndex: 2, reason: 'self-assessment-pending' },
    ])
    for (const assessment of [[false, false], [true, false], [false, true]]) {
      expect(deriveQuizReviewItems(quiz, submitted({ answers, selfAssessments: { short: assessment } }))).toEqual([
        { questionId: 'short', questionIndex: 2, reason: 'self-assessment-incomplete' },
      ])
    }
  })

  it('keeps blank short answers unanswered even if every rubric line was checked', async () => {
    const { quiz } = await localArtifactFixtures()
    for (const short of ['', ' \t\n\u3000']) {
      expect(deriveQuizReviewItems(quiz, submitted({ answers: { choice: 0, boolean: false, short }, selfAssessments: { short: [true, true] } }))).toEqual([
        { questionId: 'short', questionIndex: 2, reason: 'unanswered' },
      ])
    }
  })

  it('returns an empty review list after all objective answers and explicit self-assessment are complete', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(deriveQuizReviewItems(quiz, submitted({ answers: { choice: 0, boolean: false, short: '自己的解释' }, selfAssessments: { short: [true, true] } }))).toEqual([])
  })

  it('uses own answers for prototype-shaped question ids and ignores inherited answer values', async () => {
    const { quiz } = await localArtifactFixtures()
    quiz.payload.questions.forEach((question, index) => { question.id = ['constructor', 'valueOf', 'toString'][index] })
    const missing = [
      { questionId: 'constructor', questionIndex: 0, reason: 'unanswered' },
      { questionId: 'valueOf', questionIndex: 1, reason: 'unanswered' },
      { questionId: 'toString', questionIndex: 2, reason: 'unanswered' },
    ]
    expect(deriveQuizReviewItems(quiz, submitted())).toEqual(missing)
    expect(deriveQuizReviewItems(quiz, submitted({
      answers: Object.create({ constructor: 0, valueOf: false, toString: '继承的回答' }) as QuizPracticeState['answers'],
      selfAssessments: Object.create({ toString: [true, true] }) as QuizPracticeState['selfAssessments'],
    }))).toEqual(missing)
    expect(deriveQuizReviewItems(quiz, submitted({
      answers: Object.fromEntries([['constructor', 0], ['valueOf', false], ['toString', '自己的解释']]),
      selfAssessments: { toString: [true, true] },
    }))).toEqual([])
  })

  it('rejects an illegal __proto__ identifier and an own __proto__ answer key', async () => {
    const { quiz } = await localArtifactFixtures()
    expect(() => deriveQuizReviewItems(quiz, submitted({ answers: Object.fromEntries([['__proto__', false]]) }))).toThrow()
    quiz.payload.questions[1].id = '__proto__'
    expect(() => deriveQuizReviewItems(quiz, submitted())).toThrow()
  })

  it('does not coerce invalid objective or short answers, even before submission', async () => {
    const { quiz } = await localArtifactFixtures()
    for (const answers of [{ choice: '0' }, { choice: 0.5 }, { choice: 2 }, { choice: NaN }, { boolean: 0 }, { boolean: 'false' }, { short: false }, { short: 'x'.repeat(10_001) }, { missing: 0 }]) {
      for (const isSubmitted of [false, true]) {
        expect(() => deriveQuizReviewItems(quiz, submitted({ answers, submitted: isSubmitted } as never))).toThrow()
      }
    }
  })

  it('rejects invalid or sparse self-assessment rather than implying completion', async () => {
    const { quiz } = await localArtifactFixtures()
    for (const selfAssessments of [{ short: [true] }, { short: [true, 1] }, { short: [true, undefined] }, { short: new Array<boolean>(2) }, { choice: [true, true] }, { missing: [true, true] }]) {
      expect(() => deriveQuizReviewItems(quiz, submitted({ answers: { short: '自己的解释' }, selfAssessments } as never))).toThrow()
    }
    expect(() => deriveQuizReviewItems(quiz, submitted({ submitted: false, selfAssessments: { short: [true, true] } }))).toThrow()
  })

  it('rejects malformed state fields and inherited top-level state fields', async () => {
    const { quiz } = await localArtifactFixtures()
    for (const state of [null, { answers: {}, submitted: true, selfAssessments: [] }, { answers: [], submitted: true, selfAssessments: {} }, { answers: {}, submitted: 'true', selfAssessments: {} }, Object.create(submitted())]) {
      expect(() => deriveQuizReviewItems(quiz, state as QuizPracticeState)).toThrow()
    }
  })

  it('validates the current quiz envelope before accepting practice state', async () => {
    const { quiz } = await localArtifactFixtures()
    const duplicate = structuredClone(quiz)
    duplicate.payload.questions[1].id = duplicate.payload.questions[0].id
    expect(() => deriveQuizReviewItems(duplicate, submitted())).toThrow()
    expect(() => deriveQuizReviewItems({ ...quiz, version: 2 } as never, submitted())).toThrow()
    const outOfBounds = structuredClone(quiz)
    if (outOfBounds.payload.questions[0].type === 'multiple-choice') outOfBounds.payload.questions[0].answerIndex = 2
    expect(() => deriveQuizReviewItems(outOfBounds, submitted())).toThrow()
  })

  it('does not mutate frozen artifact or practice state, and returns independent review items', async () => {
    const { quiz } = await localArtifactFixtures()
    const state = submitted({ answers: { choice: 1, boolean: false, short: '自己的解释' }, selfAssessments: { short: [true, false] } })
    const before = JSON.stringify({ quiz, state })
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        Object.values(value).forEach(freeze)
      }
    }
    freeze(quiz)
    freeze(state)
    const items = deriveQuizReviewItems(quiz, state)
    items[0].questionId = 'changed-by-caller'
    expect(JSON.stringify({ quiz, state })).toBe(before)
    expect(deriveQuizReviewItems(quiz, state)).toEqual([
      { questionId: 'choice', questionIndex: 0, reason: 'objective-incorrect' },
      { questionId: 'short', questionIndex: 2, reason: 'self-assessment-incomplete' },
    ])
  })
})
