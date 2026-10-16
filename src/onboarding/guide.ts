import { create } from 'zustand'
import { identifierSchema } from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'

export const GUIDE_KEY = 'msz.isis-guide.v1'
export const GUIDE_STEPS = ['import', 'preview', 'read', 'question', 'complete'] as const
export type GuideStep = typeof GUIDE_STEPS[number]
export const STEP_NAMES: Record<GuideStep, string> = { import: '导入资料', preview: '确认预览', read: '读一小段', question: '完成第一题', complete: '回看与继续' }
export const STEP_COPY: Record<GuideStep, string> = {
  import: '先带来你自己的资料。点亮起的「导入资料」，选一份 TXT、Word、文字 PDF 或 PPTX。只在本机读取，不需要连接 AI。',
  preview: '这是导入前的预览。检查标题、文字和漏页提示；没有问题就点「创建可编辑导图」。确认保存后，我才会带你做题。',
  read: '资料已经保存并加入课程。先读学习区里的这一小段，我会从这段原文出一道填空题。读好后，我们把原文收起来试一次。',
  question: '用刚读过的原文补上空缺。这里按原文文字核对，不考察同义表达。想不起来可以回看原文，不必猜。',
  complete: '你已经从自己的资料完成了第一道入门题！这次记录保存在引导里。之后可以到课程整理知识，按需生成更多练习，再安排复习。',
}
export const HELP_REASONS = ['找不到入口', '不知道下一步', '看不懂说明', '担心费用或资料安全'] as const
type GuideEventKind = 'start' | 'preview' | 'saved' | 'read' | 'help' | 'pause' | 'resume' | 'submit' | 'source-viewed' | 'import-error' | 'preview-cancelled'
export interface GuideBinding { docId: string; sourceId: string; courseId: string; sourceHash: string }
export interface GuideEvent { sessionId: string; step: GuideStep; kind: GuideEventKind; at: number; elapsedMs: number; reason?: typeof HELP_REASONS[number]; outcome?: 'match' | 'different' }
export interface GuideProgress {
  version: 1; sessionId: string; status: 'idle' | 'active' | 'paused' | 'completed'; step: GuideStep
  stepAt: number; binding: GuideBinding | null; answer: string; assisted: boolean; outcome: 'match' | 'different' | null; events: GuideEvent[]
}
const fresh = (): GuideProgress => ({ version: 1, sessionId: '', status: 'idle', step: 'import', stepAt: 0, binding: null, answer: '', assisted: false, outcome: null, events: [] })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown) => identifierSchema.safeParse(value).success
const timestamp = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const eventKinds = ['start', 'preview', 'saved', 'read', 'help', 'pause', 'resume', 'submit', 'source-viewed', 'import-error', 'preview-cancelled']
export function parseGuideProgress(value: unknown): GuideProgress {
  if (!record(value) || value.version !== 1 || !['idle', 'active', 'paused', 'completed'].includes(String(value.status))
    || Object.keys(value).some((key) => !['version', 'sessionId', 'status', 'step', 'stepAt', 'binding', 'answer', 'assisted', 'outcome', 'events'].includes(key))
    || !GUIDE_STEPS.includes(value.step as GuideStep) || !timestamp(value.stepAt) || typeof value.sessionId !== 'string'
    || (value.status !== 'idle' && !validId(value.sessionId)) || typeof value.answer !== 'string' || value.answer.length > 160
    || typeof value.assisted !== 'boolean' || ![null, 'match', 'different'].includes(value.outcome as string | null)
    || !Array.isArray(value.events) || value.events.length > 200) throw new Error('引导记录格式无效。')
  if (value.binding !== null && (!record(value.binding) || !validId(value.binding.docId) || !validId(value.binding.sourceId)
    || Object.keys(value.binding).some((key) => !['docId', 'sourceId', 'courseId', 'sourceHash'].includes(key))
    || !validId(value.binding.courseId) || typeof value.binding.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.binding.sourceHash))) throw new Error('引导资料关联无效。')
  if (['read', 'question', 'complete'].includes(String(value.step)) && !value.binding) throw new Error('引导缺少已保存资料。')
  if ((value.status === 'completed') !== (value.step === 'complete') || (value.step === 'complete' && value.outcome === null)) throw new Error('引导完成状态无效。')
  for (const event of value.events) if (!record(event) || !validId(event.sessionId) || !GUIDE_STEPS.includes(event.step as GuideStep)
    || Object.keys(event).some((key) => !['sessionId', 'step', 'kind', 'at', 'elapsedMs', 'reason', 'outcome'].includes(key))
    || !eventKinds.includes(String(event.kind)) || !timestamp(event.at) || !timestamp(event.elapsedMs)
    || (event.reason !== undefined && !HELP_REASONS.includes(event.reason as typeof HELP_REASONS[number]))
    || (event.outcome !== undefined && !['match', 'different'].includes(String(event.outcome)))) throw new Error('引导事件无效。')
  // Whitelist persisted fields; imports cannot inject additional settings or executable work.
  return { version: 1, sessionId: value.sessionId, status: value.status as GuideProgress['status'], step: value.step as GuideStep,
    stepAt: value.stepAt as number, binding: value.binding ? { docId: value.binding.docId as string, sourceId: value.binding.sourceId as string, courseId: value.binding.courseId as string, sourceHash: value.binding.sourceHash as string } : null,
    answer: value.answer, assisted: value.assisted, outcome: value.outcome as GuideProgress['outcome'],
    events: value.events.map((event) => ({ sessionId: event.sessionId, step: event.step, kind: event.kind, at: event.at, elapsedMs: event.elapsedMs,
      ...(event.reason ? { reason: event.reason } : {}), ...(event.outcome ? { outcome: event.outcome } : {}) })) }
}
function load(): GuideProgress {
  try { const raw = localStorage.getItem(GUIDE_KEY); return raw ? parseGuideProgress(JSON.parse(raw)) : fresh() } catch { return fresh() }
}
export const GUIDE_COMPLETED_KEY = 'msz.isis-guide.completed.v1'
export const useGuide = create<{ progress: GuideProgress; expanded: boolean; storageError: string; hasCompleted: boolean }>(() => {
  const progress = load()
  let hasCompleted = progress.status === 'completed' || progress.events.some((event) => event.kind === 'submit')
  try { hasCompleted ||= localStorage.getItem(GUIDE_COMPLETED_KEY) === '1' } catch { /* In-memory history still works. */ }
  return { progress, expanded: false, storageError: '', hasCompleted }
})
export function openGuide(): void { useGuide.setState({ expanded: true }) }
export function commitGuide(progress: GuideProgress): void {
  const parsed = parseGuideProgress(progress)
  let storageError = ''
  try { localStorage.setItem(GUIDE_KEY, JSON.stringify(parsed)) } catch { storageError = '本机暂时无法保存引导进度。这次可以继续，刷新后可能需要重新开始。' }
  useGuide.setState({ progress: parsed, storageError })
}
function event(progress: GuideProgress, kind: GuideEventKind, extra: Partial<Pick<GuideEvent, 'reason' | 'outcome'>> = {}): GuideEvent[] {
  const at = Date.now()
  return [...progress.events, { sessionId: progress.sessionId, step: progress.step, kind, at, elapsedMs: progress.status === 'active' ? Math.max(0, at - progress.stepAt) : 0, ...extra }].slice(-200)
}
export function startGuide(): void {
  const previous = useGuide.getState().progress
  const progress: GuideProgress = { ...fresh(), sessionId: crypto.randomUUID(), status: 'active', stepAt: Date.now(), events: previous.events }
  progress.events = event(progress, 'start'); commitGuide(progress); useGuide.setState({ expanded: false })
  window.dispatchEvent(new Event('msz:open-home'))
}
export function pauseGuide(): void {
  const p = useGuide.getState().progress
  if (p.status === 'active') commitGuide({ ...p, status: 'paused', events: event(p, 'pause') })
}
export function resumeGuide(): void {
  const p = useGuide.getState().progress
  if (p.status === 'paused') commitGuide({ ...p, status: 'active', stepAt: Date.now(), events: event(p, 'resume') })
  useGuide.setState({ expanded: false })
}
export function guidePreview(): void {
  const p = useGuide.getState().progress
  if (p.status === 'active' && p.step === 'import') commitGuide({ ...p, step: 'preview', stepAt: Date.now(), events: event(p, 'preview') })
}
export function guideImportProblem(cancelled = false): void {
  const p = useGuide.getState().progress
  if ((p.status === 'active' || p.status === 'paused') && (p.step === 'import' || p.step === 'preview')) commitGuide({ ...p, step: 'import', stepAt: Date.now(), events: event(p, cancelled ? 'preview-cancelled' : 'import-error') })
}
export function guideSaved(binding: GuideBinding, expectedSessionId: string): boolean {
  const p = useGuide.getState().progress
  if (p.sessionId !== expectedSessionId || (p.status !== 'active' && p.status !== 'paused') || (p.step !== 'preview' && p.step !== 'import')) return false
  commitGuide({ ...p, step: 'read', binding, stepAt: Date.now(), events: event(p, 'saved') }); useGuide.setState({ expanded: false }); return true
}
export function guideRead(): void {
  const p = useGuide.getState().progress
  if (p.status === 'active' && p.step === 'read') commitGuide({ ...p, step: 'question', stepAt: Date.now(), events: event(p, 'read') })
}
export function guideHelp(reason: typeof HELP_REASONS[number]): void {
  const p = useGuide.getState().progress
  if (p.status === 'active') commitGuide({ ...p, events: event(p, 'help', { reason }) })
}
export function guideViewSource(): void {
  const p = useGuide.getState().progress
  if (p.status === 'active' && p.step === 'question') commitGuide({ ...p, assisted: true, events: event(p, 'source-viewed') })
}
export function setGuideAnswer(answer: string): void {
  const p = useGuide.getState().progress
  if (p.status === 'active' && p.step === 'question') commitGuide({ ...p, answer: answer.slice(0, 160) })
}
export function submitGuideAnswer(outcome: 'match' | 'different', sessionId: string): void {
  const p = useGuide.getState().progress
  if (p.sessionId !== sessionId || p.status !== 'active' || p.step !== 'question') return
  commitGuide({ ...p, outcome, step: 'complete', status: 'completed', stepAt: Date.now(), events: event(p, 'submit', { outcome }) })
  useGuide.setState({ hasCompleted: true })
  try { localStorage.setItem(GUIDE_COMPLETED_KEY, '1') } catch { useGuide.setState({ storageError: '第一题已提交，但首次引导完成标记暂时无法保存，刷新后可能再次出现提示。' }) }
}

