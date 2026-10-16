import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPERIENCE, EXPERIENCE_KEY, parseExperience, refreshExperience, saveExperience, useExperience } from './experiencePreferences'
import { focusTask } from './focusHome'
import type { HomeTask } from './homeView'

beforeEach(() => { localStorage.clear(); refreshExperience() })
describe('learning experience preferences', () => {
  it('restores independent valid choices and replaces damaged values', () => {
    expect(parseExperience({ start: '__proto__', study: 'x', companion: 'quiet' })).toEqual({ ...DEFAULT_EXPERIENCE, companion: 'quiet' })
    for (const start of ['auto', 'course', 'review'] as const) for (const study of ['guided', 'practice'] as const) for (const companion of ['gentle', 'quiet', 'beginner'] as const) {
      saveExperience({ start, study, companion }); refreshExperience()
      expect(useExperience.getState().preferences).toEqual({ ...DEFAULT_EXPERIENCE, start, study, companion })
    }
  })
  it('retains current selection and reports unsuccessful persistence', () => {
    saveExperience({ start: 'course' })
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    try { saveExperience({ companion: 'quiet' }); expect(useExperience.getState().preferences).toMatchObject({ companion: 'quiet', start: 'course' }); expect(useExperience.getState().error).toContain('本次选择已生效') } finally { spy.mockRestore() }
    refreshExperience(); expect(useExperience.getState().preferences.companion).toBe('gentle')
  })
  it('does not read or change course, answers, schedule or guide data', () => {
    localStorage.setItem('msz.isis-guide.v1', 'existing answer')
    saveExperience({ study: 'practice' })
    expect(localStorage.getItem('msz.isis-guide.v1')).toBe('existing answer')
    expect(JSON.parse(localStorage.getItem(EXPERIENCE_KEY) ?? '{}')).toEqual({ ...DEFAULT_EXPERIENCE, study: 'practice' })
  })
  it('recommends a due task from the bounded plan without changing task order or identity', () => {
    const tasks = [{ id: 'first', type: 'new' }, { id: 'due', type: 'review' }] as HomeTask[]
    expect(focusTask(tasks, 'review')).toBe(tasks[1]); expect(focusTask(tasks, 'auto')).toBe(tasks[0])
    expect(tasks.map((task) => task.id)).toEqual(['first', 'due']); expect(focusTask([], 'review')).toBeUndefined()
  })
})
