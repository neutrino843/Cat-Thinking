import { describe, expect, it } from 'vitest'
import { shouldRemindBackup } from './backup'

const NOW = 1790000000000 // 固定基准
const DAY = 86400000

describe('shouldRemindBackup', () => {
  it('无文档不提醒', () => {
    expect(
      shouldRemindBackup({ lastBackupAt: null, snoozeUntil: null, hasDocs: false, now: NOW }),
    ).toBe(false)
  })

  it('从未备份且有文档 → 提醒', () => {
    expect(
      shouldRemindBackup({ lastBackupAt: null, snoozeUntil: null, hasDocs: true, now: NOW }),
    ).toBe(true)
  })

  it('snooze 延后期内不提醒', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: null,
        snoozeUntil: NOW + 3 * DAY,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('snooze 刚到期且从未备份 → 重新提醒', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: null,
        snoozeUntil: NOW,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('距上次备份超 14 天 → 提醒', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 15 * DAY,
        snoozeUntil: null,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('距上次备份正好 14 天 → 提醒（>= 阈值）', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 14 * DAY,
        snoozeUntil: null,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(true)
  })

  it('距上次备份不足 14 天 → 不提醒', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 13 * DAY,
        snoozeUntil: null,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('自定义 gapDays 阈值生效', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 5 * DAY,
        snoozeUntil: null,
        hasDocs: true,
        now: NOW,
        gapDays: 7,
      }),
    ).toBe(false)
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 7 * DAY,
        snoozeUntil: null,
        hasDocs: true,
        now: NOW,
        gapDays: 7,
      }),
    ).toBe(true)
  })

  it('超期但 snooze 未到期 → 不提醒（snooze 优先）', () => {
    expect(
      shouldRemindBackup({
        lastBackupAt: NOW - 30 * DAY,
        snoozeUntil: NOW + 1 * DAY,
        hasDocs: true,
        now: NOW,
      }),
    ).toBe(false)
  })
})
