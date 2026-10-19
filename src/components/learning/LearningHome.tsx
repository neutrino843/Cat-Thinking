import { useAchievementShelf } from '../../learning/achievementShelf'
import AchievementDesk from './AchievementDesk'
import { learningAchievements } from '../../learning/achievements'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import type { PersonalProviderStatus } from '@cat-thinking/analysis-contracts'
import type { DocMeta } from '../../types'
import type { CourseSnapshot } from '../../learning/model'
import { attachDocument, createCourse, listCourses, listUnarchivedAnalyses, loadCourseSnapshot, saveEntity } from '../../learning/repository'
import { buildLearningHome, type HomeTask } from '../../learning/homeView'
import { decideHomePrimary } from '../../learning/decideHomePrimary'
import { safeLearningMessage, visibleQuestions } from '../../learning/workspaceView'
import { HttpProviderSettingsClient } from '../../analysis/providerSettingsClient'
import { db, listDocs, saveDocumentBundle } from '../../store/db'
import { useDoc } from '../../store/docStore'
import { useSettings } from '../../store/settings'
import { emitDocsChanged } from '../../lib/tabs'
import { openLatestTutorial } from '../../lib/tutorial'
import type { DocumentImportDraft } from '../../lib/documentImport'
import { importQueue, type ImportTask } from '../../lib/importQueue'
import DocumentImportDialog from '../DocumentImportDialog'
import PostImportChoice from './PostImportChoice'
import { guideImportProblem, guidePreview, guideRead, guideSaved, resumeGuide, startGuide, useGuide } from '../../onboarding/guide'
import { migrateFromGuideV1, onboardingDone, useOnboarding } from '../../onboarding/onboarding'
import OnboardingChecklist from '../../onboarding/OnboardingChecklist'
import GuideStudy from '../../onboarding/GuideStudy'
import { focusTask } from '../../learning/focusHome'
import { EXPERIENCE_KEY, refreshExperience, saveExperience, START_CHOICES, useExperience } from '../../learning/experiencePreferences'
import ExperienceSettings, { StudyModeChoice } from './ExperienceSettings'
import StudyDialog from './StudyDialog'
import { sha256Hex } from '../../analysis/fingerprint'
import LearningWorkspace, { type LearningTarget, type LearningView } from './LearningWorkspace'
import { useLearningClock } from './useLearningClock'
import { loadPersonalCapacity, savePersonalCapacity } from '../../learning/preferences'
import { createFocusedSession as createGuidedSession, resumableSessions, sessionStepIndex } from '../../learning/session'
import { createExampleCourse } from '../../learning/exampleCourse'
import { clearTodayPlanPreference, loadTodayPlanPreferences, saveTodayPlanPreference, TODAY_PLAN_PREFERENCES_KEY, todayPlanActionFor, type TodayPlanAction } from '../../learning/todayPlanPreferences'
import { startReadingJourney, startRemediationJourney } from '../../learning/learningLoop'
import '../../study.css'

