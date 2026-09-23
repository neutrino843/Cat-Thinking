import { describe, expect, it } from 'vitest'
import {
  addDays,
  clampRange,
  diffDays,
  isWeekend,
  monthKey,
  parseISO,
  toISO,
  todayISO,
  weekStart,
  weekday,
} from '../lib/date'

describe('date 工具', () => {
  it('parseISO/toISO 往返且按本地时区', () => {
    expect(toISO(parseISO('2026-03-08'))).toBe('2026-03-08')
    expect(parseISO('2026-02-28').getMonth()).toBe(1)
  })

  it('addDays 跨月跨年', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28') // 2026 平年
  })

  it('diffDays 整日差', () => {
    expect(diffDays('2026-09-21', '2026-09-21')).toBe(0)
    expect(diffDays('2026-09-21', '2026-10-01')).toBe(10)
    expect(diffDays('2026-10-01', '2026-09-21')).toBe(-10)
  })

  it('weekday/isWeekend 与已知日期一致（2026-09-21 周一）', () => {
    expect(weekday('2026-09-21')).toBe(1)
    expect(isWeekend('2026-09-19')).toBe(true) // 周六
    expect(isWeekend('2026-09-20')).toBe(true) // 周日
    expect(isWeekend('2026-09-21')).toBe(false)
  })

  it('weekStart 回到周一', () => {
    expect(weekStart('2026-09-21')).toBe('2026-09-21') // 周一本日
    expect(weekStart('2026-09-27')).toBe('2026-09-21') // 周日
  })

  it('monthKey 与 todayISO 格式', () => {
    expect(monthKey('2026-09-21')).toBe('2026-09')
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('clampRange 纠正颠倒区间', () => {
    expect(clampRange('2026-09-30', '2026-09-01')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(clampRange('2026-09-01', '2026-09-30')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(clampRange(undefined, undefined)).toBeNull()
  })
})
