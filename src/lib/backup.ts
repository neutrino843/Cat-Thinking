const DAY = 86400000

export interface BackupState {
  /** 上次完整 JSON 导出时间戳（ms），null 表示从未备份过 */
  lastBackupAt: number | null
  /** 「3 天后提醒」的延后到期时间戳（ms），null 表示未延后 */
  snoozeUntil: number | null
  /** 当前是否存在至少一篇文档 */
  hasDocs: boolean
  /** 当前时间戳（ms），便于测试注入 */
  now: number
  /** 备份间隔阈值（天），默认 14 */
  gapDays?: number
}

/**
 * 备份提醒判定（纯函数，UI 层读取 localStorage 注入状态）：
 * - 无文档不提醒；
 * - 在 snooze 延后期内不提醒；
 * - 从未备份过（lastBackupAt==null）且存在文档 → 提醒；
 * - 距上次备份超过 gapDays 天 → 提醒。
 */
export function shouldRemindBackup(s: BackupState): boolean {
  if (!s.hasDocs) return false
  if (s.snoozeUntil && s.snoozeUntil > s.now) return false
  if (s.lastBackupAt == null) return true
  const gap = s.gapDays ?? 14
  return s.now - s.lastBackupAt >= gap * DAY
}
