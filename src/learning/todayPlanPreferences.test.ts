import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTodayPlanPreference, loadTodayPlanPreferences, parseTodayPlanPreferences, saveTodayPlanPreference, TODAY_PLAN_PREFERENCES_KEY, todayPlanActionFor } from './todayPlanPreferences'

const at = Date.parse('2026-10-15T04:00:00Z')
beforeEach(() => localStorage.clear())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('today plan preferences', () => {
  it('saves, replaces and clears one task decision without retaining a previous day', () => {
    saveTodayPlanPreference('course', 'point:item', 'later', at)
    expect(loadTodayPlanPreferences(at)).toMatchObject([{ courseId: 'course', taskId: 'point:item', action: 'later' }])
    expect(todayPlanActionFor(loadTodayPlanPreferences(at), 'course', 'point:item', at)).toBe('later')
    expect(todayPlanActionFor(loadTodayPlanPreferences(at), 'course', 'point:item', at + 86_400_000)).toBeUndefined()
    saveTodayPlanPreference('course', 'point:item', 'tomorrow', at + 1)
    expect(loadTodayPlanPreferences(at)[0].action).toBe('tomorrow')
    expect(loadTodayPlanPreferences(at + 86_400_000)).toEqual([])
    clearTodayPlanPreference('course', 'point:item', at)
    expect(loadTodayPlanPreferences(at)).toEqual([])
  })

  it('strictly rejects unknown fields, duplicate tasks and malformed values', () => {
    const item = { date: '2026-10-15', courseId: 'course', taskId: 'task', action: 'later', updatedAt: at }
    for (const input of [{ version: 1, items: [{ ...item, extra: true }] }, { version: 1, items: [item, item] },
      { version: 1, items: [{ ...item, date: '2026-02-30' }] }, { version: 1, items: [{ ...item, courseId: 'bad id' }] },
      { version: 1, items: [{ ...item, courseId: '' }] }, { version: 1, items: [{ ...item, courseId: '-leading' }] },
      { version: 1, items: [{ ...item, taskId: 'x'.repeat(129) }] }, { version: 1, items: [{ ...item, action: 'delete' }] },
      { version: 2, items: [] }]) expect(() => parseTodayPlanPreferences(input)).toThrow()
  })

  it('rejects more than 500 decisions', () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      date: '2026-10-15', courseId: 'course', taskId: `task:${index}`, action: 'later', updatedAt: at,
    }))
    expect(() => parseTodayPlanPreferences({ version: 1, items })).toThrow()
  })

  it('falls back to no decisions on corrupt reads and reports failed writes', () => {
    localStorage.setItem(TODAY_PLAN_PREFERENCES_KEY, '{broken')
    expect(loadTodayPlanPreferences(at)).toEqual([])
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('unavailable') } })
    expect(() => saveTodayPlanPreference('course', 'task', 'later', at)).toThrow('unavailable')
  })
})
