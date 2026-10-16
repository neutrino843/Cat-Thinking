import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { installLearningTestStore } from './testStore'
import { createExampleCourse } from './exampleCourse'
import { loadCourseSnapshot, updateCourse, savePracticeBundle } from './repository'
import { learningBase } from './model'
import { learningAchievements } from './achievements'
import { exportCoursePackage, previewCoursePackage, restoreCoursePackage } from './coursePackage'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import ReviewAdvice from '../components/learning/ReviewAdvice'
import { saveExperience, useExperience } from './experiencePreferences'

beforeEach(() => { installLearningTestStore(); vi.stubGlobal('Blob', NodeBlob) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('different dates count once across repeated backup restores; assisted answers never unlock independent recall', async () => {
  const example = await createExampleCourse()
  const course = await updateCourse({ ...example, example: false })
  const initial = await loadCourseSnapshot(course.id)
  for (let i = 0; i < 2; i++) {
    const at = Date.UTC(2026, 9, 10 + i, 1)
    const attempt = { ...learningBase(course.id, undefined, at), kind: 'attempt' as const, question: initial.points[0].questionRefs[0], answer: 0, submittedAt: at, learningDate: `2026-10-${10 + i}`, answerRevealed: false, origin: 'practice' as const, assistance: { recorded: true, hints: i, sourceViewed: false, fullExplanation: false } }
    await savePracticeBundle(attempt, { ...learningBase(course.id), kind: 'assessment', attemptId: attempt.id, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true })
  }
  const preview = await previewCoursePackage(await exportCoursePackage(course.id))
  const restored = await restoreCoursePackage(preview)
  const again = await restoreCoursePackage(preview)
  const snapshots = await Promise.all([course.id, restored.id, again.id].map(loadCourseSnapshot))
  expect(snapshots[1].attempts[0].id).not.toBe(snapshots[0].attempts[0].id)
  expect(snapshots[1].attempts[0].originId).toBe(snapshots[0].attempts[0].originId)
  const rewards = learningAchievements(snapshots)
  expect(rewards.find((r) => r.id === 'recall')?.evidence).toBeUndefined()
  expect(rewards.find((r) => r.id === 'return')?.evidence).toBeUndefined()
  expect(rewards.filter((r) => r.evidence)).toHaveLength(0)
})
it('example data never earns rewards and evidence deletion removes a reward', async () => {
  const course = await createExampleCourse(); const snapshot = await loadCourseSnapshot(course.id)
  snapshot.course.firstStudyAt = Date.now()
  expect(learningAchievements([snapshot]).some((r) => r.evidence)).toBe(false)
  snapshot.course.example = false
  expect(learningAchievements([snapshot]).find((r) => r.id === 'first')?.evidence).toBeTruthy()
  delete snapshot.course.firstStudyAt
  expect(learningAchievements([snapshot]).find((r) => r.id === 'first')?.evidence).toBeUndefined()
})
it('first failure followed by success that day does not become independent delayed success', async () => {
  const course = await updateCourse({ ...await createExampleCourse(), example: false })
  const s = await loadCourseSnapshot(course.id)
  const ref = s.points[0].questionRefs[0]
  for (let i = 0; i < 3; i++) {
    const at = Date.UTC(2026, 9, i < 2 ? 10 : 11, 1, i)
    const attempt = { ...learningBase(course.id, undefined, at), kind: 'attempt' as const, question: ref, answer: i === 0 ? 1 : 0, submittedAt: at, learningDate: i < 2 ? '2026-10-10' : '2026-10-11', answerRevealed: false, origin: 'practice' as const, assistance: { recorded: true, hints: 0, sourceViewed: false, fullExplanation: false } }
    await savePracticeBundle(attempt, { ...learningBase(course.id), kind: 'assessment', attemptId: attempt.id, outcome: i === 0 ? 'failure' : 'success', difficulty: i === 0 ? 'again' : 'good', selfAssessmentComplete: true })
  }
  expect(learningAchievements([await loadCourseSnapshot(course.id)]).find((a) => a.id === 'recall')?.evidence).toBeUndefined()
})
it('old answers show newer schedules without replaying the old signal or throwing', async () => {
  const s = await loadCourseSnapshot((await createExampleCourse()).id)
  const attempt = { ...learningBase(s.course.id, undefined, 1000), kind: 'attempt' as const, question: s.points[0].questionRefs[0], answer: 0, submittedAt: 1000, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' as const }
  const assessment = { ...learningBase(s.course.id), kind: 'assessment' as const, attemptId: attempt.id, outcome: 'success' as const, difficulty: 'good' as const, selfAssessmentComplete: true }
  s.schedules = [{ ...learningBase(s.course.id), kind: 'schedule', question: attempt.question, status: 'active', dueDate: '2026-10-20', stage: 2, lastLearningDate: '2026-10-16', manual: false, ruleVersion: 'intervals-v1' }]
  const html = renderToStaticMarkup(createElement(ReviewAdvice, { snapshot: s, attempt, assessment, shortAnswer: false, action: async () => {}, busy: false }))
  expect(html).toContain('2026-10-20'); expect(html).toContain('已有更新的记录')
})
it('portable preferences only apply on explicit restore and cannot contain unknown fields', async () => {
  const course = await createExampleCourse()
  saveExperience({ reading: 'continuous', companion: 'quiet' })
  const preview = await previewCoursePackage(await exportCoursePackage(course.id))
  saveExperience({ reading: 'paged', companion: 'gentle' })
  await restoreCoursePackage(preview)
  expect(useExperience.getState().preferences.reading).toBe('paged')
  await restoreCoursePackage(preview, { restoreExperience: true })
  expect(useExperience.getState().preferences.reading).toBe('continuous')
  expect(useExperience.getState().preferences.companion).toBe('quiet')
  Object.assign(preview.payload.experience ?? {}, { unknownSetting: true })
  await expect(restoreCoursePackage(preview)).rejects.toThrow('学习偏好格式无效')
})
