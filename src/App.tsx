import './desk.css'
import './study.css'
import './focus.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import PresentOverlay from './components/PresentOverlay'
import BackupBanner from './components/BackupBanner'
import { navigate, useDoc } from './store/docStore'
import { useSettings } from './store/settings'
import { searchRef } from './store/refs'
import { LAST_KEY, listDocs, loadDoc, saveDoc, sweepTrash } from './store/db'
import { schedulePersist } from './store/persist'
import { buildDoc, findTpl } from './data/templates'
import { buildSlides } from './lib/presentation'
import { quickSaveCurrent } from './lib/fileHandle'
import { restoreTabIds } from './lib/tabs'
import { openDocById } from './lib/tabs'
import type { LearningTarget } from './components/learning/LearningWorkspace'
import { executeNodeCommand, nodeCommandForKey } from './lib/nodeKeyboard'

const Toolbar = lazy(() => import('./components/Toolbar'))
const Sidebar = lazy(() => import('./components/Sidebar'))
const Canvas = lazy(() => import('./components/Canvas'))
const Gantt = lazy(() => import('./components/Gantt'))
const Outline = lazy(() => import('./components/Outline'))
const NodeSourcePanel = lazy(() => import('./components/NodeSourcePanel'))
const Palette = lazy(() => import('./components/Palette'))
const Tabs = lazy(() => import('./components/Tabs'))
const LearningHome = lazy(() => import('./components/learning/LearningHome'))
const GuideCompanion = lazy(() => import('./onboarding/GuideCompanion'))

