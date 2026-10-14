import { expect, it } from 'vitest'
import { archivedFixture } from './testFixtures'
import { learningBase, type CourseSnapshot, type LearningSession, type PracticeAttempt, type AssessmentEvent } from './model'
import { archivedQuestions } from './workspaceView'
import { examSessionReport } from './examReport'

it('separates objective comparisons, self-review, unanswered and disputed questions using exact session identities', async () => {
  const { archive } = await archivedFixture(); const refs = archivedQuestions([archive]).map((item) => item.ref)
  const session: LearningSession = { ...learningBase(archive.courseId, 'exam', 1), kind: 'session', purpose: 'exam', questions: refs, pointIds: [], title: '公开练习', status: 'active', steps: [] }
  const attempt: PracticeAttempt = { ...learningBase(archive.courseId, 'answer', 1), kind: 'attempt', question: refs[0], sessionId: session.id, answer: 0, submittedAt: 1, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' }
  const assessment: AssessmentEvent = { ...learningBase(archive.courseId, 'review', 1), kind: 'assessment', attemptId: attempt.id, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true }
  const snapshot = { archives: [archive], attempts: [attempt, { ...attempt, id: 'unrelated-later-answer', sessionId: undefined, answer: 1, submittedAt: 5 }], assessments: [assessment], issues: [] } as unknown as CourseSnapshot
  expect(examSessionReport(snapshot, session).counts).toMatchObject({ consistent: 1, unanswered: 2, 'self-assessed': 0 })
  snapshot.issues.push({ ...learningBase(archive.courseId), kind: 'issue', question: refs[0], reason: 'answer', note: '', status: 'open' })
  expect(examSessionReport(snapshot, session).counts).toMatchObject({ consistent: 0, disputed: 1 })
  snapshot.issues = []; snapshot.attempts.push({ ...attempt, id: 'short', question: refs[2], answer: '我的简答' })
  expect(examSessionReport(snapshot, session).counts['pending-self-assessment']).toBe(1)
  snapshot.assessments.push({ ...assessment, id: 'self', attemptId: 'short', outcome: 'partial' })
  expect(examSessionReport(snapshot, session).counts['self-assessed']).toBe(1)
  snapshot.archives = []; expect(examSessionReport(snapshot, session).counts.missing).toBe(3)
  expect(examSessionReport(snapshot, { ...session, questions: undefined }).items).toEqual([])
})

it('reports the latest attempt within an exam independently of UUID order', async () => {
  const { archive } = await archivedFixture(); const ref = archivedQuestions([archive])[0].ref
  const session: LearningSession = { ...learningBase(archive.courseId, 'exam', 1), kind: 'session', purpose: 'exam', questions: [ref], pointIds: [], title: '', status: 'active', steps: [] }
  const attempt: PracticeAttempt = { ...learningBase(archive.courseId, 'z-old', 1), kind: 'attempt', question: ref, sessionId: session.id, answer: 0, submittedAt: 1, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' }
  const snapshot = { archives: [archive], attempts: [attempt, { ...attempt, id: 'a-new', answer: 1, submittedAt: 2 }], assessments: [], issues: [] } as unknown as CourseSnapshot
  expect(examSessionReport(snapshot, session).items[0]).toMatchObject({ status: 'inconsistent', attempt: { id: 'a-new' } })
})
