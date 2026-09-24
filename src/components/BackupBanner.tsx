import { useEffect, useState } from 'react'
import { exportCurrent } from '../lib/exporters'
import { shouldRemindBackup } from '../lib/backup'
import { useDoc } from '../store/docStore'

const LAST_BACKUP_KEY = 'msz.lastBackupAt'
const SNOOZE_KEY = 'msz.backupSnoozeUntil'
const SNOOZE_DAYS = 3
const DAY = 86400000

/**
 * 备份提醒横幅：距上次完整 JSON 导出超 14 天（或从未备份）且存在文档时，
 * 在画布顶部显示温和横幅。可「立即导出」（走 exportJSON，已内部写 lastBackupAt）
 * 或「3 天后提醒」（写 snoozeUntil = now + 3d）。纯逻辑见 backup.ts（C1 已覆盖）。
 */
export default function BackupBanner() {
  const [show, setShow] = useState(false)
  const docId = useDoc((s) => s.doc.id)

  useEffect(() => {
    const check = () => {
      const hasDocs = Boolean(docId)
      const raw = localStorage.getItem(LAST_BACKUP_KEY)
      const lastBackupAt = raw ? Number(raw) || null : null
      const snoozeRaw = localStorage.getItem(SNOOZE_KEY)
      const snoozeUntil = snoozeRaw ? Number(snoozeRaw) || null : null
      setShow(shouldRemindBackup({ lastBackupAt, snoozeUntil, hasDocs, now: Date.now() }))
    }
    check()
    // 定期复查：snooze 到期后自动重新显示
    const iv = setInterval(check, 60000)
    return () => clearInterval(iv)
  }, [docId])

  if (!show) return null

  const doBackup = () => {
    // exportJSON 内部已同步写 msz.lastBackupAt
    void exportCurrent('json')
    setShow(false)
  }

  const snooze = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * DAY))
    setShow(false)
  }

  return (
    <div className="backup-banner" role="alert">
      <span className="backup-text">上次完整备份已超过 14 天，建议导出 JSON 备份</span>
      <div className="backup-actions">
        <button className="bbtn primary" onClick={doBackup}>导出 JSON 备份</button>
        <button className="bbtn" onClick={snooze}>3 天后提醒</button>
      </div>
    </div>
  )
}
