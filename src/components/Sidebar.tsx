import { useEffect, useRef, useState } from 'react'
import type { DocMeta } from '../types'
import {
  emptyTrash,
  deleteTemplate,
  listDocs,
  listTemplates,
  listTrash,
  loadDoc,
  moveToTrash,
  purgeDoc,
  restoreDoc,
  saveDoc,
  type CustomTemplate,
  type TrashMeta,
} from '../store/db'
import { buildDoc, findTpl, TEMPLATES } from '../data/templates'
import { cloneFromTemplate } from '../lib/templateClone'
import { parseImported } from '../lib/exporters'
import { useDoc } from '../store/docStore'

type View = 'library' | 'trash'

/** 事件常量：Palette 触发 trash-open / trash-empty 时派发，Sidebar 监听切换视图 */
const TRASH_OPEN_EVENT = 'msz:trash-open'
const TRASH_EMPTY_EVENT = 'msz:trash-empty'

function fmtMD(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}-${day}`
}

export default function Sidebar() {
  const [metas, setMetas] = useState<DocMeta[]>([])
  const [trash, setTrash] = useState<TrashMeta[]>([])
  const [customs, setCustoms] = useState<CustomTemplate[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<View>('library')
  const activeId = useDoc((s) => s.doc.id)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async () => setMetas(await listDocs())
  const refreshTrash = async () => setTrash(await listTrash().catch(() => []))
  const refreshTemplates = async () => setCustoms(await listTemplates().catch(() => []))

  useEffect(() => {
    refresh()
  }, [activeId])

  useEffect(() => {
    refreshTrash()
  }, [activeId, view])

  useEffect(() => {
    refreshTemplates()
    const h = () => refreshTemplates()
    window.addEventListener('msz:templates-changed', h)
    return () => window.removeEventListener('msz:templates-changed', h)
  }, [])

  /* Palette 命令：打开回收站视图 / 清空回收站 */
  useEffect(() => {
    const onOpen = () => setView('trash')
    const onEmpty = async () => {
      if (!trash.length) return
      if (!window.confirm(`确定清空回收站？共 ${trash.length} 篇文档将被永久删除，无法恢复。`)) return
      await emptyTrash()
      await refreshTrash()
    }
    window.addEventListener(TRASH_OPEN_EVENT, onOpen)
    window.addEventListener(TRASH_EMPTY_EVENT, onEmpty as EventListener)
    return () => {
      window.removeEventListener(TRASH_OPEN_EVENT, onOpen)
      window.removeEventListener(TRASH_EMPTY_EVENT, onEmpty as EventListener)
    }
  }, [trash.length])

  const open = async (id: string) => {
    if (id === activeId) return
    const d = await loadDoc(id)
    if (d) useDoc.getState().loadDoc(d)
  }

  const create = async (tplId: string) => {
    const d = buildDoc(findTpl(tplId))
    await saveDoc(d)
    useDoc.getState().loadDoc(d)
    setMenuOpen(false)
    refresh()
  }

  const createFromCustom = async (t: CustomTemplate) => {
    const d = cloneFromTemplate(t.doc)
    d.title = t.name
    await saveDoc(d)
    useDoc.getState().loadDoc(d)
    setMenuOpen(false)
    refresh()
  }

  const removeCustom = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!window.confirm('删除这个自定义模板？（不影响已用它创建的文档）')) return
    await deleteTemplate(id)
    refreshTemplates()
  }

  /**
   * 软删除：文档移入回收站，30 天后自动清除。
   * 仍保留旧逻辑中的兜底——若当前激活文档被删，切换到列表第一条或新建空白。
   */
  const remove = async (id: string) => {
    if (
      !window.confirm('确定删除这篇文档？\n文档将移入回收站，30 天后自动清除；在此之前可随时还原。')
    )
      return
    await moveToTrash(id)
    if (id === activeId) {
      const rest = (await listDocs()).filter((m) => m.id !== id)
      if (rest.length) {
        const d = await loadDoc(rest[0].id)
        if (d) useDoc.getState().loadDoc(d)
      } else {
        const d = buildDoc(findTpl('blank'))
        await saveDoc(d)
        useDoc.getState().loadDoc(d)
      }
    }
    refresh()
    refreshTrash()
  }

  const startRename = (m: DocMeta) => {
    setRenaming(m.id)
    setRenameVal(m.title)
  }

  const commitRename = async () => {
    if (!renaming) return
    const id = renaming
    const title = renameVal.trim() || '未命名导图'
    const d = await loadDoc(id)
    if (d) {
      d.title = title
      await saveDoc(d)
      if (id === activeId) useDoc.getState().setTitle(title)
    }
    setRenaming(null)
    refresh()
  }

  const importFile = async (file: File) => {
    try {
      const d = parseImported(await file.text(), file.name)
      await saveDoc(d)
      useDoc.getState().loadDoc(d)
      refresh()
    } catch (e) {
      alert('导入失败：' + (e as Error).message)
    }
  }

  /* 回收站操作 */
  const restore = async (id: string) => {
    const newId = await restoreDoc(id)
    await refreshTrash()
    await refresh()
    if (newId) {
      const d = await loadDoc(newId)
      if (d) useDoc.getState().loadDoc(d)
    }
  }

  const purge = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation()
    if (!window.confirm(`永久删除「${title || '未命名导图'}」？此操作无法撤销。`)) return
    await purgeDoc(id)
    refreshTrash()
  }

  const empty = async () => {
    if (!trash.length) return
    if (!window.confirm(`确定清空回收站？共 ${trash.length} 篇文档将被永久删除，无法恢复。`)) return
    await emptyTrash()
    refreshTrash()
  }

  return (
    <aside className="sidebar" role="navigation" aria-label="文档库">
      <div className="sb-head">
        <span className="sb-title">{view === 'library' ? '文档库' : '回收站'}</span>
        {view === 'library' ? (
          <button
            className="tbtn primary"
            onClick={() => setMenuOpen((v) => !v)}
            title="新建文档"
            aria-label="新建文档"
            aria-expanded={menuOpen}
          >
            ＋ 新建
          </button>
        ) : (
          <button
            className="tbtn"
            onClick={() => setView('library')}
            title="返回文档库"
            aria-label="返回文档库"
          >
            ← 返回
          </button>
        )}
      </div>

      {view === 'library' && menuOpen && (
        <div className="tpl-menu">
          <div className="tpl-group-label">内置模板</div>
          {TEMPLATES.map((t) => (
            <button key={t.id} onClick={() => create(t.id)}>
              {t.name}
            </button>
          ))}
          {customs.length > 0 && (
            <>
              <div className="tpl-group-label">我的模板</div>
              {customs.map((t) => (
                <button key={t.id} className="tpl-custom" onClick={() => createFromCustom(t)}>
                  <span className="tpl-custom-name">{t.name}</span>
                  <span
                    className="tpl-custom-del"
                    role="button"
                    aria-label={`删除模板 ${t.name}`}
                    title="删除模板"
                    onClick={(e) => void removeCustom(e, t.id)}
                  >
                    ✕
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {view === 'library' ? (
        <div className="sb-list">
          {metas.map((m) => (
            <div
              key={m.id}
              className={'sb-item' + (m.id === activeId ? ' active' : '')}
              onClick={() => open(m.id)}
              onDoubleClick={() => startRename(m)}
            >
              {renaming === m.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="重命名文档"
                />
              ) : (
                <>
                  <span className="sb-name">{m.title || '未命名导图'}</span>
                  <span className="sb-date">
                    {new Date(m.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                  </span>
                  <button
                    className="sb-del"
                    title="删除"
                    aria-label={`删除文档 ${m.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(m.id)
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="sb-list sb-trash-list">
          {trash.length === 0 ? (
            <div className="sb-trash-empty">回收站为空</div>
          ) : (
            trash.map((t) => (
              <div key={t.id} className="sb-item sb-trash-item" role="group" aria-label={`${t.title || '未命名导图'} 回收站条目`}>
                <span className="sb-name">{t.title || '未命名导图'}</span>
                <span className="sb-date" title={`删除于 ${new Date(t.deletedAt).toLocaleString('zh-CN')}`}>
                  {fmtMD(t.deletedAt)}
                </span>
                <button
                  className="sb-act"
                  title="还原"
                  aria-label={`还原 ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void restore(t.id)
                  }}
                >
                  ↺
                </button>
                <button
                  className="sb-del"
                  title="永久删除"
                  aria-label={`永久删除 ${t.title}`}
                  onClick={(e) => void purge(e, t.id, t.title)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="sb-foot">
        {view === 'library' ? (
          <>
            <button className="tbtn" onClick={() => fileRef.current?.click()}>
              导入文件
            </button>
            <button
              className="sb-trash-btn"
              onClick={() => setView('trash')}
              title="打开回收站"
              aria-label={`回收站，共 ${trash.length} 篇`}
            >
              🗑 回收站{trash.length > 0 ? ` (${trash.length})` : ''}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json,.md,.markdown,text/markdown,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) importFile(f)
                e.target.value = ''
              }}
            />
          </>
        ) : (
          <>
            <span className="sb-priv">🔒 30 天保留期</span>
            <button
              className="tbtn danger"
              onClick={empty}
              disabled={!trash.length}
              title="清空回收站"
              aria-label="清空回收站"
            >
              清空回收站
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