function AnalysisLoadState({ onClose, failed = false, settings = false }: { onClose: () => void; failed?: boolean; settings?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog className="analysis-panel" ref={dialog} data-analysis-panel aria-label={settings ? 'AI 设置加载中' : failed ? 'AI 分析加载失败' : 'AI 分析加载中'} onCancel={onClose}>
    <div className="analysis-body"><p role={failed ? 'alert' : 'status'}>{failed ? 'AI 面板加载失败，请关闭后刷新页面重试。' : settings ? '正在打开 AI 设置…' : '正在打开 AI 分析…'}</p><button className="tbtn" onClick={onClose}>关闭加载提示</button></div>
  </dialog>
}

function AnalysisLoadFailure({ onClose }: { onClose: () => void }) {
  return <AnalysisLoadState onClose={onClose} failed />
}

function AISettingsLoadFailure({ onClose }: { onClose: () => void }) {
  return <AnalysisLoadState onClose={onClose} failed settings />
}

const AnalysisResultsPanel = lazy(() => import('./components/AnalysisResultsPanel').catch(() => ({ default: AnalysisLoadFailure })))
const AISettingsPanel = lazy(() => import('./components/AISettingsPanel').catch(() => ({ default: AISettingsLoadFailure })))
const LearningWorkspace = lazy(() => import('./components/learning/LearningWorkspace'))

/** 初始化单飞锁（模块级）：StrictMode 双 effect / 未来任何双挂载时 init 只执行一次 */
let initPromise: Promise<void> | null = null

export default function App() {
  const [conceptMap, setConceptMap] = useState(false)
  const [screen, setScreen] = useState<'home' | 'editor'>(() => window.location.hash === '#mindmap' ? 'editor' : 'home')
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const dark = useSettings((s) => s.dark)
  const sidebar = useSettings((s) => s.sidebar)
  const outline = useSettings((s) => s.outline)
  const view = useSettings((s) => s.view)
  const presenting = useSettings((s) => s.presenting)
  const fsEntered = useRef(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [learningPreparation, setLearningPreparation] = useState(false)
  const [aiSettingsProvider, setAISettingsProvider] = useState<'mobilecloud' | undefined>(() => new URLSearchParams(window.location.search).get('connect') === 'mobilecloud' ? 'mobilecloud' : undefined)
  const [aiSettingsOpen, setAISettingsOpen] = useState(() => new URLSearchParams(window.location.search).get('connect') === 'mobilecloud')
  const [learningOpen, setLearningOpen] = useState(false)
  const [learningTarget, setLearningTarget] = useState<LearningTarget>({})
  useEffect(() => {
    const route = () => setScreen(window.location.hash === '#mindmap' ? 'editor' : 'home')
    window.addEventListener('hashchange', route)
    return () => window.removeEventListener('hashchange', route)
  }, [])
  // v2.1 需求1：首页入口准备好欢迎教程后，通过该事件统一回到学习首页
  useEffect(() => {
    const goHome = () => { setScreen('home'); window.location.hash = 'home' }
    window.addEventListener('msz:open-home', goHome)
    return () => window.removeEventListener('msz:open-home', goHome)
  }, [])
  const openEditor = (id?: string) => {
    void (async () => { if (id) await openDocById(id); setScreen('editor'); window.location.hash = 'mindmap' })()
  }
  const openHome = () => { setScreen('home'); window.location.hash = 'home' }
  const learningOrigin = useRef<{ docId: string; selection: string[]; view: 'mind' | 'gantt'; viewport?: import('./lib/viewport').View; gantt?: { left: number; top: number } } | null>(null)
  const learningTrigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      if (window.location.hash === '#mindmap' && !learningOrigin.current) {
        const doc = useDoc.getState(); const view = useSettings.getState().view
        const gantt = document.querySelector<HTMLElement>('.gantt-right')
        const origin = { docId: doc.doc.id, selection: [...doc.selection], view, gantt: gantt ? { left: gantt.scrollLeft, top: gantt.scrollTop } : undefined, viewport: undefined as import('./lib/viewport').View | undefined }
        window.dispatchEvent(new CustomEvent('msz:capture-learning-viewport', { detail: (value: import('./lib/viewport').View) => { origin.viewport = value } }))
        learningOrigin.current = origin
      }
      learningTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const detail = (event as CustomEvent<typeof learningTarget>).detail
      setLearningTarget(detail && typeof detail === 'object' ? detail : {})
      setAnalysisOpen(false); setAISettingsOpen(false); setLearningOpen(true)
      if (window.location.hash !== '#mindmap') {
        setLearningOpen(false)
        window.dispatchEvent(new CustomEvent('msz:home-learning-target', { detail: detail && typeof detail === 'object' ? detail : {} }))
      }
    }
    window.addEventListener('msz:learning-open', open)
    return () => window.removeEventListener('msz:learning-open', open)
  }, [])
  const closeLearning = () => {
    const origin = learningOrigin.current; learningOrigin.current = null
    if (origin) void (async () => {
      if (useDoc.getState().doc.id !== origin.docId && await loadDoc(origin.docId)) await openDocById(origin.docId)
      const doc = useDoc.getState(); if (doc.doc.id !== origin.docId) return
      doc.select(origin.selection.filter((id) => !!doc.doc.nodes[id])); useSettings.getState().setView(origin.view)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (origin.viewport) window.dispatchEvent(new CustomEvent('msz:restore-learning-viewport', { detail: origin.viewport }))
        const gantt = document.querySelector<HTMLElement>('.gantt-right'); const list = document.querySelector<HTMLElement>('.gantt-left')
        if (origin.gantt && gantt) { gantt.scrollLeft = origin.gantt.left; gantt.scrollTop = origin.gantt.top; if (list) list.scrollTop = origin.gantt.top }
      }))
    })()
    setLearningOpen(false)
    requestAnimationFrame(() => {
      if (document.querySelector('dialog[open]')) return
      if (learningTrigger.current?.isConnected) learningTrigger.current.focus()
      else document.querySelector<HTMLElement>('[data-learning-trigger]')?.focus()
    })
  }
  useEffect(() => {
    const openAnalysis = () => { setConceptMap(false); setLearningPreparation(true); setLearningOpen(false); setAISettingsOpen(false); setAnalysisOpen(true) }
    window.addEventListener('msz:learning-close-for-analysis', openAnalysis)
    return () => window.removeEventListener('msz:learning-close-for-analysis', openAnalysis)
  }, [])
  const aiSettingsTrigger = useRef<HTMLElement | null>(null)
  const openAISettings = () => {
    aiSettingsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAnalysisOpen(false)
    setAISettingsProvider(undefined)
    setAISettingsOpen(true)
  }
  const closeAISettings = () => {
    setAISettingsOpen(false)
    setAISettingsProvider(undefined)
    const url = new URL(window.location.href)
    if (url.searchParams.has('connect')) { url.searchParams.delete('connect'); window.history.replaceState(window.history.state, '', url) }
    const trigger = aiSettingsTrigger.current
    requestAnimationFrame(() => {
      if (document.querySelector('dialog[open]')) return
      if (trigger?.isConnected) trigger.focus()
      else document.querySelector<HTMLElement>('[data-ai-settings-trigger]')?.focus()
    })
  }
  const docId = useDoc((s) => s.doc.id)

  /* 初始化（模块级单飞，保证幂等）：打开最近文档，没有则建「欢迎」导图；启动清扫回收站。
   * 单飞是为了消除 React StrictMode（dev）双 effect 下「listDocs 为空 → saveDoc」的
   * check-then-act 竞态——否则空库首启会建两篇 welcome（M6 P5 E2E 发现）。 */
  useEffect(() => {
    if (!initPromise) {
      initPromise = (async () => {
        // fire-and-forget：清扫不阻塞首屏，失败仅记日志
        sweepTrash().catch((e) => console.error('[猫思之] 回收站清扫失败', e))
        let metas = await listDocs().catch(() => [])
        if (!metas.length) {
          const d = buildDoc(findTpl('welcome'))
          await saveDoc(d)
          metas = await listDocs()
        }
        const lastId = localStorage.getItem(LAST_KEY)
        // M11：优先恢复标签条（localStorage msz.openTabs，已剔除库中不存在的 id）
        const tabIds = await restoreTabIds().catch((): string[] => [])
        if (tabIds.length) {
          const activeId = lastId && tabIds.includes(lastId) ? lastId : tabIds[0]
          const doc = (await loadDoc(activeId).catch(() => null)) ?? (await loadDoc(tabIds[0]).catch(() => null))
          if (doc) {
            useDoc.getState().openDoc(doc, { tabs: tabIds })
            return
          }
        }
        const doc =
          (lastId ? await loadDoc(lastId) : null) ??
          (metas[0] ? await loadDoc(metas[0].id) : null) ??
          buildDoc(findTpl('welcome'))
        useDoc.getState().openDoc(doc, { tabs: [doc.id] })
      })()
    }
    let cancelled = false
    initPromise
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((e) => {
        // 初始化失败：复位单飞锁允许下次重试，不能让 rejected promise 永久卡死 ready
        console.error('[猫思之] 初始化失败', e)
        initPromise = null
      })
    return () => {
      cancelled = true
    }
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
      if (screen !== 'editor') return
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
      if (t?.closest('[data-analysis-panel], [data-learning-workspace], [data-node-details], [role="dialog"], dialog, [contenteditable="true"]')) return
      const mod = e.ctrlKey || e.metaKey
      const s = useDoc.getState()
      const key = e.key.toLowerCase()
      /* M10：Ctrl/Cmd+S 必须在输入框早退之前处理——编辑节点/标题时也要拦截浏览器保存对话框。
         画布节点文本在 Enter/blur 时才提交入 store，故保存前先 blur 当前编辑控件，
         让 onBlur 同步提交 DOM 中的最新值，避免存出未落盘的旧文档。 */
      if (mod && key === 's') {
        e.preventDefault()
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) t.blur()
        void quickSaveCurrent()
          .then((r) => {
            if (r === 'unsupported') {
              window.alert(
                '当前浏览器不支持直接保存 .msz 文件（需 Chrome/Edge 100+）。\n可使用「导出 ▸ JSON」备份。',
              )
            }
          })
          .catch((err) => window.alert('保存 .msz 失败：' + (err as Error).message))
        return
      }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') t.blur()
        return
      }
      if (mod && key === 'k') {
        e.preventDefault()
        const st = useSettings.getState()
        st.setPalette(!st.paletteOpen)
        return
      }
      /* M10：Ctrl/Cmd+S 已在输入框早退之前统一处理（见上方） */
      if (mod && key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
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
      // Structure keys belong to the focused graph, never toolbar buttons/forms.
      if (!t?.closest('.canvas-wrap, .outline')) return
      if (e.repeat && ['Tab', 'Enter'].includes(e.key)) { e.preventDefault(); return }
      const command = nodeCommandForKey(e)
      if (command) { e.preventDefault(); executeNodeCommand(command, id); return }
      const nodes = s.doc.nodes
      switch (e.key) {
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
  }, [screen])

  if (!ready) return <div className="loading">纸张准备中…</div>

  return (
    <div className={'app' + (screen === 'home' && !presenting ? ' study-app' : '') + (presenting ? ' presenting' : '')}>
      {screen === 'home' && !presenting ? <Suspense fallback={<div className="loading">正在打开学习首页…</div>}><LearningHome onEditor={openEditor} onAnalysis={() => { setConceptMap(false); setLearningPreparation(false); setAISettingsOpen(false); setAnalysisOpen(true) }} onSettings={openAISettings}/></Suspense>
        : <Suspense fallback={<div className="loading">正在打开思维导图工具…</div>}>
      {!presenting && <Toolbar query={query} setQuery={setQuery} onAnalysis={() => { setConceptMap(false); setLearningPreparation(false); setAISettingsOpen(false); setAnalysisOpen(true) }} onAISettings={openAISettings} onHome={openHome} />}
      {!presenting && <Tabs />}
      {!presenting && <BackupBanner />}
      <div className="main">
        {!presenting && sidebar && <Sidebar />}
        {presenting || view === 'mind' ? <Canvas query={query} /> : <Gantt />}
        {!presenting && view === 'mind' && outline && <Outline />}
        {!presenting && view === 'mind' && <NodeSourcePanel onConceptMap={() => { setConceptMap(true); setLearningPreparation(false); setAISettingsOpen(false); setAnalysisOpen(true) }} />}
      </div>
      {!presenting && <Palette />}
      {presenting && <PresentOverlay />}
      </Suspense>}
      {!presenting && analysisOpen && (
        <Suspense fallback={<AnalysisLoadState onClose={() => setAnalysisOpen(false)} />}>
          <AnalysisResultsPanel key={`${docId}:${learningPreparation}:${conceptMap}`} docId={docId} learningPreparation={learningPreparation} conceptMap={conceptMap} onClose={() => { setAnalysisOpen(false); setConceptMap(false) }} onOpenSettings={openAISettings} />
        </Suspense>
      )}
      {!presenting && aiSettingsOpen && (
        <Suspense fallback={<AnalysisLoadState settings onClose={closeAISettings} />}>
          <AISettingsPanel initialProvider={aiSettingsProvider} onClose={closeAISettings} onConnected={() => window.dispatchEvent(new Event('cat-thinking:ai-settings-changed'))} />
        </Suspense>
      )}
      {!presenting && learningOpen && (
        <Suspense fallback={<AnalysisLoadState onClose={closeLearning} />}>
          <LearningWorkspace initialTarget={learningTarget} onClose={closeLearning} />
        </Suspense>
      )}
      {!presenting && <Suspense fallback={null}><GuideCompanion /></Suspense>}
    </div>
  )
}
