import { useEffect, useRef, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { searchRef } from '../store/refs'
import { exportCurrent } from '../lib/exporters'
import {
  FILE_SAVED_EVENT,
  isFileHandleSupported,
  openMSZCurrent,
  quickSaveCurrent,
  saveMSZAs,
} from '../lib/fileHandle'
import type { LayoutKind } from '../types'
import type { SketchLevel } from '../store/settings'
import { SCALES } from './Gantt'
import type { GanttScale } from '../lib/gantt'
import { useI18n, useT } from '../i18n'

interface Props {
  query: string
  setQuery: (q: string) => void
}

/** 不支持 File System Access API 时的降级说明（Firefox/Safari） */
const FSA_UNSUPPORTED_MSG =
  '当前浏览器不支持直接读写 .msz 文件（需 Chrome/Edge 100+）。\n可使用侧栏「导入文件」与「导出 JSON」达到同样的备份迁移效果。'

export default function Toolbar({ query, setQuery }: Props) {
  const doc = useDoc((s) => s.doc)
  const past = useDoc((s) => s.past.length)
  const future = useDoc((s) => s.future.length)
  const dark = useSettings((s) => s.dark)
  const sketch = useSettings((s) => s.sketch)
  const outline = useSettings((s) => s.outline)
  const sidebar = useSettings((s) => s.sidebar)
  const view = useSettings((s) => s.view)
  const ganttScale = useSettings((s) => s.ganttScale)
  const lang = useI18n((s) => s.lang)
  const tr = useT()
  const st = useSettings.getState
  const matchIdx = useRef(0)
  /** M10：.msz 保存成功轻提示（2.5s 自动消失） */
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const onSaved = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name
      setToast(name ? `已保存到 ${name}` : '已保存')
      window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), 2500)
    }
    window.addEventListener(FILE_SAVED_EVENT, onSaved)
    return () => {
      window.removeEventListener(FILE_SAVED_EVENT, onSaved)
      window.clearTimeout(toastTimer.current)
    }
  }, [])

  /** M10：打开磁盘 .msz 文件 */
  const onOpenMSZ = () => {
    void openMSZCurrent()
      .then((r) => {
        if (r === 'unsupported') window.alert(FSA_UNSUPPORTED_MSG)
      })
      .catch((e) => window.alert('打开 .msz 失败：' + (e as Error).message))
  }
  /** M10：另存为 .msz */
  const onSaveMSZAs = () => {
    if (!isFileHandleSupported()) {
      window.alert(FSA_UNSUPPORTED_MSG)
      return
    }
    void saveMSZAs(useDoc.getState().doc).catch((e) =>
      window.alert('保存 .msz 失败：' + (e as Error).message),
    )
  }
  /** M10：保存到绑定的 .msz（Ctrl+S；未绑定则自动走另存为） */
  const onQuickSave = () => {
    void quickSaveCurrent()
      .then((r) => {
        if (r === 'unsupported') window.alert(FSA_UNSUPPORTED_MSG)
      })
      .catch((e) => window.alert('保存 .msz 失败：' + (e as Error).message))
  }

  const jumpToMatch = () => {
    const nodes = useDoc.getState().doc.nodes
    const ids = Object.values(nodes)
      .filter((n) => n.text.includes(query.trim()))
      .map((n) => n.id)
    if (!ids.length) return
    const id = ids[matchIdx.current % ids.length]
    matchIdx.current++
    useDoc.getState().select([id])
    if (view === 'gantt') window.dispatchEvent(new CustomEvent('msz:gantt-find', { detail: id }))
    else window.dispatchEvent(new CustomEvent('msz:center', { detail: id }))
  }

  return (
    <header className="toolbar">
      <button className="tbtn" title="文档库" aria-label="切换文档库侧栏" onClick={() => st().toggleSidebar()}>
        ☰
      </button>
      <div className="brand" title="猫思之" aria-hidden="true">🐱</div>
      <input
        className="doc-title"
        value={doc.title}
        placeholder={tr('common.untitled')}
        aria-label="文档标题"
        onChange={(e) => useDoc.getState().setTitle(e.target.value)}
      />

      <div className="view-switch" role="tablist" aria-label="视图切换">
        <button
          role="tab"
          aria-selected={view === 'mind'}
          className={'tbtn' + (view === 'mind' ? ' on' : '')}
          onClick={() => st().setView('mind')}
          title="思维导图视图"
        >
          {tr('view.mind')}
        </button>
        <button
          role="tab"
          aria-selected={view === 'gantt'}
          className={'tbtn' + (view === 'gantt' ? ' on' : '')}
          onClick={() => st().setView('gantt')}
          title="甘特图视图（与导图同源）"
        >
          {tr('view.gantt')}
        </button>
      </div>

      {view === 'mind' && (
        <button
          className="tbtn primary"
          title="开始演示（按分支逐级讲解，←/→ 翻页）"
          aria-label="开始演示"
          onClick={() => window.dispatchEvent(new Event('msz:present'))}
        >
          ▶ 演示
        </button>
      )}

      {view === 'mind' ? (
        <>
          <select
            className="tsel"
            value={doc.layout}
            onChange={(e) => useDoc.getState().setLayout(e.target.value as LayoutKind)}
            title="布局"
            aria-label="布局"
          >
            <option value="logic">逻辑图</option>
            <option value="tree">树形图</option>
            <option value="org">组织架构</option>
            <option value="fishbone">鱼骨图</option>
            <option value="timeline">时间轴</option>
          </select>
          <select
            className="tsel"
            value={sketch}
            onChange={(e) => st().setSketch(Number(e.target.value) as SketchLevel)}
            title="手绘程度"
            aria-label="手绘程度"
          >
            <option value={0}>简洁</option>
            <option value={1}>中等</option>
            <option value={2}>很手绘</option>
          </select>
        </>
      ) : (
        <select
          className="tsel"
          value={ganttScale}
          onChange={(e) => st().setGanttScale(e.target.value as GanttScale)}
          title="时间轴缩放"
          aria-label="时间轴缩放"
        >
          {SCALES.map((s) => (
            <option key={s.id} value={s.id}>
              按{s.label}
            </option>
          ))}
        </select>
      )}

      <input
        ref={searchRef}
        className="tsearch"
        type="search"
        aria-label={view === 'mind' ? '搜索节点' : '搜索并定位任务'}
        placeholder={view === 'mind' ? '搜索节点 (Ctrl+F)' : '搜索并定位 (Ctrl+F)'}
        value={query}
        onChange={(e) => {
          matchIdx.current = 0
          setQuery(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            jumpToMatch()
          } else if (e.key === 'Escape') {
            setQuery('')
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <button className="tbtn" disabled={!past} title="撤销 (Ctrl+Z)" aria-label="撤销" onClick={() => useDoc.getState().undo()}>
        ↶
      </button>
      <button className="tbtn" disabled={!future} title="重做 (Ctrl+Shift+Z)" aria-label="重做" onClick={() => useDoc.getState().redo()}>
        ↷
      </button>
      {view === 'mind' && (
        <button className="tbtn" title="适应窗口" aria-label="适应窗口" onClick={() => window.dispatchEvent(new Event('msz:fit'))}>
          ⛶
        </button>
      )}
      {view === 'mind' && (
        <button className="tbtn" title={outline ? '关闭大纲' : '打开大纲'} aria-pressed={outline} onClick={() => st().toggleOutline()}>
          {tr('view.outline')}
        </button>
      )}
      <button className="tbtn" title="深色 / 浅色" aria-label={dark ? '切换到浅色模式' : '切换到深色模式'} onClick={() => st().toggleDark()}>
        {dark ? '☀' : '☾'}
      </button>
      <select
        className="tsel lang-sel"
        value={lang}
        title={tr('settings.language')}
        aria-label={tr('settings.language')}
        onChange={(e) => useI18n.getState().setLang(e.target.value as 'zh-CN' | 'en-US')}
      >
        <option value="zh-CN">中</option>
        <option value="en-US">EN</option>
      </select>
      <details className="tmenu">
        <summary className="tbtn">文件 ▾</summary>
        {/* M10：点击任一菜单项后自动收起（原生 details 不会因内部点击而关闭） */}
        <div
          className="tmenu-pop"
          onClick={(e) => {
            if ((e.target as HTMLElement).tagName === 'BUTTON') {
              const d = e.currentTarget.closest('details')
              if (d) d.open = false
            }
          }}
        >
          <button onClick={onOpenMSZ} title="从磁盘打开 .msz 单文件文档">
            打开 .msz 文件…
          </button>
          <button onClick={onQuickSave} title="保存到已绑定的 .msz 文件（未绑定则先选择位置）">
            保存到文件（Ctrl+S）
          </button>
          <button onClick={onSaveMSZAs} title="选择磁盘位置另存为 .msz 单文件">
            另存为 .msz…
          </button>
        </div>
      </details>
      <details className="tmenu">
        <summary className="tbtn">导出 ▾</summary>
        <div
          className="tmenu-pop"
          onClick={(e) => {
            if ((e.target as HTMLElement).tagName === 'BUTTON') {
              const d = e.currentTarget.closest('details')
              if (d) d.open = false
            }
          }}
        >
          <button onClick={() => exportCurrent('json')}>JSON（完整数据）</button>
          <button onClick={() => exportCurrent('md')}>Markdown（.md）</button>
          <button onClick={() => exportCurrent('opml')}>OPML（.opml 大纲）</button>
          <button onClick={() => exportCurrent('csv')}>甘特任务表（.csv）</button>
          <button onClick={() => exportCurrent('pdf')}>
            PDF（{view === 'gantt' ? '甘特图' : '思维导图'}）
          </button>
          <button onClick={() => exportCurrent('svg')}>
            SVG（{view === 'gantt' ? '甘特图' : '思维导图'}）
          </button>
          <button onClick={() => exportCurrent('png')}>
            PNG（{view === 'gantt' ? '甘特图' : '思维导图'}）
          </button>
        </div>
      </details>
      <button className="tbtn kbd-hint" title="命令面板" onClick={() => st().setPalette(true)}>
        Ctrl+K
      </button>
      {!sidebar && <span className="spacer" />}
      {toast && (
        <span className="file-toast" role="status" aria-live="polite">
          {toast}
        </span>
      )}
    </header>
  )
}
