import { useEffect, useRef, useState } from 'react'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import Canvas from './components/Canvas'
import Gantt from './components/Gantt'
import Outline from './components/Outline'
import Palette from './components/Palette'
import PresentOverlay from './components/PresentOverlay'
import { navigate, useDoc } from './store/docStore'
import { useSettings } from './store/settings'
import { searchRef } from './store/refs'
import { LAST_KEY, listDocs, loadDoc, saveDoc } from './store/db'
import { schedulePersist } from './store/persist'
import { buildDoc, findTpl } from './data/templates'
import { buildSlides } from './lib/presentation'

export default function App() {
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const dark = useSettings((s) => s.dark)
  const sidebar = useSettings((s) => s.sidebar)
  const outline = useSettings((s) => s.outline)
  const view = useSettings((s) => s.view)
  const presenting = useSettings((s) => s.presenting)
  const fsEntered = useRef(false)

  /* 初始化：打开最近文档，没有则建「欢迎」导图 */
  useEffect(() => {
    ;(async () => {
      let metas = await listDocs().catch(() => [])
      if (!metas.length) {
        const d = buildDoc(findTpl('welcome'))
        await saveDoc(d)
        metas = await listDocs()
      }
      const lastId = localStorage.getItem(LAST_KEY)
      const doc =
        (lastId ? await loadDoc(lastId) : null) ??
        (metas[0] ? await loadDoc(metas[0].id) : null) ??
        buildDoc(findTpl('welcome'))
      useDoc.getState().loadDoc(doc)
      setReady(true)
    })()
  }, [])

  /* 自动保存订阅 */
  useEffect(
    () =>
      useDoc.subscribe((s, prev) => {
        if (s.doc !== prev.doc && s.doc.id) schedulePersist(s.doc)
      }),
    [],
  )

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  /* 演示模式：全屏进入/退出（best-effort，失败不影响覆盖层） */
  useEffect(() => {
    const start = () => {
      useSettings.getState().startPresenting()
      try {
        const p = document.documentElement.requestFullscreen?.()
        if (p) p.then(() => (fsEntered.current = true)).catch(() => (fsEntered.current = false))
      } catch {
        fsEntered.current = false
      }
    }
    const onFsChange = () => {
      const st = useSettings.getState()
      // 浏览器 Esc 退出全屏时一并退出演示（仅当确实是我们主动进入的全屏）
      if (st.presenting && !document.fullscreenElement && fsEntered.current) {
        fsEntered.current = false
        st.exitPresenting()
      }
    }
    window.addEventListener('msz:present', start)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      window.removeEventListener('msz:present', start)
      document.removeEventListener('fullscreenchange', onFsChange)
    }
  }, [])

  /* 全局快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return

      /* 演示模式翻页（优先级最高） */
      if (useSettings.getState().presenting) {
        const ps = useSettings.getState()
        const total = buildSlides(useDoc.getState().doc).length
        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowDown':
          case 'PageDown':
          case ' ':
            e.preventDefault()
            if (ps.slide < total - 1) ps.nextSlide()
            return
          case 'ArrowLeft':
          case 'ArrowUp':
          case 'PageUp':
            e.preventDefault()
            ps.prevSlide()
            return
          case 'Home':
            e.preventDefault()
            ps.setSlide(0)
            return
          case 'End':
            e.preventDefault()
            ps.setSlide(total - 1)
            return
          case 'Escape':
            e.preventDefault()
            ps.exitPresenting()
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
            return
        }
        return
      }

      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') t.blur()
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const s = useDoc.getState()
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        const st = useSettings.getState()
        st.setPalette(!st.paletteOpen)
        return
      }
      if (mod && key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        s.redo()
        return
      }
      if (mod && key === 'c') {
        s.copySel()
        return
      }
      if (mod && key === 'x') {
        s.copySel()
        s.removeNodes(s.selection)
        return
      }
      if (mod && key === 'v') {
        s.paste()
        return
      }
      if (!s.selection.length) return
      const id = s.selection[0]
      const nodes = s.doc.nodes
      switch (e.key) {
        case 'Tab':
          e.preventDefault()
          s.addChild(id)
          break
        case 'Enter':
          e.preventDefault()
          if (id === s.doc.rootId) s.addChild(id)
          else s.addSibling(id)
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          s.removeNodes(s.selection)
          break
        case ' ':
          e.preventDefault()
          s.toggleCollapse(id)
          break
        case 'F2':
          e.preventDefault()
          s.beginEdit()
          s.setEditing({ id, source: 'canvas' })
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          if (e.altKey) {
            s.moveOrder(id, e.key === 'ArrowUp' ? -1 : 1)
            break
          }
          const t = navigate(nodes, id, e.key === 'ArrowUp' ? 'up' : 'down')
          if (t) s.select([t])
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const t = navigate(nodes, id, 'left')
          if (t) s.select([t])
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          const t = navigate(nodes, id, 'right')
          if (t) s.select([t])
          break
        }
        case 'Escape':
          s.clearSel()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) return <div className="loading">纸张准备中…</div>

  return (
    <div className={'app' + (presenting ? ' presenting' : '')}>
      {!presenting && <Toolbar query={query} setQuery={setQuery} />}
      <div className="main">
        {!presenting && sidebar && <Sidebar />}
        {presenting || view === 'mind' ? <Canvas query={query} /> : <Gantt />}
        {!presenting && view === 'mind' && outline && <Outline />}
      </div>
      {!presenting && <Palette />}
      {presenting && <PresentOverlay />}
    </div>
  )
}
