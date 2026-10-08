import { useEffect, useRef, useState } from 'react'
import type { DocData, DocMeta } from '../types'
import NodePanel from './NodePanel'
import TemplateThumbnail from './TemplateThumbnail'
import {
  emptyTrash,
  deleteTemplate,
  getBlob,
  listDocs,
  listTemplates,
  listTrash,
  loadDoc,
  moveToTrash,
  purgeDoc,
  putBlob,
  restoreDoc,
  saveDoc,
  type CustomTemplate,
  type TrashMeta,
} from '../store/db'
import { buildDoc, findTpl, TEMPLATES } from '../data/templates'
import { cloneDocBlobs, cloneFromTemplate } from '../lib/templateClone'
import { parseImported } from '../lib/exporters'
import { exportTemplate, importTemplateFile } from '../lib/templateIO'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { closeDocTab, createDocTab, emitDocsChanged, openDocById } from '../lib/tabs'
import VersionHistory from './VersionHistory'

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
  /** M15：版本历史模态打开的文档 id，null 表示关闭 */
  const [historyDocId, setHistoryDocId] = useState<string | null>(null)
  const activeId = useDoc((s) => s.doc.id)
  const dark = useSettings((s) => s.dark)
  /** M7-P5：悬停预览的模板（{name, doc}），null 表示不显示 */
  const [preview, setPreview] = useState<{ name: string; doc: DocData } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const tplFileRef = useRef<HTMLInputElement>(null)

  const refresh = async () => setMetas(await listDocs())
  const refreshTrash = async () => setTrash(await listTrash().catch(() => []))
  const refreshTemplates = async () => setCustoms(await listTemplates().catch(() => []))

  // 修审计 M-5：数据加载 effect 加取消标记，避免快速切换时旧响应覆盖新状态；
  // 同时消除「effect 内同步调用 setState」反模式告警（此处 setState 实际在 await 之后）
  useEffect(() => {
    let live = true
    listDocs()
      .then((m) => {
        if (live) setMetas(m)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [activeId])

  useEffect(() => {
    let live = true
    listTrash()
      .then((t) => {
        if (live) setTrash(t)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [activeId, view])

  useEffect(() => {
    let live = true
    listTemplates()
      .then((t) => {
        if (live) setCustoms(t)
      })
      .catch(() => {})
    const h = () => refreshTemplates()
    window.addEventListener('msz:templates-changed', h)
    return () => {
      live = false
      window.removeEventListener('msz:templates-changed', h)
    }
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

  const open = (id: string) => {
    if (id === activeId) return
    // M11：经标签编排打开（恢复该文档的撤销/剪贴板会话并挂标签）
    void openDocById(id)
  }

  const create = async (tplId: string) => {
    await createDocTab(tplId)
    setMenuOpen(false)
    refresh()
  }

  const createFromCustom = async (t: CustomTemplate) => {
    const { doc: d, blobMap } = cloneFromTemplate(t.doc)
    d.title = t.name
    await cloneDocBlobs(t.doc.id, d.id, blobMap, getBlob, (id, docId, blob, nodeId) =>
      putBlob(id, docId, blob, nodeId),
    )
    await saveDoc(d)
    useDoc.getState().openDoc(d)
    emitDocsChanged()
    setMenuOpen(false)
    refresh()
  }

  /** M7-P5：悬停显示内置模板预览（按需 buildDoc，节点数少 <2ms） */
  const hoverBuiltin = (tplId: string) => setPreview({ name: findTpl(tplId).name, doc: buildDoc(findTpl(tplId)) })
  /** M7-P5：悬停显示自定义模板预览 */
  const hoverCustom = (t: CustomTemplate) => setPreview({ name: t.name, doc: t.doc })
  const leavePreview = () => setPreview(null)

  /** M7-P5：导出内置模板为 .msz-tpl */
  const exportBuiltin = async (e: React.MouseEvent, tplId: string) => {
    e.stopPropagation()
    const tpl = findTpl(tplId)
    await exportTemplate(tpl.name, buildDoc(tpl))
  }
  /** M7-P5：导出自定义模板为 .msz-tpl */
  const exportCustom = async (e: React.MouseEvent, t: CustomTemplate) => {
    e.stopPropagation()
    await exportTemplate(t.name, t.doc)
  }
  /** M7-P5：导入 .msz-tpl 模板文件 */
  const importTpl = async (file: File) => {
    try {
      await importTemplateFile(file)
      window.dispatchEvent(new Event('msz:templates-changed'))
    } catch (err) {
      alert('导入模板失败：' + (err as Error).message)
    }
  }

  const removeCustom = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!window.confirm('删除这个自定义模板？（不影响已用它创建的文档）')) return
    await deleteTemplate(id)
    refreshTemplates()
  }

  /**
   * 软删除：文档移入回收站，30 天后自动清除。
   * M11：若被删文档开着标签，走 closeDocTab（自动切邻居；无邻居则新建空白标签）。
   */
  const remove = async (id: string) => {
    if (
      !window.confirm('确定删除这篇文档？\n文档将移入回收站，30 天后自动清除；在此之前可随时还原。')
    )
      return
    await moveToTrash(id)
    if (useDoc.getState().tabs.includes(id)) await closeDocTab(id)
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
      const { doc: d, blobs } = parseImported(await file.text(), file.name)
      await saveDoc(d)
      // M7-P3：把 JSON 中的 _blobs dataURL 还原为 Blob 并写入 IndexedDB
      for (const [blobId, meta] of Object.entries(blobs)) {
        try {
          const res = await fetch(meta.dataURL)
          const blob = await res.blob()
          await putBlob(blobId, d.id, blob)
        } catch {
          /* 单个 blob 还原失败不阻断导入 */
        }
      }
      useDoc.getState().openDoc(d)
      emitDocsChanged()
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
    if (newId) await openDocById(newId)
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
            <div
              key={t.id}
              className="tpl-row"
              onMouseEnter={() => hoverBuiltin(t.id)}
              onMouseLeave={leavePreview}
            >
              <button onClick={() => create(t.id)}>{t.name}</button>
              <button
                className="tpl-export"
                title="导出为 .msz-tpl 模板文件"
                aria-label={`导出模板 ${t.name}`}
                onClick={(e) => void exportBuiltin(e, t.id)}
              >
                ⤓
              </button>
            </div>
          ))}
          {customs.length > 0 && (
            <>
              <div className="tpl-group-label">我的模板</div>
              {customs.map((t) => (
                <div
                  key={t.id}
                  className="tpl-row"
                  onMouseEnter={() => hoverCustom(t)}
                  onMouseLeave={leavePreview}
                >
                  <button className="tpl-custom" onClick={() => createFromCustom(t)}>
                    <span className="tpl-custom-name">{t.name}</span>
                  </button>
                  <button
                    className="tpl-export"
                    title="导出为 .msz-tpl 模板文件"
                    aria-label={`导出模板 ${t.name}`}
                    onClick={(e) => void exportCustom(e, t)}
                  >
                    ⤓
                  </button>
                  <span
                    className="tpl-custom-del"
                    role="button"
                    aria-label={`删除模板 ${t.name}`}
                    title="删除模板"
                    onClick={(e) => void removeCustom(e, t.id)}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </>
          )}
          {preview && (
            <div className="tpl-pop">
              <div className="tpl-pop-name">{preview.name}</div>
              <TemplateThumbnail doc={preview.doc} dark={dark} w={150} h={110} />
              <div className="tpl-pop-count">{Object.keys(preview.doc.nodes).length} 个节点</div>
            </div>
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
                    className="sb-history"
                    title="版本历史"
                    aria-label={`查看文档 ${m.title} 的版本历史`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setHistoryDocId(m.id)
                    }}
                  >
                    ⟳
                  </button>
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
            <button className="tbtn" onClick={() => tplFileRef.current?.click()} title="导入 .msz-tpl 模板文件">
              导入模板
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
              accept=".json,.msz,application/json,.md,.markdown,text/markdown,text/plain,.opml,.xml,text/x-opml,text/xml"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) importFile(f)
                e.target.value = ''
              }}
            />
            <input
              ref={tplFileRef}
              type="file"
              accept=".msz-tpl,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) importTpl(f)
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
      {/* M7：选中单节点时显示富内容编辑面板 */}
      <NodePanel />
      {/* M15：版本历史模态 */}
      {historyDocId && (
        <VersionHistory docId={historyDocId} onClose={() => setHistoryDocId(null)} />
      )}
    </aside>
  )
}
