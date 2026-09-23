import { useEffect, useRef, useState } from 'react'
import type { DocMeta } from '../types'
import {
  deleteDoc,
  deleteTemplate,
  listDocs,
  listTemplates,
  loadDoc,
  saveDoc,
  type CustomTemplate,
} from '../store/db'
import { buildDoc, findTpl, TEMPLATES } from '../data/templates'
import { cloneFromTemplate } from '../lib/templateClone'
import { parseImported } from '../lib/exporters'
import { useDoc } from '../store/docStore'

export default function Sidebar() {
  const [metas, setMetas] = useState<DocMeta[]>([])
  const [customs, setCustoms] = useState<CustomTemplate[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const activeId = useDoc((s) => s.doc.id)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async () => setMetas(await listDocs())
  const refreshTemplates = async () => setCustoms(await listTemplates().catch(() => []))

  useEffect(() => {
    refresh()
  }, [activeId])

  useEffect(() => {
    refreshTemplates()
    const h = () => refreshTemplates()
    window.addEventListener('msz:templates-changed', h)
    return () => window.removeEventListener('msz:templates-changed', h)
  }, [])

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

  const remove = async (id: string) => {
    if (!window.confirm('确定删除这篇文档？MVP 暂无回收站，建议先导出 JSON 备份。')) return
    await deleteDoc(id)
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

  const importJSON = async (file: File) => {
    try {
      const d = parseImported(await file.text())
      await saveDoc(d)
      useDoc.getState().loadDoc(d)
      refresh()
    } catch (e) {
      alert('导入失败：' + (e as Error).message)
    }
  }

  return (
    <aside className="sidebar" role="navigation" aria-label="文档库">
      <div className="sb-head">
        <span className="sb-title">文档库</span>
        <button
          className="tbtn primary"
          onClick={() => setMenuOpen((v) => !v)}
          title="新建文档"
          aria-label="新建文档"
          aria-expanded={menuOpen}
        >
          ＋ 新建
        </button>
      </div>
      {menuOpen && (
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
      <div className="sb-foot">
        <button className="tbtn" onClick={() => fileRef.current?.click()}>
          导入 JSON
        </button>
        <span className="sb-priv">🔒 数据仅存本机</span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) importJSON(f)
            e.target.value = ''
          }}
        />
      </div>
    </aside>
  )
}
