import { useEffect, useState } from 'react'
import { useDoc } from '../store/docStore'
import { deleteVersion, listVersions, restoreVersion, type DocVersionMeta } from '../store/db'
import { useT } from '../i18n'

/**
 * M15：文档版本历史面板。
 * 列出某文档的版本快照（按时间倒序），支持恢复与删除单个版本。
 */
export default function VersionHistory({ docId, onClose }: { docId: string; onClose: () => void }) {
  const t = useT()
  const [versions, setVersions] = useState<DocVersionMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      const v = await listVersions(docId)
      if (active) {
        setVersions(v)
        setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [docId])

  const handleRestore = async (v: DocVersionMeta) => {
    if (!window.confirm(t('history.restoreConfirm'))) return
    setRestoring(v.id)
    const restored = await restoreVersion(v.id)
    setRestoring(null)
    if (restored) {
      // 回滚后用恢复的内容替换内存中的活动文档
      useDoc.getState().loadDoc(restored)
      onClose()
    } else {
      window.alert(t('history.restoreFailed'))
    }
  }

  const handleDelete = async (v: DocVersionMeta) => {
    if (!window.confirm(t('history.deleteConfirm'))) return
    await deleteVersion(v.id)
    setVersions((prev) => prev.filter((x) => x.id !== v.id))
  }

  return (
    <div className="modal-mask" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('history.title')}</span>
          <button className="tbtn" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="vh-empty">{t('common.loading')}</div>
          ) : versions.length === 0 ? (
            <div className="vh-empty">{t('history.empty')}</div>
          ) : (
            <ul className="vh-list">
              {versions.map((v) => (
                <li key={v.id} className="vh-item">
                  <div className="vh-info">
                    <div className="vh-title">{v.title || t('common.untitled')}</div>
                    <div className="vh-time">
                      {new Date(v.createdAt).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <div className="vh-actions">
                    <button
                      className="tbtn"
                      disabled={restoring === v.id}
                      onClick={() => handleRestore(v)}
                    >
                      {restoring === v.id ? t('common.loading') : t('history.restore')}
                    </button>
                    <button className="tbtn danger" onClick={() => handleDelete(v)}>
                      {t('common.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
