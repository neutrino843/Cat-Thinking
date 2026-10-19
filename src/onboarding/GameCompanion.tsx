import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { download } from '../lib/exporters'
import { GUIDE_KEY, guideHelp, guideReview, HELP_REASONS, openGuide, parseGuideProgress, pauseGuide, resumeGuide, scriptedGuide, startGuide, useGuide } from './guide'
import { EXPERIENCE_KEY, refreshExperience, useExperience } from '../learning/experiencePreferences'
import { FORMAL_HELP } from './companionContext'
import './guide.css'
import { useAchievementShelf } from '../learning/achievementShelf'
import LocalIsisChat from './LocalIsisChat'

function Isis() {
  return <img className="isis-portrait" src={`${import.meta.env.BASE_URL}images/isis-cat.jpg`} width={76} height={76} alt="" aria-hidden="true" draggable={false} />
}
const SHORT_COPY = { import: '先带一份资料来，我陪你完成第一题。', preview: '检查文字和漏页提示，再确认保存。', read: '资料收好啦。先读中央这一小段。', question: '试着填原词。想不起来，就回看原文。', complete: '第一题完成。接下来可以慢慢继续。' }

export default function GameCompanion() {
  const resting = useAchievementShelf((state) => state.resting)
  const { progress: p, expanded, storageError, hasCompleted } = useGuide()
  const preferences = useExperience((state) => state.preferences)
  const mode = preferences.companion
  const [perch, setPerch] = useState<HTMLElement | null>(null)
  const [scene, setScene] = useState({ key: 'home', hint: '从首页的推荐任务开始，或点「换个内容学」。', formal: false, failed: false, round: '', helpId: '', canRead: false, reader: false, auxiliary: false })
  const [typing, setTyping] = useState(false)
  const [bubble, setBubble] = useState({ key: '', text: '' })
  const [idleAt, setIdleAt] = useState('')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<{ speaker: 'you' | 'isis'; text: string }[]>([])
  const [review, setReview] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const seen = useRef(new Set<string>())
  const [dialogPage, setDialogPage] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [localChatOpen, setLocalChatOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const lastPrompt = useRef(0)
  const previousFocus = useRef<HTMLElement | null>(null)
  const lastStudyFocus = useRef<HTMLElement | null>(null)
  const active = p.status === 'active'
  const context = `${p.sessionId}:${p.step}:${scene.key}`
  const targetSelector = p.step === 'preview' ? '[data-guide="confirm-import"]' : p.step === 'import' ? '[data-guide="import"]' : '[data-guide-study] .study-button-primary'
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === EXPERIENCE_KEY || event.key === null) refreshExperience()
      if (event.key !== GUIDE_KEY) return
      try { if (event.newValue) { const progress = parseGuideProgress(JSON.parse(event.newValue)); useGuide.setState({ progress, hasCompleted: useGuide.getState().hasCompleted || progress.status === 'completed' || progress.events.some((item) => item.kind === 'submit') }) } } catch { /* Ignore invalid external progress. */ }
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  useEffect(() => {
    const update = () => {
      const topNative = Array.from(document.querySelectorAll('dialog[open]')).at(-1)
      const immersiveRoot = document.querySelector('[data-immersive-learning]')
      const scope = (immersiveRoot && (!topNative || topNative.contains(immersiveRoot)) ? immersiveRoot : null) ?? Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? document.fullscreenElement ?? document.querySelector('.document-import-modal') ?? document.querySelector('[data-immersive-learning]') ?? document
      const auxiliary = scope instanceof HTMLElement && scope.matches('.focus-dialog, .ai-settings-panel, .analysis-panel')
      const help = scope.querySelector<HTMLElement>('[data-source-help]')
      const readingScene = scope instanceof HTMLElement && scope.matches('[data-reading-scene]')
      const anchors = Array.from(scope.querySelectorAll<HTMLElement>('[data-isis-perch]')).filter((item) => item.getClientRects().length > 0)
      const taskAnchor = anchors.find((item) => item.hasAttribute('data-task-perch'))
      setPerch(taskAnchor ?? anchors.at(-1) ?? null)
      const within = (selector: string) => scope instanceof HTMLElement && scope.matches(selector) ? scope : scope.querySelector<HTMLElement>(selector)
      const formal = within('[data-journey-id]') ?? within('[data-immersive-learning]') ?? within('[data-learning-stage="prepare"]')
      const practice = formal ? null : within('[data-learning-practice]')
      const stage = formal?.dataset.learningStage
      const step = formal?.dataset.journeyId && stage !== 'round-end' ? `${stage}:${formal.dataset.journeyStep}` : formal?.querySelector<HTMLElement>('[data-step-action]')?.dataset.stepAction ?? stage ?? 'done'
      const failed = !!formal?.querySelector('[role="alert"]')
      const paused = !!formal?.querySelector('.immersive-card h3')?.textContent?.startsWith('已暂停')
      const current = useGuide.getState().progress
      const central = !!document.querySelector('[data-guide-study]')
      const editor = !!scope.querySelector('.canvas-wrap')
      const preview = !!document.querySelector('.document-import-modal')
      const hint = auxiliary ? '这里可以按需查看或调整当前选项。关闭我的对话后，继续当前操作。' : readingScene ? '这里是独立阅读，可以正常滚动。读好后点「返回刚才的学习」，原回答会保留。' : formal ? failed ? '先处理上面的保存或资料提示。当前输入先保留在这里，别急着退出。' : paused ? '这轮已经暂停，点「继续本次学习」就能接着学。' : ({ prepare: '这是刚才那份资料。先核对待确认内容，或点「先读原文」；不会自动调用模型。', 'reading:0': '先读中央这一小段。想再看一点可读下一段，读好后点「继续下一步」。', 'reading:1': '在这里用自己的话写一点理解。文字保存好后，就能继续选回看日期。', 'reading:2': '想稍后再看就选一个日期；也可以先不安排，然后保存这一轮。', 'remediation:0': '先对照原文，找一找刚才哪里需要修正，再继续下一步。', 'remediation:1': '记下一点修正，接下来会重新回答原来那道题。旧答案会保留。', 'remediation:2': '真正提交这次重试；简答还需自评。最后由你决定后续日期。', 'round-end': '这一轮已保留。看看实际安排的日期，再返回课程或原报告。' } as Record<string, string>)[step] ?? FORMAL_HELP[step] ?? FORMAL_HELP.done : practice ? practice.dataset.hasQuestion === 'true' ? FORMAL_HELP.practice : '这里还没有可用题目。可以到课程资料阅读，或返回首页选择原文入门练习；不会自动生成题目。' : preview ? SHORT_COPY.preview : central || current.status === 'active' && current.step === 'import' ? SHORT_COPY[current.step] : '从首页的推荐任务开始，或点「换个内容学」。'
      const round = formal?.dataset.sessionId ?? formal?.dataset.journeyId ?? formal?.dataset.sourceDocument ?? practice?.dataset.practiceCourse ?? ''
      const next = { key: formal ? `formal:${round}:${step}:${failed}:${paused}` : practice ? `practice:${practice.dataset.practiceCourse}:${practice.dataset.hasQuestion}` : preview ? 'preview' : central ? `guide:${current.step}` : editor ? 'editor' : 'home', hint, formal: !!formal || !!practice || !!readingScene || auxiliary, failed, round, helpId: help?.dataset.sourceHelp ?? '', canRead: help?.dataset.canRead === 'true', reader: !!readingScene, auxiliary }
      setScene((previous) => previous.key === next.key && previous.hint === next.hint && previous.helpId === next.helpId && previous.reader === next.reader && previous.auxiliary === next.auxiliary ? previous : next)
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-step-action', 'data-has-question', 'data-learning-stage', 'data-journey-step', 'data-source-help', 'open'] }); update()
    document.addEventListener('fullscreenchange', update)
    return () => { observer.disconnect(); document.removeEventListener('fullscreenchange', update) }
  }, [])
  useEffect(() => {
    const focus = () => { const element = document.activeElement; if (element instanceof HTMLElement && element !== document.body && !element.closest('.isis-companion')) lastStudyFocus.current = element; setTyping(!!element?.matches('input, textarea, [contenteditable="true"]')) }
    window.addEventListener('focusin', focus); window.addEventListener('focusout', focus)
    return () => { window.removeEventListener('focusin', focus); window.removeEventListener('focusout', focus) }
  }, [])
  const failureAt = p.events.slice(-1).find((event) => ['import-error', 'preview-cancelled'].includes(event.kind))?.at ?? 0
  const hintKey = `${mode}:${context}:${p.status}:${failureAt}`
  const idle = idleAt === context
  useEffect(() => {
    const timer = window.setTimeout(() => setIdleAt(context), 45_000)
    return () => window.clearTimeout(timer)
  }, [context])
  useEffect(() => {
    if (scene.key === 'editor' && p.status !== 'active') {
      const clear = window.setTimeout(() => setBubble({ key: '', text: '' }), 0)
      return () => window.clearTimeout(clear)
    }
    if (scene.auxiliary || Date.now() - lastPrompt.current < 120_000 || mode === 'quiet' || (mode === 'beginner' && hasCompleted) || seen.current.has(hintKey)) return
    if (mode === 'gentle' && scene.formal && !scene.failed && seen.current.has(`intro:${scene.round}`)) return
    if (mode === 'gentle' && !scene.formal && p.status !== 'idle' && p.step !== 'import' && !failureAt) return
    const show = window.setTimeout(() => { lastPrompt.current = Date.now(); seen.current.add(hintKey); if (scene.formal) seen.current.add(`intro:${scene.round}`); setBubble({ key: hintKey, text: scene.hint }) }, 300)
    const hide = window.setTimeout(() => setBubble({ key: '', text: '' }), 12_000)
    return () => { window.clearTimeout(show); window.clearTimeout(hide) }
  }, [scene.key, scene.auxiliary, mode, hintKey, failureAt, p.status, p.step, hasCompleted, scene.formal, scene.failed, scene.round, scene.hint])
  useEffect(() => {
    if (!active || scene.formal || mode === 'quiet' || (!expanded && (mode !== 'beginner' || hasCompleted))) return
    let target: Element | null = null
    const update = () => {
      const next = Array.from(document.querySelectorAll<HTMLElement>(targetSelector)).find((item) => item.getClientRects().length)
      if (next === target) return
      target?.classList.remove('isis-guide-target'); target = next ?? null; target?.classList.add('isis-guide-target')
    }
    const observer = new MutationObserver(update); observer.observe(document.body, { childList: true, subtree: true }); update()
    return () => { observer.disconnect(); target?.classList.remove('isis-guide-target') }
  }, [active, expanded, mode, targetSelector, hasCompleted, scene.formal])
  useEffect(() => {
    if (!expanded) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useGuide.setState({ expanded: false }); previousFocus.current?.focus({ preventScroll: true }) } }
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true)
  }, [expanded])
  const close = () => { setRestarting(false); useGuide.setState({ expanded: false }); previousFocus.current?.focus({ preventScroll: true }) }
  const openChat = () => { previousFocus.current = lastStudyFocus.current ?? document.activeElement as HTMLElement; setRestarting(false); setDialogPage(0); setToolsOpen(false); setHistoryIndex(-1); openGuide() }
  const locate = () => {
    close()
    if (scene.formal) { requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-journey-id] textarea:not([readonly]), [data-journey-id] footer button:not([disabled]), [data-learning-stage="prepare"] button.primary, [data-immersive-learning] textarea, [data-immersive-learning] .immersive-card, [data-learning-practice] input, [data-learning-practice] button')?.focus({ preventScroll: true })); return }
    if (p.binding && ['read', 'question'].includes(p.step) && ['active', 'paused'].includes(p.status)) window.dispatchEvent(new Event('msz:guide-study-open'))
    else { window.dispatchEvent(new Event('msz:open-home')); requestAnimationFrame(() => { const target = Array.from(document.querySelectorAll<HTMLElement>(targetSelector)).find((item) => item.getClientRects().length); target?.scrollIntoView({ block: 'center' }); target?.focus() }) }
  }
  const chat = (text: string, recordHelp = true) => {
    const value = text.trim().slice(0, 400)
    if (!value) return
    if (!scene.formal && recordHelp && /找不到|不会|看不懂|帮助|下一步/u.test(value)) guideHelp('不知道下一步')
    const answer = /独立阅读|阅读全文|完整阅读/u.test(value) && scene.canRead ? '可以，点击气泡里的「进入独立阅读」，那里可以正常滚动；回来时仍是刚才的题目。' : /相关段落|找依据|看原文/u.test(value) && scene.helpId ? '点击「看相关段落」，我会展开当前任务的依据。想多读一点，也可以进入独立阅读。' : /下一步|怎么做|哪里|找不到|不会|看不懂|帮助/u.test(value) ? scene.hint : scriptedGuide.reply(p.step, value)
    setMessages((items) => [...items.slice(-18), { speaker: 'you', text: value }, { speaker: 'isis', text: answer }]); setDialogPage(0); setHistoryIndex(-1); setInput('')
  }
  const currentMessage = historyIndex >= 0 ? messages[historyIndex] : messages.at(-1)
  const speech = currentMessage?.text ?? scene.hint
  const pages = speech.match(/[\s\S]{1,100}/gu) ?? ['']
  const avatar = <aside className={`isis-companion is-game ${perch ? 'is-perched' : 'is-floating'} ${typing && !expanded ? 'is-typing' : ''} ${preferences.motion ? 'has-motion' : ''} ${resting && preferences.rewards ? 'is-resting' : ''} is-${preferences.catSide}`} aria-label="伊希斯新手引导" data-isis-guide>
    {expanded ? <section className="isis-dialogue" role="dialog" aria-label="与伊希斯对话" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <header><small>伊希斯 · 预设对话</small><button aria-label="关闭与伊希斯对话" onClick={close}>收起</button></header>
      <p className="isis-line" role="log" aria-label="与伊希斯的对话" aria-live="polite">{currentMessage?.speaker === 'you' ? '你：' : ''}{pages[Math.min(dialogPage, pages.length - 1)]}</p>
      {pages.length > 1 && <div className="isis-choices"><button disabled={!dialogPage} onClick={() => setDialogPage(dialogPage - 1)}>上一句</button><small>{dialogPage + 1} / {pages.length}</small><button disabled={dialogPage >= pages.length - 1} onClick={() => setDialogPage(dialogPage + 1)}>下一句</button></div>}
      {storageError && <p role="alert">{storageError}</p>}
      <button className="tbtn" aria-pressed={localChatOpen} onClick={() => setLocalChatOpen(!localChatOpen)}>{localChatOpen ? '收起模型问答' : '模型问答'}</button>
      {localChatOpen && <LocalIsisChat/>}
      {!toolsOpen ? <><div className="isis-choices">{scene.reader ? <button onClick={() => { close(); Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1)?.querySelector<HTMLButtonElement>('[data-reader-return]')?.click() }}>返回刚才的学习</button> : scene.helpId ? <><button onClick={() => { window.dispatchEvent(new CustomEvent('msz:source-action', { detail: { id: scene.helpId, action: 'related' } })); close() }}>看相关段落</button>{scene.canRead && <button onClick={() => { window.dispatchEvent(new CustomEvent('msz:source-action', { detail: { id: scene.helpId, action: 'read' } })); close() }}>进入独立阅读</button>}</> : <><button onClick={scene.auxiliary ? close : scene.formal || p.status !== 'idle' ? locate : () => { startGuide(); close() }}>{scene.auxiliary ? '继续当前操作' : scene.formal ? '回到当前学习' : p.status === 'idle' ? '带我完成第一道题' : '定位操作'}</button><button onClick={() => chat('下一步怎么做')}>给点提示</button></>}<button onClick={() => setToolsOpen(true)}>更多对话</button></div>
      <form className="isis-chat-form" onSubmit={(event) => { event.preventDefault(); chat(input) }}><label className="sr-only" htmlFor="isis-chat">对伊希斯说</label><input id="isis-chat" maxLength={400} value={input} onChange={(event) => setInput(event.target.value)} placeholder="说说你卡在哪里…"/><button disabled={!input.trim()}>发送</button></form></> : <div className="isis-choices">
        <button onClick={() => { setToolsOpen(false); chat('下一步怎么做') }}>给点提示</button><button onClick={locate}>回到当前学习</button><button onClick={() => { setToolsOpen(false); chat('会收费吗') }}>会收费吗</button><button onClick={() => { setToolsOpen(false); chat('资料怎么保存') }}>资料怎么保存</button>
        <button disabled={!messages.length} onClick={() => { setHistoryIndex((i) => i <= 0 ? messages.length - 1 : i - 1); setDialogPage(0) }}>刚才说了什么</button>
        {active && !scene.formal && <button onClick={() => { pauseGuide(); close() }}>暂停引导</button>}
        {p.status === 'paused' && !scene.formal && <button onClick={() => { resumeGuide(); locate() }}>继续引导</button>}
        <button onClick={() => setReview(!review)}>引导复盘</button>
        {review && <button onClick={() => download('伊希斯-新手引导复盘.md', new Blob([guideReview(p)], { type: 'text/markdown;charset=utf-8' }))}>导出复盘记录</button>}
        {!scene.formal && <button onClick={() => setRestarting(!restarting)}>重新体验</button>}
        {restarting && !scene.formal && <button onClick={() => { startGuide(); setRestarting(false); setMessages([]); close() }}>确认开始新一轮</button>}
        {active && !scene.formal && HELP_REASONS.slice(0, 2).map((reason) => <button key={reason} onClick={() => { guideHelp(reason); chat(reason, false); setToolsOpen(false) }}>{reason}</button>)}
        <button onClick={() => setToolsOpen(false)}>返回对话</button>
      </div>}
    </section> : bubble.key === hintKey && bubble.text && !scene.auxiliary && mode !== 'quiet' && (!typing || !!perch) && <div className="isis-bubble"><span>{bubble.text}</span><button aria-label="收起伊希斯提示" onClick={() => setBubble({ key: '', text: '' })}>×</button></div>}
    <button className="isis-avatar" onClick={expanded ? close : openChat} aria-label="打开伊希斯新手引导" aria-expanded={expanded}><Isis/><span>伊希斯</span>{idle && !expanded && mode !== 'quiet' && <i aria-label="可以向伊希斯求助">?</i>}</button>
  </aside>
  return perch ? createPortal(avatar, perch) : avatar
}