export interface FirstQuestion { quote: string; prompt: string; answer: string; start: number; end: number }
/** An explicitly literal recall exercise. Never invent facts or masquerade as an AI artifact. */
export function buildFirstQuestion(source: Pick<SourceDocument, 'text'>): FirstQuestion | null {
  const matches = [...source.text.matchAll(/[^\n。！？.!?]+[。！？.!?]?/gu)]
  const sentence = matches.find((m) => m[0].trim().length >= 12 && m[0].length <= 220 && !/^\s*(?:#{1,6}\s|第.{1,8}[章节])/u.test(m[0]))
    ?? matches.find((m) => m[0].trim().length >= 4 && m[0].length <= 220)
  if (!sentence) return null
  const token = /[\p{Script=Han}]{2,}|[A-Za-z]{3,}/u.exec(sentence[0])
  if (!token) return null
  const answer = token[0].slice(0, /[A-Za-z]/u.test(token[0]) ? 12 : 4)
  const quote = sentence[0]
  return { quote, prompt: quote.slice(0, token.index) + '（____）' + quote.slice(token.index + answer.length), answer, start: sentence.index ?? 0, end: (sentence.index ?? 0) + quote.length }
}
export const normalizeRecallAnswer = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()

export interface GuideDialogueProvider { reply(step: GuideStep, text: string): string }
/** Future AI providers can implement this boundary; this provider has no network access. */
export const scriptedGuide: GuideDialogueProvider = { reply(step, text) {
  if (/收费|付费|额度|免费|模型|api|AI/iu.test(text)) return '这次新手引导、对话和原文填空都在本机完成，不调用模型。以后使用「AI 分析」时，需要你明确确认生成，才会使用你连接的服务商额度。'
  if (/安全|隐私|上传|保存|丢|备份/u.test(text)) return '导入资料和引导记录留在当前浏览器。换设备或清理浏览器前，请到「资料与备份」导出课程包。引导复盘不包含原文、你的回答或聊天内容。'
  if (/暂停|退出|关闭|继续|刷新/u.test(text)) return '可以用学习区的「暂停并保存」，下次点「继续引导」。收起小窗不会暂停；刷新后进度仍在。尚未确认保存的文件需要重新选择。'
  if (/下一步|怎么|哪里|找不到|不会|看不懂|帮助/u.test(text)) return STEP_COPY[step] + (step === 'import' || step === 'preview' ? ' 也可以点「定位操作」找按钮。' : '')
  return '我现在使用预设台词，还不能像 AI 一样理解任意问题或解释你的课程内容。你可以问「下一步怎么做」「会收费吗」「资料怎么保存」，我会按你当前的位置回答。'
} }
const EVENT_NAMES: Record<GuideEventKind, string> = { start: '开始引导', preview: '看到导入预览', saved: '资料已保存', read: '读完进入题目', help: '主动求助', pause: '暂停', resume: '继续', submit: '提交第一题', 'source-viewed': '回看原文', 'import-error': '导入失败', 'preview-cancelled': '取消预览' }
export function guideReview(progress: GuideProgress): string {
  const lines = progress.events.map((e) => `| ${new Date(e.at).toLocaleString('zh-CN')} | ${STEP_NAMES[e.step]} | ${EVENT_NAMES[e.kind]} | ${e.reason ?? (e.outcome === 'match' ? '与原文一致' : e.outcome === 'different' ? '与原文不同' : '—')} | ${Math.round(e.elapsedMs / 1000)} 秒 |`)
  return ['# 伊希斯 · 新手引导复盘', '', '这是实际操作与主动求助记录，不代表真实用户访谈，也不自动判断学习掌握情况。', '停留时间按事件记录，可能包含阅读、思考或离开页面；暂停时间不计入下一阶段。最多保留最近 200 个事件。', '不含资料原文、文件名、作答和聊天内容；仅手动导出，不自动上传。', '', '| 时间 | 所在步骤 | 操作 | 求助原因 / 结果 | 距上次进入本步 |', '| --- | --- | --- | --- | --- |', ...lines].join('\n')
}