type Destination = 'home' | 'materials' | 'practice' | 'knowledge' | 'exam' | 'backup' | 'records'
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z', book: 'M12 5v15M12 5C8 2 4 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-2-10 1Z',
    practice: 'M8 3h8v4H8zM6 5H4v16h16V5h-2M8 12l2 2 5-5M8 18h8', graph: 'M9 2h6v6H9zM3 16h6v6H3zM15 16h6v6h-6zM12 8v4H6v4M12 12h6v4',
    calendar: 'M3 5h18v16H3zM7 2v6M17 2v6M3 10h18M8 14h3M14 17h3', record: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4',
    folder: 'M2 6h8l2 3h10v12H2z', spark: 'm12 2 2 7 7 3-7 2-2 8-2-8-7-2 7-3z', search: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16m6-2 6 6',
    guide: 'M12 6c-2-1.3-4.5-2-7-2v14c2.5 0 5 .7 7 2 2-1.3 4.5-2 7-2V4c-2.5 0-5 .7-7 2zM12 6v14' }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.book} /></svg>
}
const TASK_NAMES = { review: '到期复习', remediation: '需要补学', prerequisite: '前置知识', new: '新学习', application: '应用验证' }
/** v2.1 需求1：首启欢迎引导卡片的已见标记（跟随现有本地偏好的读写兜底风格） */
const WELCOME_DISMISSED_KEY = 'msz.welcome.dismissed.v1'
const readWelcomeDismissed = () => {
  try { return localStorage.getItem(WELCOME_DISMISSED_KEY) === '1' } catch { return false }
}
/** 导入队列 phase 对应的界面文案；进度 detail（如「第 3/20 页」）存在时优先展示。 */
const IMPORT_PHASE_LABELS = { reading: '正在读取资料…', parsing: '正在解析资料…', structuring: '正在生成导图结构…' } as const
export default function LearningHome({ onEditor, onAnalysis, onSettings }: { onEditor: (docId?: string) => void; onAnalysis: () => void; onSettings: () => void }) {
  const now = useLearningClock()
  const { preferences: experience, error: preferenceError } = useExperience()
  const guideProgress = useGuide((state) => state.progress)
  useOnboarding((state) => state.progress) // subscribe to onboarding store
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [achievementsOpen, setAchievementsOpen] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [replacement, setReplacement] = useState<{ docId: string; courseId: string } | null>(null)
  const [choosingContent, setChoosingContent] = useState(false)
  const [studyClosed, setStudyClosed] = useState(() => guideProgress.status === 'completed' ? guideProgress.sessionId : '')
  const [pendingDocId, setPendingDocId] = useState(() => { try { return localStorage.getItem('msz.learning.pending-document.v1') ?? '' } catch { return '' } })
  const contentChoice = useRef<HTMLElement>(null)

  const [snapshots, setSnapshots] = useState<CourseSnapshot[]>([])
  useEffect(() => { useAchievementShelf.setState({ resting: !!learningAchievements(snapshots).find((item) => item.id === 'return')?.evidence }) }, [snapshots])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [sourceDocIds, setSourceDocIds] = useState<string[]>([])
  const [unarchivedAnalyses, setUnarchivedAnalyses] = useState<{ docId: string; runId: string; title: string; updatedAt: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [courseId, setCourseId] = useState('')
  const [destination, setDestination] = useState<Destination>('home')
  useEffect(() => {
    const reopen = () => { setStudyClosed(''); setDestination('home') }
    const changed = (event: StorageEvent) => { if (event.key === EXPERIENCE_KEY || event.key === null) refreshExperience() }
    window.addEventListener('msz:guide-study-open', reopen); window.addEventListener('storage', changed)
    return () => { window.removeEventListener('msz:guide-study-open', reopen); window.removeEventListener('storage', changed) }
  }, [])
  const [menuOpen, setMenuOpen] = useState(false)
  const [target, setTarget] = useState<LearningTarget>({})
  const [provider, setProvider] = useState<PersonalProviderStatus>()
  const [drafts, setDrafts] = useState<DocumentImportDraft[]>([])
  const [importTasks, setImportTasks] = useState<readonly ImportTask[]>(() => importQueue.snapshot)
  const [importing, setImporting] = useState(false)
  const [capacity, setCapacity] = useState(loadPersonalCapacity)
  const [minutes, setMinutes] = useState(() => loadPersonalCapacity().minutes)
  const [questions, setQuestions] = useState(() => loadPersonalCapacity().questions)
  const [showBacklog, setShowBacklog] = useState(false)
  const [showAllTasks, setShowAllTasks] = useState(false)
  const [welcomeDismissed, setWelcomeDismissed] = useState(readWelcomeDismissed)
  const [tutorialHintId, setTutorialHintId] = useState('')
  /** v2.1 需求4：导入归属后的三选一层；底部导图入口为内存态，刷新后消失 */
  const [postImport, setPostImport] = useState<{ docId: string; courseId: string; title: string } | null>(null)
  const guideImportActive = useGuide((state) => state.progress.status === 'active' && ['import', 'preview'].includes(state.progress.step))
  const [mindMapBar, setMindMapBar] = useState<{ docId: string; title: string } | null>(null)
  const tutorialLock = useRef(false)
  const [planPreferences, setPlanPreferences] = useState(loadTodayPlanPreferences)
  const importLock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const documentImporting = importTasks.some(({ status }) => status === 'queued' || status === 'parsing')
  const activeImportTask = importTasks.find(({ status }) => status === 'parsing')
  const documentImportLabel = activeImportTask
    ? activeImportTask.progress?.detail ?? IMPORT_PHASE_LABELS[activeImportTask.progress?.phase ?? 'parsing']
    : ''
  const dark = useSettings((settings) => settings.dark)
  const toggleDark = useSettings((settings) => settings.toggleDark)
  const currentDocId = useDoc((state) => state.doc.id)
  useEffect(() => {
    let live = true
    const subscription = liveQuery(async () => {
      const courses = await listCourses()
      return { snapshots: await Promise.all(courses.map((course) => loadCourseSnapshot(course.id))), docs: await listDocs(), sourceDocIds: (await db.sources.toArray()).filter((source) => source.text.trim()).map((source) => source.docId), unarchived: await listUnarchivedAnalyses() }
    }).subscribe({ next: (value) => { if (live) { setSnapshots(value.snapshots); setDocs(value.docs); setSourceDocIds(value.sourceDocIds); setUnarchivedAnalyses(value.unarchived); setLoading(false) } },
      error: (reason: unknown) => { if (live) { setError(safeLearningMessage(reason)); setLoading(false) } } })
    return () => { live = false; subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    const refresh = () => setPlanPreferences(loadTodayPlanPreferences())
    const storage = (event: StorageEvent) => { if (event.key === TODAY_PLAN_PREFERENCES_KEY) refresh() }
    window.addEventListener('storage', storage); window.addEventListener('msz:today-plan-changed', refresh)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('msz:today-plan-changed', refresh) }
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open], [role="dialog"]')) { event.preventDefault(); setChoosingContent(true); requestAnimationFrame(() => search.current?.focus()) }
    }
    window.addEventListener('keydown', focusSearch); return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  useEffect(() => {
    const refresh = () => { const value = loadPersonalCapacity(); setCapacity(value); setMinutes(value.minutes); setQuestions(value.questions) }
    const storage = (event: StorageEvent) => { if (event.key === 'msz.learning.capacity.v1') refresh() }
    window.addEventListener('storage', storage); window.addEventListener('msz:capacity-changed', refresh)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('msz:capacity-changed', refresh) }
  }, [])
  // 订阅导入队列：多文件导入时按钮/状态随队列进度刷新
  useEffect(() => importQueue.subscribe(setImportTasks), [])
  useEffect(() => {
    const home = () => setDestination('home')
    window.addEventListener('msz:open-home', home)
    return () => window.removeEventListener('msz:open-home', home)
  }, [])
  const personalSnapshots = snapshots.filter((snapshot) => !snapshot.course.example)
  const home = buildLearningHome(personalSnapshots, now, courseId, query, capacity, planPreferences)
  const resume = resumableSessions(personalSnapshots)[0]
  const latestJourney = personalSnapshots.flatMap((snapshot) => (snapshot.journeys ?? []).filter((journey) => journey.status !== 'completed' && !journey.blockedReason).map((journey) => ({ snapshot, journey }))).sort((a, b) => b.journey.updatedAt - a.journey.updatedAt)[0]
  const visibleDocs = docs.filter((doc) => !query.trim() || doc.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const currentDoc = docs.find((doc) => doc.id === currentDocId)
  // B4：旧版 guide v1 数据迁移到 onboarding v2
  useEffect(() => {
    migrateFromGuideV1(guideProgress.status, guideProgress.step)
  }, [guideProgress.status, guideProgress.step])
  // onboarding 任务完成联动
  useEffect(() => {
    if (guideProgress.status === 'completed') onboardingDone('first-question')
  }, [guideProgress.status])
  useEffect(() => {
    if (unarchivedAnalyses.length === 0 && personalSnapshots.some((s) => s.archives.length > 0)) onboardingDone('save-practice')
  }, [unarchivedAnalyses.length, personalSnapshots])
  const handleOnboardingAction = (target: string) => {
    if (target === 'import') input.current?.click()
    else if (target === 'guide') { startGuide(); setStudyClosed(''); setDestination('home') }
    else if (target === 'analysis') onAnalysis()
    else if (target === 'practice') open('practice')
  }
  const open = (view: LearningView, id = courseId, extra: LearningTarget = {}) => {
    setMenuOpen(false)
    setTarget({ courseId: id || undefined, view, ...extra }); setDestination(view === 'prepare' ? 'materials' : view === 'today' || view === 'application' || view === 'nodes' ? 'knowledge' : view)
  }
  const startTask = async (task: HomeTask) => {
    if (task.targetId?.startsWith('journey:')) {
      const snapshot = snapshots.find((item) => item.course.id === task.courseId)
      const journeyId = task.targetId.slice(8)
      const record = snapshot?.journeys?.find((item) => item.id === journeyId)
      if (!record?.source) { setError('回看资料已缺失，请在课程记录检查。'); return }
      try { const next = await startReadingJourney(task.courseId, record.source.docId); open('today', task.courseId, { journeyId: next.id }) } catch (err) { setError(safeLearningMessage(err)) }; return
    }
    const snapshot = personalSnapshots.find((item) => item.course.id === task.courseId)
    if (snapshot && task.type === 'remediation' && task.targetId) {
      const attempt = [...snapshot.attempts].reverse().find((item) => `${item.question.archiveId}/${item.question.artifactId}/${item.question.questionId}` === task.targetId)
      if (attempt) { try { const journey = await startRemediationJourney(snapshot, attempt.id); open('today', task.courseId, { journeyId: journey.id }) } catch (err) { setError(safeLearningMessage(err)) }; return }
    }
    const point = snapshot?.points.find((item) => item.id === task.pointId && item.status === 'active')
    if (!snapshot || !point || task.type === 'application') { open(task.type === 'application' ? 'application' : 'knowledge', task.courseId, { pointId: task.pointId }); return }
    if (experience.study === 'practice' && visibleQuestions(snapshot, point.id).length) { open('practice', task.courseId, { pointId: point.id, questionKey: task.targetId }); return }
    if (importLock.current) return
    importLock.current = true; setImporting(true)
    try {
      const existing = resumableSessions([snapshot]).find((item) => item.session.pointIds.includes(point.id))
      const candidate = createGuidedSession(snapshot, [point])
      if (!visibleQuestions(snapshot, point.id).length) candidate.steps = candidate.steps.filter((step) => step.action !== 'practice')
      const session = existing?.session ?? await saveEntity(candidate, null)
      open('knowledge', task.courseId, { pointId: point.id, sessionId: session.id })
    } catch (reason) { setError(safeLearningMessage(reason)) }
    finally { importLock.current = false; setImporting(false) }
  }
  const beginDocument = async (docId: string, requestedCourseId = '', confirmed = false) => {
    if (importLock.current) return
    importLock.current = true; setImporting(true); setError('')
    try {
      const current = useGuide.getState().progress
      if (!confirmed && current.binding && current.binding.docId !== docId && ['active', 'paused'].includes(current.status)) {
        setReplacement({ docId, courseId: requestedCourseId }); return
      }
      if (current.binding?.docId === docId && ['active', 'paused'].includes(current.status)) {
        if (current.status === 'paused') resumeGuide()
        setStudyClosed(''); setDestination('home'); return
      }
      const member = snapshots.find((item) => item.documents.some((record) => record.docId === docId))
      if (member && (current.binding?.docId === docId && current.status === 'completed' || member.archives.some((item) => item.originDocId === docId) || member.journeys?.some((item) => item.source?.docId === docId))) { open('prepare', member.course.id, { documentId: docId }); return }
      const source = (await db.sources.where('docId').equals(docId).toArray()).find((item) => item.text.trim())
      if (!source) { setError('这份资料没有保存可读取的原文，可以打开导图阅读，或导入有正文的资料。'); return }
      const doc = docs.find((item) => item.id === docId)
      const selected = snapshots.find((item) => item.course.id === requestedCourseId)?.course
        ?? snapshots.find((item) => item.documents.some((document) => document.docId === docId))?.course
        ?? await createCourse({ name: doc?.title.slice(0, 120) || '我的课程', learningMode: 'nodes' })
      await attachDocument(selected.id, docId)
      const sourceHash = await sha256Hex(source.text)
      startGuide()
      const sessionId = useGuide.getState().progress.sessionId
      if (guideSaved({ docId, sourceId: source.id, courseId: selected.id, sourceHash }, sessionId)) {
        guideRead()
        setStudyClosed(''); setDestination('home'); setCourseId(selected.id)
        if (pendingDocId === docId) { setPendingDocId(''); try { localStorage.removeItem('msz.learning.pending-document.v1') } catch { setError('入门练习已开始，待学习标记暂时无法清除。') } }
      }
    } catch (reason) { setError(safeLearningMessage(reason)) }
    finally { importLock.current = false; setImporting(false) }
  }
  const decideTask = (task: Pick<HomeTask, 'courseId' | 'id'>, action: TodayPlanAction) => {
    try { saveTodayPlanPreference(task.courseId, task.id, action, now); setError('') } catch { setError('今日任务调整无法保存，请检查浏览器存储后重试。') }
  }
  const restoreTask = (task: Pick<HomeTask, 'courseId' | 'id'>) => {
    try { clearTodayPlanPreference(task.courseId, task.id, now); setError('') } catch { setError('今日任务调整无法撤销，请检查浏览器存储后重试。') }
  }
  const prepareFiles = (files: File[]) => {
    if (!files.length) return
    if (guideImportActive && files.length > 1) { setError('这次新手引导请选择一份资料；结束引导后可以批量导入。'); return }
    setError('')
    importQueue.enqueue(files, {
      onDraft: (draft) => { setDrafts((prev) => [...prev, draft]); guidePreview() },
      onFailure: (name, message) => { setError(`${name}：${message}`); guideImportProblem() },
    })
  }
  const confirmImport = async () => {
    const draft = drafts[0]
    if (!draft) return
    const guide = useGuide.getState().progress
    const guidingImport = (guide.status === 'active' && ['import', 'preview'].includes(guide.step)) || (guide.status === 'paused' && guide.step === 'preview')
    const sourceHash = guidingImport ? await sha256Hex(draft.source.text) : ''
    await saveDocumentBundle(draft.doc, [draft.source]); useDoc.getState().openDoc(draft.doc)
    const selected = snapshots.find((snapshot) => snapshot.course.id === courseId)?.course
      ?? await createCourse({ name: draft.doc.title.slice(0, 120) || '我的第一门课程', learningMode: 'nodes' })
    await attachDocument(selected.id, draft.doc.id)
    emitDocsChanged(); setCourseId(selected.id)
    setPendingDocId(draft.doc.id)
    try { localStorage.setItem('msz.learning.pending-document.v1', draft.doc.id) } catch { setError('资料已保存，首页的待学习提示暂时无法记住。') }
    const remaining = drafts.slice(1)
    setDrafts(remaining)
    // v2.1 需求4：全部草稿确认完即记录三选一；展示时机由渲染层派生——
    // 队列仍有 queued/parsing（其他文件解析中）时延后到队列空闲，避免静默无去向。
    const guided = guidingImport && guideSaved({ docId: draft.doc.id, sourceId: draft.source.id, courseId: selected.id, sourceHash }, guide.sessionId)
    if (guided) {
      setStudyClosed(''); setDestination('home')
      guideRead()
      setPendingDocId(''); try { localStorage.removeItem('msz.learning.pending-document.v1') } catch { /* Saved source remains available. */ }
    }
    const guideInProgress = useGuide.getState().progress.status === 'active'
    if (remaining.length === 0 && !guided && !guideInProgress) setPostImport({ docId: draft.doc.id, courseId: selected.id, title: draft.doc.title })
  }
  /** 三选一分发：思维导图 / 直接学习（知识页）/ 学习首页 + 底部导图入口条 */
  const choosePostImport = (kind: 'mindmap' | 'learning' | 'home') => {
    const choice = postImport
    if (!choice) return
    setPostImport(null)
    if (kind === 'mindmap') { onEditor(choice.docId); return }
    if (kind === 'learning') { setMenuOpen(false); void beginDocument(choice.docId, choice.courseId); return }
    setMindMapBar({ docId: choice.docId, title: choice.title })
    setTarget({}); setDestination('home')
  }
  const openMindMapFromBar = () => {
    const bar = mindMapBar
    if (!bar) return
    setMindMapBar(null)
    onEditor(bar.docId)
  }
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(now)
  const firstTask = focusTask(home.tasks, experience.start)
  const visibleTasks = showAllTasks ? home.tasks : home.tasks.slice(0, 5)
  const decisionFor = (task: Pick<HomeTask, 'courseId' | 'id'>) => todayPlanActionFor(planPreferences, task.courseId, task.id, now)
  const experienceExample = async () => {
    if (importLock.current) return
    importLock.current = true; setImporting(true)
    try { const course = await createExampleCourse(); open('knowledge', course.id) } catch (reason) { setError(safeLearningMessage(reason)) }
    finally { importLock.current = false; setImporting(false) }
  }
  /** 首页「使用教程」：准备教程文档后留在学习首页，以轻提示给出查看导图的入口 */
  const openTutorialFromHome = async () => {
    if (tutorialLock.current) return
    tutorialLock.current = true; setError('')
    try { const doc = await openLatestTutorial({ to: 'home' }); setTutorialHintId(doc.id) }
    catch (reason) { setError(safeLearningMessage(reason)) }
    finally { tutorialLock.current = false }
  }
  /** 欢迎卡片「查看完整使用教程」：用户主动查阅，直接进入编辑器打开教程导图 */
  const viewFullTutorial = async () => {
    if (tutorialLock.current) return
    tutorialLock.current = true; setError('')
    try { const doc = await openLatestTutorial({ to: 'editor' }); onEditor(doc.id) }
    catch (reason) { setError(safeLearningMessage(reason)) }
    finally { tutorialLock.current = false }
  }
  const dismissWelcome = () => {
    setWelcomeDismissed(true)
    try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1') }
    catch { setError('欢迎引导的关闭标记无法保存到本机，本次仍会关闭，刷新后可能再次显示。') }
  }
  const guideCanResume = ['active', 'paused'].includes(guideProgress.status)
  const centralGuide = !!guideProgress.binding && ['read', 'question', 'complete'].includes(guideProgress.step) && studyClosed !== guideProgress.sessionId
  const pendingDoc = experience.start === 'review' && home.reviewCount > 0 ? undefined : visibleDocs.find((doc) => doc.id === pendingDocId && (!courseId || snapshots.some((snapshot) => snapshot.course.id === courseId && snapshot.documents.some((item) => item.docId === doc.id))))
  const availableDoc = pendingDoc ?? visibleDocs.find((doc) => sourceDocIds.includes(doc.id) && (!courseId || snapshots.some((snapshot) => snapshot.course.id === courseId && snapshot.documents.some((item) => item.docId === doc.id))))
  const chooseFirst = experience.start === 'course' && !courseId
  const archivedWithin24h = personalSnapshots.some((snapshot) => snapshot.archives.some((archive) => Date.now() - archive.createdAt < 24 * 3600_000))
  const hasPracticeQuestions = personalSnapshots.some((snapshot) => snapshot.points.some((point) => point.status === 'active' && visibleQuestions(snapshot, point.id).length > 0))
  const decision = decideHomePrimary({
    chooseFirst, guideCanResume, guideProgress, resume, latestJourney,
    pendingDoc, availableDoc, firstTask, personalSnapshots,
    unarchivedCount: unarchivedAnalyses.length, archivedWithin24h, hasPracticeQuestions,
  })
  const { headline, primary } = decision
  const resumeGuideFirst = guideCanResume && (!resume || guideProgress.stepAt >= resume.session.updatedAt)
  const journeyFirst = !!latestJourney && latestJourney.journey.updatedAt >= Math.max(resume?.session.updatedAt ?? 0, guideCanResume ? guideProgress.stepAt : 0)
  const recommendedResume = !chooseFirst && (experience.start !== 'review' || !home.reviewCount) && (resumeGuideFirst || !!resume || !!latestJourney)
  const mutedLabel = chooseFirst ? '你来决定' : recommendedResume ? '继续上次学习' : pendingDoc ? '新资料已保存' : decision.kind === 'save-analysis' ? '分析结果待保存' : decision.kind === 'start-practice' ? '准备开始练习' : firstTask?.courseName || '学习，从自己的资料开始'
  const heroDescription = decision.kind === 'save-analysis'
    ? `${unarchivedAnalyses.length} 份分析结果已生成，保存到课程后可以开始练习。`
    : decision.kind === 'start-practice'
      ? '分析结果已保存，来做几道题检验掌握程度。'
      : chooseFirst ? '选定课程后，这里只推荐一个下一步。'
        : recommendedResume ? (journeyFirst ? `${latestJourney?.journey.title} · 阅读位置、修正笔记和重试记录会一起恢复。` : resumeGuideFirst ? '伊希斯保留了你的入门练习，接着完成第一道题。' : `${resume?.session.title} · ${resume?.reason || '已保存的步骤和文字会一起恢复。'}`)
          : pendingDoc || (!firstTask && availableDoc) ? '先读一小段，做一道原文入门题。不用先连接 AI。'
            : firstTask ? `${experience.start === 'review' && !home.reviewCount ? '今天没有安排到期复习，可先学这一项。' : ''}${firstTask.recommendationReason}`
              : capacity.minutes === 0 || capacity.questions === 0 ? '今天的学习容量有限，可展开完整安排调整，或先阅读已有资料。' : '导入讲义或笔记，读一点，再试着回忆。'
  const chooseContent = () => { setChoosingContent(true); requestAnimationFrame(() => { contentChoice.current?.scrollIntoView({ block: 'start' }); contentChoice.current?.focus() }) }
  const resumeLast = () => {
    if (journeyFirst && latestJourney) { open('today', latestJourney.snapshot.course.id, { journeyId: latestJourney.journey.id }); return }
    if (resumeGuideFirst) { if (guideProgress.status === 'paused') resumeGuide(); setStudyClosed(''); setDestination('home'); if (!guideProgress.binding) input.current?.click() }
    else if (resume) open('knowledge', resume.snapshot.course.id, { pointId: resume.session.steps[sessionStepIndex(resume.session)].pointId, sessionId: resume.session.id })
  }
  const beginPrimary = () => {
    if (chooseFirst) { chooseContent(); return }
    if (recommendedResume) { resumeLast(); return }
    if (decision.kind === 'save-analysis') { onAnalysis(); return }
    if (decision.kind === 'start-practice') { open('practice'); return }
    if (pendingDoc) { void beginDocument(pendingDoc.id, courseId); return }
    if (firstTask) { void startTask(firstTask); return }
    if (availableDoc) { void beginDocument(availableDoc.id, courseId); return }
    input.current?.click()
  }
  return <div className="study-shell focus-shell" data-study-home>
    <header className="focus-nav">
      <a className="study-brand" href="#home" onClick={() => setDestination('home')}><svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true"><path d="M8 28V8l9 7h6l9-7v20q-12 12-24 0Z" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M14 23h2m8 0h2m-8 5 2 2 2-2" stroke="currentColor" strokeWidth="2" fill="none"/></svg><span>猫思之</span></a>
      <nav aria-label="学习主导航"><button className="study-text-button" aria-current={destination === 'home' ? 'page' : undefined} onClick={() => setDestination('home')}>学习</button><button className="study-text-button" aria-current={destination === 'materials' ? 'page' : undefined} onClick={() => open('materials')}>资料</button><div className="focus-more"><button className="study-text-button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>更多</button>{menuOpen && <StudyDialog title="更多功能" onClose={() => setMenuOpen(false)}><div className="desk-more-menu"><button onClick={() => { setMenuOpen(false); setPreferencesOpen(true) }}>学习偏好</button><button onClick={() => open('practice')}>练习与复习</button><button onClick={() => open('knowledge')}>知识结构</button><button onClick={() => open('exam')}>备考</button><button onClick={() => open('application')}>应用任务</button><button onClick={() => open('records')}>学习记录</button><button onClick={() => { setMenuOpen(false); setAchievementsOpen(true) }}>我的学习纪念</button><button onClick={() => { setMenuOpen(false); onEditor(currentDoc?.id) }}>思维导图与甘特图</button><button onClick={() => { setMenuOpen(false); void openTutorialFromHome() }}>使用教程</button><button onClick={() => { setMenuOpen(false); startGuide(); setStudyClosed(''); setDestination('home') }}>新手任务清单</button><button onClick={() => open('backup')}>资料与备份</button><button onClick={onAnalysis}>AI 分析</button><button onClick={onSettings}>AI 设置</button><button onClick={toggleDark}>{dark ? '切换亮色' : '切换深色'}</button><small>{provider?.enabled ? `模型已连接 · ${provider.modelId}` : '本地阅读与练习无需 AI 连接'}</small></div></StudyDialog>}</div></nav>
    </header>
    <div className="study-page focus-page">
      {destination === 'home' && centralGuide ? <GuideStudy onClose={() => setStudyClosed(guideProgress.sessionId)} onMaterials={() => { setStudyClosed(guideProgress.sessionId); open('prepare', guideProgress.binding?.courseId, { documentId: guideProgress.binding?.docId }) }} onReplace={() => { setStudyClosed(guideProgress.sessionId); startGuide(); input.current?.click() }}/>
        : destination === 'home' ? <main className="study-content focus-home" aria-label="今日学习首页">
          <div className="focus-home-meta"><span>{date}</span><button className="study-text-button" onClick={() => setBudgetOpen(true)}>今天的分量 · {capacity.minutes} 分钟</button><button className="study-text-button" onClick={() => setPreferencesOpen(true)}>学习偏好</button></div>
          {error && <p role="alert" className="study-alert">{error}</p>}{preferenceError && <p role="alert" className="study-alert">{preferenceError}</p>}
          {tutorialHintId && <div className="study-hint" role="status" data-tutorial-hint><span>使用教程已准备好。</span><button className="study-text-button" onClick={() => { const id = tutorialHintId; setTutorialHintId(''); onEditor(id) }}>查看教程导图</button><button className="study-text-button" onClick={() => setTutorialHintId('')}>稍后</button></div>}
          <div className="focus-start-modes" role="group" aria-label="首页开始方式">{Object.entries(START_CHOICES).map(([value, label]) => <button key={value} aria-pressed={experience.start === value} onClick={() => saveExperience({ start: value as typeof experience.start })}>{label}</button>)}</div>
          {loading ? <p role="status">正在读取课程与学习记录…</p> : <section className="focus-hero" aria-label="今天的下一步">
            <p className="focus-muted">{mutedLabel}</p><h1>{headline}</h1>
            <p className="focus-hero-description">{heroDescription}</p>
            <StudyModeChoice/>
            <div className="focus-actions"><button className="study-button study-button-primary" disabled={importing || documentImporting} data-guide={!availableDoc && !firstTask && !recommendedResume && !chooseFirst ? 'import' : undefined} onClick={beginPrimary}>{documentImporting ? documentImportLabel || '正在解析资料…' : importing ? '正在准备学习…' : primary}</button><button className="study-text-button" onClick={chooseContent}>换个内容学</button></div>
            {!personalSnapshots.length && !welcomeDismissed && <div className="focus-first-use" data-welcome-card aria-label="欢迎引导"><button className="study-text-button" onClick={() => { dismissWelcome(); startGuide(); input.current?.click() }}>开始使用 · 伊希斯带我完成第一题</button><button className="study-text-button" onClick={() => void experienceExample()}>先体验示例课程</button></div>}
          </section>}
          {!loading && !personalSnapshots.length && <OnboardingChecklist onAction={handleOnboardingAction}/>}
          <div className="focus-perch" data-isis-perch/>
          <section className="focus-choices" ref={contentChoice} tabIndex={-1} hidden={!choosingContent && !(experience.start === 'course' && !courseId)} aria-label="选择学习内容"><div className="study-section-head"><h2>今天学什么</h2><button className="study-text-button" onClick={() => setChoosingContent(false)}>收起</button></div><label>课程<select aria-label="选择学习课程" value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">全部课程</option>{personalSnapshots.map((snapshot) => <option key={snapshot.course.id} value={snapshot.course.id}>{snapshot.course.name}</option>)}</select></label><label>查找内容<input aria-label="搜索课程或学习任务" ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="课程或任务名称"/></label>
            <div className="focus-content-list">{home.tasks.slice(0, 8).map((task) => <button key={`${task.courseId}:${task.id}`} onClick={() => void startTask(task)}><strong>{task.title}</strong><small>{task.courseName} · {TASK_NAMES[task.type]}</small></button>)}{visibleDocs.filter((doc) => !courseId || snapshots.some((snapshot) => snapshot.course.id === courseId && snapshot.documents.some((item) => item.docId === doc.id))).slice(0, 8).map((doc) => <div key={doc.id}><button onClick={() => void beginDocument(doc.id, courseId)}><strong>{doc.title}</strong><small>原文入门练习 · 无需 AI</small></button><button className="study-text-button" onClick={() => onEditor(doc.id)}>阅读导图</button></div>)}</div>
            {!home.tasks.length && !visibleDocs.length && <p>这里还没有内容，可以导入资料或创建课程。</p>}
            <div className="focus-actions"><button className="study-button" disabled={documentImporting} onClick={() => input.current?.click()}>导入资料</button><button className="study-text-button" onClick={() => open('materials')}>管理与创建课程</button></div>
          </section>
          <div className="focus-home-links">{experience.rewards && <button className="study-text-button" onClick={() => setAchievementsOpen(true)}>学习纪念 · {learningAchievements(snapshots).filter((item) => item.evidence).length} / 6</button>}<button className="study-text-button" data-guide={availableDoc || firstTask || recommendedResume || chooseFirst ? 'import' : undefined} disabled={documentImporting} onClick={() => input.current?.click()}>导入资料</button><button className="study-text-button" onClick={() => open('materials')}>我的课程与资料</button><button className="study-text-button" onClick={() => { setMenuOpen(false); void viewFullTutorial() }}>使用教程</button></div>
          <details className="focus-plan"><summary>查看完整安排与学习记录 <span>{home.plannedCount} 项安排 · 今日已提交 {home.submittedToday} 次</span></summary>
            <p className="focus-plan-summary">当前安排预计 {home.minutes} 分钟，估计用时可调整，不代表实际时长。</p>
            <dl className="study-facts"><div><dt>到期复习</dt><dd>{home.reviewCount}<small>项</small></dd></div><div><dt>需要补学</dt><dd>{home.remediationCount}<small>项</small></dd></div><div><dt>今日已提交</dt><dd>{home.submittedToday}<small>次练习</small></dd></div></dl>
            {personalSnapshots.flatMap((snapshot) => (snapshot.journeys ?? []).filter((item) => item.status !== 'completed').map((journey) => <section className="learning-section" key={journey.id}><h2>{journey.mode === 'reading' ? '继续上次阅读' : '继续上次补学'}</h2><p>{journey.title} · 第 {journey.step + 1} 步</p><button className="study-button" onClick={() => open('today', snapshot.course.id, { journeyId: journey.id })}>继续这轮学习</button></section>))}
            {resume && <section className="learning-section" aria-label="继续上次学习"><h2>继续上次学习</h2><p>{resume.snapshot.course.name} · {resume.session.title}</p>{resume.reason && <p role="status">{resume.reason}</p>}<button className="study-button" onClick={() => open('knowledge', resume.snapshot.course.id, { pointId: resume.session.steps[sessionStepIndex(resume.session)].pointId, sessionId: resume.session.id })}>继续学习</button></section>}
            {guideCanResume && <button className="study-text-button" onClick={() => { if (guideProgress.status === 'paused') resumeGuide(); setStudyClosed(''); if (!guideProgress.binding) input.current?.click() }}>继续伊希斯入门引导</button>}
            <form className="learning-section learning-fields" aria-label="跨课程时间分配" onSubmit={(event) => { event.preventDefault(); try { savePersonalCapacity({ minutes, questions }); setError('') } catch { setError('时间或题数设置无法保存，请检查范围及浏览器存储。') } }}>
              <label>当天总时间（分钟）<input type="number" min="0" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
              <label>当天总题数上限<input type="number" min="0" max="1000" value={questions} onChange={(event) => setQuestions(Number(event.target.value))} /></label>
              <button className="study-button">保存当天容量</button><p>所有课程共享容量；各课程设置是分配上限。预计用时可调整，不代表实际时长。</p>
              <p>本日已预留 {home.reservedMinutes} 分钟，剩余额度 {home.remainingMinutes} 分钟；已提交 {home.reservedQuestions} 题。预留来自已开始的会话和独立练习估计，按北京时间日期计算，不是实际计时。</p>
              <div className="learning-actions">{[10, 20, 40].map((value) => <button className="tbtn" type="button" key={value} onClick={() => { try { savePersonalCapacity({ minutes: value, questions }); setError('') } catch { setError('容量设置无法保存。') } }}>{value} 分钟</button>)}</div>
            </form>
            <section className="study-tasks" aria-label="学习任务"><div className="study-section-head"><h2>先做这些</h2><label>课程<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">全部课程</option>{personalSnapshots.map((snapshot) => <option key={snapshot.course.id} value={snapshot.course.id}>{snapshot.course.name}</option>)}</select></label></div>
              {home.tasks.length ? <><ol className="study-task-list">{visibleTasks.map((task) => <li key={`${task.courseId}:${task.id}`}><span className={`study-task-type type-${task.type}`}>{TASK_NAMES[task.type]}</span><div><h3>{task.title}</h3><p>{task.courseName} · {task.recommendationReason}</p><div className="learning-actions">{decisionFor(task) === 'later' ? <button className="study-text-button" aria-label={`恢复默认排序：${task.courseName} · ${task.title}`} onClick={() => restoreTask(task)}>恢复默认排序</button> : <button className="study-text-button" aria-label={`稍后做：${task.courseName} · ${task.title}`} onClick={() => decideTask(task, 'later')}>稍后做</button>}<button className="study-text-button" aria-label={`明天再做：${task.courseName} · ${task.title}`} onClick={() => decideTask(task, 'tomorrow')}>明天再做</button></div></div><span className="study-estimate">{task.estimatedMinutes} 分钟</span><button className="study-icon-button" aria-label={`开始学习：${task.courseName} · ${task.title}`} onClick={() => startTask(task)}><Icon name="practice"/></button></li>)}</ol>{home.tasks.length > 5 && <button className="study-text-button" aria-expanded={showAllTasks} onClick={() => setShowAllTasks(!showAllTasks)}>{showAllTasks ? '收起额外任务' : `查看其余 ${home.tasks.length - 5} 项今日任务`}</button>}</>
                : <div className="study-empty-row"><Icon name="practice"/><div><h3>{query ? '没有匹配的学习任务' : '今天还没有可安排的任务'}</h3><p>{query ? '换一个课程名或知识点试试。' : '把分析结果保存到课程，确认知识点和题目后，这里会给出下一步。'}</p></div></div>}
              {home.backlog.length > 0 && <><button className="study-text-button" aria-expanded={showBacklog} onClick={() => setShowBacklog(!showBacklog)}>查看 {home.backlog.length} 项未安排内容与原因</button>{showBacklog && <ul className="learning-list">{home.backlog.map((task) => { const courseName = personalSnapshots.find((item) => item.course.id === task.courseId)?.course.name ?? ''; return <li key={`${task.courseId}:${task.id}`}><strong>{courseName} · {task.title}</strong><p>{task.deferredReason}</p>{task.deferredBecause === 'user-deferred' && <button className="study-text-button" aria-label={`恢复今日安排：${courseName} · ${task.title}`} onClick={() => restoreTask(task)}>恢复今日安排</button>}</li> })}</ul>}</>}
              {home.deferred > 0 && capacity.minutes > 0 && <p>单看容量，积压内容约需 {Math.ceil(home.backlog.filter((task) => task.deferredBecause === 'time-capacity' || task.deferredBecause === 'question-capacity').reduce((sum, task) => sum + task.estimatedMinutes, 0) / capacity.minutes)} 天的额度；还需结合题数、到期日和来源检查调整。</p>}
            </section>
            <section className="study-courses" aria-label="我的课程概览"><div className="study-section-head"><h2>我的课程</h2><button className="study-text-button" onClick={() => open('materials')}>管理课程</button></div>
              {home.courses.length ? <div className="study-course-list">{home.courses.map((row) => <button className="study-course-row" key={row.course.id} onClick={() => open(row.course.learningMode === 'nodes' ? 'nodes' : 'knowledge', row.course.id)}><span className="study-course-mark"><Icon name="book"/></span><span><strong>{row.course.name}</strong><small>{row.course.goal || '从已保存资料继续学习'}</small></span><span className="study-course-count">{row.archiveCount} 份学习资料 · {row.confirmedPoints} 个已确认知识点</span></button>)}</div>
                : <div className="study-empty-row"><Icon name="book"/><div><h3>{query ? '没有匹配的课程' : '先创建你的第一门课程'}</h3><p>一门课程可以收纳多份资料、知识结构与历次练习。</p></div><button className="study-button" onClick={() => open('materials')}>创建课程</button></div>}
            </section>

          </details>
          <footer className="focus-home-footer">资料与进度保存在这台设备<button className="study-text-button" onClick={() => open('backup')}>备份</button></footer>
        </main> : <main className="study-module"><LearningWorkspace key={`${target.courseId}:${target.view}:${target.pointId}:${target.questionKey}:${target.sessionId ?? ''}:${target.documentId ?? ''}:${target.journeyId ?? ''}:${target.archiveId ?? ''}`} initialTarget={target} inline onClose={() => setDestination('home')}/></main>}
      {destination === 'home' && mindMapBar && <div className="study-mindmap-bar" role="region" aria-label="思维导图入口" data-mindmap-entry><span>《{mindMapBar.title}》导图已生成</span><button className="study-button" onClick={openMindMapFromBar}>打开思维导图</button><button className="study-text-button" aria-label="关闭导图入口" onClick={() => setMindMapBar(null)}>关闭</button></div>}
    </div>
    <input className="sr-only" ref={input} type="file" multiple={!guideImportActive} accept=".txt,.md,.markdown,.docx,.pdf,.pptx" aria-label="导入课程资料" onChange={(event) => { prepareFiles(Array.from(event.target.files ?? [])); event.target.value = '' }}/>
    {drafts.length > 0 && drafts[0] && <DocumentImportDialog key={drafts[0].source.id} draft={drafts[0]} onClose={() => { setDrafts((prev) => prev.slice(1)); guideImportProblem(true) }} onConfirm={confirmImport}/>}
    {postImport && !importQueue.active && <PostImportChoice docTitle={postImport.title} onOpenMindMap={() => choosePostImport('mindmap')} onStartLearning={() => choosePostImport('learning')} onStayHome={() => choosePostImport('home')}/>}
    {budgetOpen && <StudyDialog title="今天的分量" onClose={() => setBudgetOpen(false)}><p>这是所有课程共享的安排预算，不是倒计时。中途也能调整；已经完成的记录仍保留。</p><div className="focus-actions">{[10, 20, 40].map((value) => <button className="study-button" key={value} onClick={() => setMinutes(value)}>{value} 分钟</button>)}</div><form onSubmit={(e) => { e.preventDefault(); try { savePersonalCapacity({ minutes, questions }); setBudgetOpen(false) } catch { setError('分量暂时无法保存，请重试。') } }}><label>今天共安排多少分钟<input aria-label="今天共安排多少分钟" type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}/></label><label>最多多少道题<input aria-label="最多多少道题" type="number" min={0} max={1000} value={questions} onChange={(e) => setQuestions(Number(e.target.value))}/></label><button className="study-button study-button-primary">保存今天的分量</button></form></StudyDialog>}{achievementsOpen && <AchievementDesk snapshots={snapshots} onClose={() => setAchievementsOpen(false)} onRecords={(id) => open('records', id)} />}{preferencesOpen && <ExperienceSettings onClose={() => setPreferencesOpen(false)}/>}
    {replacement && <StudyDialog title="换一份资料学习" onClose={() => setReplacement(null)}><p>当前入门练习尚未完成。开启新一轮会替换这轮引导步骤和回答，课程资料仍然保留。</p><div className="focus-actions"><button className="study-button" onClick={() => { setReplacement(null); if (guideProgress.status === 'paused') resumeGuide(); setStudyClosed(''); setDestination('home') }}>继续原来的练习</button><button className="study-button study-button-primary" onClick={() => { const choice = replacement; setReplacement(null); void beginDocument(choice.docId, choice.courseId, true) }}>确认开启新一轮</button></div></StudyDialog>}
  </div>
}
