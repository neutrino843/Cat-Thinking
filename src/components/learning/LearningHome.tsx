import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import type { PersonalProviderStatus } from '@cat-thinking/analysis-contracts'
import type { DocMeta } from '../../types'
import type { CourseSnapshot } from '../../learning/model'
import { attachDocument, createCourse, listCourses, loadCourseSnapshot } from '../../learning/repository'
import { buildLearningHome, type HomeTask } from '../../learning/homeView'
import { safeLearningMessage } from '../../learning/workspaceView'
import { HttpProviderSettingsClient } from '../../analysis/providerSettingsClient'
import { listDocs, saveDocumentBundle } from '../../store/db'
import { useDoc } from '../../store/docStore'
import { useSettings } from '../../store/settings'
import { emitDocsChanged } from '../../lib/tabs'
import type { DocumentImportDraft } from '../../lib/documentImport'
import DocumentImportDialog from '../DocumentImportDialog'
import LearningWorkspace, { type LearningTarget, type LearningView } from './LearningWorkspace'
import { useLearningClock } from './useLearningClock'
import '../../study.css'

type Destination = 'home' | 'materials' | 'practice' | 'knowledge' | 'exam' | 'backup' | 'records'
const DESTINATIONS: { id: Destination; label: string; icon: string }[] = [
  { id: 'home', label: '今日学习', icon: 'home' }, { id: 'materials', label: '我的课程', icon: 'book' },
  { id: 'practice', label: '练习与复习', icon: 'practice' }, { id: 'knowledge', label: '知识结构', icon: 'graph' },
  { id: 'exam', label: '备考与应用', icon: 'calendar' }, { id: 'records', label: '学习记录', icon: 'record' },
  { id: 'backup', label: '资料与备份', icon: 'folder' },
]
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z', book: 'M12 5v15M12 5C8 2 4 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-2-10 1Z',
    practice: 'M8 3h8v4H8zM6 5H4v16h16V5h-2M8 12l2 2 5-5M8 18h8', graph: 'M9 2h6v6H9zM3 16h6v6H3zM15 16h6v6h-6zM12 8v4H6v4M12 12h6v4',
    calendar: 'M3 5h18v16H3zM7 2v6M17 2v6M3 10h18M8 14h3M14 17h3', record: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4',
    folder: 'M2 6h8l2 3h10v12H2z', spark: 'm12 2 2 7 7 3-7 2-2 8-2-8-7-2 7-3z', arrow: 'M4 12h16m-6-6 6 6-6 6', search: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16m6-2 6 6' }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.book} /></svg>
}
const TASK_NAMES = { review: '到期复习', remediation: '需要补学', prerequisite: '前置知识', new: '新学习', application: '应用验证' }
export default function LearningHome({ onEditor, onAnalysis, onSettings }: { onEditor: (docId?: string) => void; onAnalysis: () => void; onSettings: () => void }) {
  const now = useLearningClock()
  const [snapshots, setSnapshots] = useState<CourseSnapshot[]>([])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [courseId, setCourseId] = useState('')
  const [destination, setDestination] = useState<Destination>('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [target, setTarget] = useState<LearningTarget>({})
  const [provider, setProvider] = useState<PersonalProviderStatus>()
  const [draft, setDraft] = useState<DocumentImportDraft>()
  const [importing, setImporting] = useState(false)
  const importLock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const dark = useSettings((settings) => settings.dark)
  const toggleDark = useSettings((settings) => settings.toggleDark)
  const currentDocId = useDoc((state) => state.doc.id)
  useEffect(() => {
    let live = true
    const subscription = liveQuery(async () => {
      const courses = await listCourses()
      return { snapshots: await Promise.all(courses.map((course) => loadCourseSnapshot(course.id))), docs: await listDocs() }
    }).subscribe({ next: (value) => { if (live) { setSnapshots(value.snapshots); setDocs(value.docs); setLoading(false) } },
      error: (reason: unknown) => { if (live) { setError(safeLearningMessage(reason)); setLoading(false) } } })
    return () => { live = false; subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    const navigateToTarget = (event: Event) => {
      const detail = (event as CustomEvent<LearningTarget>).detail
      setTarget({ ...detail, view: detail?.view ?? 'knowledge' }); setDestination(detail?.view === 'practice' ? 'practice' : 'knowledge')
    }
    window.addEventListener('msz:home-learning-target', navigateToTarget)
    return () => window.removeEventListener('msz:home-learning-target', navigateToTarget)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const client = new HttpProviderSettingsClient()
    const refresh = () => { void client.status(controller.signal).then(setProvider).catch(() => { if (!controller.signal.aborted) setProvider(undefined) }) }
    refresh(); window.addEventListener('cat-thinking:ai-settings-changed', refresh)
    return () => { controller.abort(); window.removeEventListener('cat-thinking:ai-settings-changed', refresh) }
  }, [])
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open], [role="dialog"]')) { event.preventDefault(); search.current?.focus() }
    }
    window.addEventListener('keydown', focusSearch); return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const home = buildLearningHome(snapshots, now, courseId, query)
  const visibleDocs = docs.filter((doc) => !query.trim() || doc.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const currentDoc = docs.find((doc) => doc.id === currentDocId)
  const open = (view: LearningView, id = courseId, extra: LearningTarget = {}) => {
    setMenuOpen(false)
    setTarget({ courseId: id || undefined, view, ...extra }); setDestination(view === 'today' || view === 'application' ? 'knowledge' : view)
  }
  const startTask = (task: HomeTask) => open(task.targetId ? 'practice' : task.type === 'application' ? 'application' : 'knowledge', task.courseId,
    { pointId: task.pointId, questionKey: task.targetId })
  const prepareFile = async (file?: File) => {
    if (!file || importLock.current) return
    importLock.current = true; setImporting(true); setError('')
    try { const { prepareDocumentImport } = await import('../../lib/documentImport'); setDraft(await prepareDocumentImport(file)) }
    catch (reason) { setError(safeLearningMessage(reason)) }
    finally { importLock.current = false; setImporting(false) }
  }
  const confirmImport = async () => {
    if (!draft) return
    await saveDocumentBundle(draft.doc, [draft.source]); useDoc.getState().openDoc(draft.doc)
    const selected = snapshots.find((snapshot) => snapshot.course.id === courseId)?.course
      ?? await createCourse({ name: draft.doc.title.slice(0, 120) || '我的第一门课程' })
    await attachDocument(selected.id, draft.doc.id)
    emitDocsChanged(); setCourseId(selected.id); setDraft(undefined)
    open('materials', selected.id)
  }
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(now)
  const firstTask = home.tasks[0]
  const primary = firstTask ? '开始今日学习' : snapshots.length ? '整理学习资料' : '导入第一份资料'
  return <div className="study-shell" data-study-home>
    <aside className="study-rail" aria-label="学习主导航">
      <a className="study-brand" href="#home" onClick={() => setDestination('home')}><svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true"><path d="M8 28V8l9 7h6l9-7v20q-12 12-24 0Z" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M14 23h2m8 0h2m-8 5 2 2 2-2" stroke="currentColor" strokeWidth="2" fill="none"/></svg><span>猫思之<small>学习，从自己的资料开始</small></span></a>
      <div className={`study-nav-disclosure ${menuOpen ? 'is-open' : ''}`}><button className="study-menu-toggle" aria-expanded={menuOpen} aria-controls="study-navigation-panel" onClick={() => setMenuOpen(!menuOpen)}>学习导航</button><div id="study-navigation-panel"><nav>{DESTINATIONS.map((item) => <button key={item.id} type="button" className={`study-nav ${destination === item.id ? 'is-active' : ''}`} aria-current={destination === item.id ? 'page' : undefined}
        onClick={() => { setMenuOpen(false); if (item.id === 'home') setDestination('home'); else open(item.id) }}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'practice' && home.reviewCount > 0 && <small>{home.reviewCount}</small>}</button>)}</nav>
      <div className="study-tools"><p>学习工具</p><button className="study-nav" onClick={() => onEditor()}><Icon name="graph"/>思维导图<small>编辑</small></button>
        <button className="study-nav" onClick={onAnalysis}><Icon name="spark"/>AI 分析</button><button className="study-nav" onClick={onSettings}><Icon name="record"/>AI 设置</button></div></div></div>
      <div className="study-local"><span className="study-local-dot"/>本地保存<small>资料与学习记录留在这台设备</small></div>
    </aside>
    <div className="study-page">
      <header className="study-top"><span className="study-product">课程学习工作台</span><label className="study-search"><Icon name="search"/><span className="sr-only">搜索课程或学习任务</span><input ref={search} value={query} onChange={(event) => { setQuery(event.target.value); setDestination('home') }} placeholder="搜索课程或学习任务"/><kbd>Ctrl K</kbd></label>
        <button className="study-icon-button" onClick={toggleDark} aria-label={dark ? '切换亮色' : '切换深色'}>{dark ? '☀' : '☾'}</button></header>
      {destination === 'home' ? <main className="study-content" aria-label="今日学习首页">
        <div className="study-heading"><div><p className="study-date">{date}</p><h1>今日学习</h1><p>从上次停下的地方，继续理解、练习与回查。</p></div><button className="study-button" disabled={importing} onClick={() => input.current?.click()}>{importing ? '正在读取资料…' : '导入资料'}<span>＋</span></button></div>
        {error && <p className="study-alert" role="alert">{error}</p>}
        {loading && <p role="status" className="study-status">正在读取课程与学习记录…</p>}
        <div className="study-layout">
          <div className="study-primary-column">
            <section className="study-focus" aria-label="今日学习安排">
              <div className="study-focus-copy"><span className="study-label">{home.plannedCount ? '今天的下一步' : '给资料一个学习目标'}</span><h2>{firstTask?.title ?? (snapshots.length ? '把已有资料，整理成能反复练习的知识。' : '先带来一份课程资料。')}</h2>
                <p>{firstTask?.recommendationReason ?? '导入讲义或笔记，检查原文，再选择需要的 AI 内容。保存到课程后，就能继续练习与复习。'}</p>
                <button className="study-button study-button-primary" disabled={loading || importing} onClick={() => firstTask ? startTask(firstTask) : snapshots.length ? open('materials') : input.current?.click()}>{primary}<Icon name="arrow"/></button>
              </div><div className="study-focus-summary"><span>{firstTask?.courseName ?? '你的课程资料'}</span><strong>{home.plannedCount}<small>项建议</small></strong><p>{home.minutes > 0 ? `预计 ${home.minutes} 分钟 · 可在课程中调整` : '有了资料，再安排今天的学习'}</p></div>
            </section>
            <dl className="study-facts"><div><dt>到期复习</dt><dd>{home.reviewCount}<small>项</small></dd></div><div><dt>需要补学</dt><dd>{home.remediationCount}<small>项</small></dd></div><div><dt>今日已提交</dt><dd>{home.submittedToday}<small>次练习</small></dd></div></dl>
            <section className="study-tasks" aria-label="学习任务"><div className="study-section-head"><h2>先做这些</h2><label>课程<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">全部课程</option>{snapshots.map((snapshot) => <option key={snapshot.course.id} value={snapshot.course.id}>{snapshot.course.name}</option>)}</select></label></div>
              {home.tasks.length ? <ol className="study-task-list">{home.tasks.slice(0, 5).map((task) => <li key={`${task.courseId}:${task.id}`}><span className={`study-task-type type-${task.type}`}>{TASK_NAMES[task.type]}</span><div><h3>{task.title}</h3><p>{task.courseName} · {task.recommendationReason}</p></div><span className="study-estimate">{task.estimatedMinutes} 分钟</span><button className="study-icon-button" aria-label={`开始学习：${task.title}`} onClick={() => startTask(task)}><Icon name="arrow"/></button></li>)}</ol>
                : <div className="study-empty-row"><Icon name="practice"/><div><h3>{query ? '没有匹配的学习任务' : '今天还没有可安排的任务'}</h3><p>{query ? '换一个课程名或知识点试试。' : '把分析结果保存到课程，确认知识点和题目后，这里会给出下一步。'}</p></div></div>}
              {home.deferred > 0 && <button className="study-text-button" onClick={() => open('today')}>还有 {home.deferred} 项待安排，查看原因</button>}
            </section>
            <section className="study-courses" aria-label="我的课程概览"><div className="study-section-head"><h2>我的课程</h2><button className="study-text-button" onClick={() => open('materials')}>管理课程<Icon name="arrow"/></button></div>
              {home.courses.length ? <div className="study-course-list">{home.courses.map((row) => <button className="study-course-row" key={row.course.id} onClick={() => open('knowledge', row.course.id)}><span className="study-course-mark"><Icon name="book"/></span><span><strong>{row.course.name}</strong><small>{row.course.goal || '从已保存资料继续学习'}</small></span><span className="study-course-count">{row.archiveCount} 份学习资料 · {row.confirmedPoints} 个已确认知识点</span><Icon name="arrow"/></button>)}</div>
                : <div className="study-empty-row"><Icon name="book"/><div><h3>{query ? '没有匹配的课程' : '先创建你的第一门课程'}</h3><p>一门课程可以收纳多份资料、知识结构与历次练习。</p></div><button className="study-button" onClick={() => open('materials')}>创建课程</button></div>}
            </section>
          </div>
          <aside className="study-side-column" aria-label="继续学习与学习方法">
            <section className="study-companion"><Icon name="spark"/><h2>让 AI 帮你整理，<br/>让练习检验理解。</h2><p>从自己的原文开始。先试着回答，再看参考答案，最后回到依据核对。</p><ol><li><span>整理</span>资料与原文依据</li><li><span>理解</span>知识结构与联系</li><li><span>练习</span>先答，再回查</li><li><span>复习</span>下次继续验证</li></ol><button className="study-text-button" onClick={onAnalysis}>选择 AI 学习内容<Icon name="arrow"/></button></section>
            <section className="study-continue"><h2>继续上次整理</h2><p>{currentDoc?.title ?? '还没有打开的文档'}</p><button className="study-text-button" onClick={() => onEditor(currentDoc?.id)}>打开思维导图<Icon name="arrow"/></button></section>
            <section className="study-connection"><span className={`study-connection-dot ${provider?.enabled ? 'connected' : ''}`}/><div><strong>{provider?.enabled ? '模型已连接' : '准备 AI 连接'}</strong><p>{provider?.enabled ? provider.modelId : '已有内容可先阅读与练习'}</p></div><button className="study-text-button" onClick={onSettings}>设置</button></section>
          </aside>
        </div>
        {visibleDocs.length > 0 && <section className="study-document-strip"><h2>资料与笔记</h2><div>{visibleDocs.slice(0, 4).map((doc) => <button className="study-text-button" key={doc.id} onClick={() => onEditor(doc.id)}><Icon name="folder"/><span>{doc.title}</span></button>)}</div></section>}
        <footer className="study-footer"><span>已有资料的阅读、练习与复习不新增模型调用。</span><button className="study-text-button" onClick={() => open('backup')}>备份资料与学习进度</button></footer>
      </main> : <main className="study-module"><LearningWorkspace key={`${target.courseId}:${target.view}:${target.pointId}:${target.questionKey}`} initialTarget={target} inline onClose={() => setDestination('home')}/></main>}
    </div>
    <input className="sr-only" ref={input} type="file" accept=".txt,.md,.markdown,.docx,.pdf" aria-label="导入课程资料" onChange={(event) => { void prepareFile(event.target.files?.[0]); event.target.value = '' }}/>
    {draft && <DocumentImportDialog draft={draft} onClose={() => setDraft(undefined)} onConfirm={confirmImport}/>}
  </div>
}
