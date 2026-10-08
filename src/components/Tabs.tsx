import { useEffect, useState } from 'react'
import { useDoc } from '../store/docStore'
import { listDocs } from '../store/db'
import type { DocMeta } from '../types'
import { closeDocTab, DOCS_CHANGED_EVENT, openDocById } from '../lib/tabs'
import { useT } from '../i18n'

/**
 * M11（PRD 4.4 P1）：多文档标签条。
 * - 活动标签标题取 store 实时文档（编辑中也即时更新）；
 * - 后台标签标题：优先内存 titleCache（该文档上次活动时的最新标题，不受
 *   700ms 防抖落盘时序影响），其次文档库 meta；
 * - ✕ / 中键关闭，关活动标签由 lib/tabs 选邻居或新建空白；
 * - 文档库变化（新建/删除/重命名/导入/打开 .msz）经 msz:docs-changed 刷新。
 */
export default function Tabs() {
  const tabs = useDoc((s) => s.tabs)
  const activeId = useDoc((s) => s.doc.id)
  const activeTitle = useDoc((s) => s.doc.title)
  const tr = useT()
  const [metas, setMetas] = useState<DocMeta[]>([])
  /** 各标签最近一次处于活动时的标题（内存，随标签关闭自然失效） */
  const [titles, setTitles] = useState<Record<string, string>>({})

  useEffect(() => {
    let live = true
    const refresh = () => {
      listDocs()
        .then((m) => live && setMetas(m))
        .catch(() => {})
    }
    refresh()
    window.addEventListener(DOCS_CHANGED_EVENT, refresh)
    return () => {
      live = false
      window.removeEventListener(DOCS_CHANGED_EVENT, refresh)
    }
  }, [tabs.length, activeId])

  // 订阅活动文档标题，实时写入缓存（切走后后台标签直接用，无需等落盘/列表刷新）
  useEffect(
    () =>
      useDoc.subscribe((s) => {
        if (s.doc.id && s.doc.title) {
          setTitles((prev) =>
            prev[s.doc.id] === s.doc.title ? prev : { ...prev, [s.doc.id]: s.doc.title },
          )
        }
      }),
    [],
  )

  if (!tabs.length) return null

  const titleOf = (id: string): string => {
    if (id === activeId) return activeTitle || tr('tabs.untitled')
    return titles[id] || metas.find((m) => m.id === id)?.title || tr('tabs.untitled')
  }

  return (
    <div className="tab-strip" role="tablist" aria-label="已打开文档">
      {tabs.map((id) => {
        const active = id === activeId
        return (
          <div
            key={id}
            className={'doc-tab' + (active ? ' active' : '')}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={titleOf(id)}
            onClick={() => {
              if (!active) void openDocById(id)
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeDocTab(id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !active) void openDocById(id)
            }}
          >
            <span className="doc-tab-name">{titleOf(id)}</span>
            <button
              className="doc-tab-close"
              aria-label={`${tr('tabs.close')} ${titleOf(id)}`}
              title="关闭标签"
              onClick={(e) => {
                e.stopPropagation()
                void closeDocTab(id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
