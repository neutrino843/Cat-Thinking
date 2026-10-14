import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { db } from '../../store/db'
import { deriveKnowledgePracticeLinks, type KnowledgePracticeLinksV1 } from '../../analysis/knowledgePracticeLinks'
import { prepareArtifactIdentity, verifyPreparedArtifactIdentity, type PreparedArtifactIdentity } from '../../analysis/localArtifactIdentity'
import type { MindMapEnvelope } from '../../analysis/mindMapApplication'
import type { QuizEnvelope } from '../../analysis/quizPractice'
import { subscribeAnalysisBinding } from '../../analysis/taskNotifications'

interface PreparedPair { mindmap: PreparedArtifactIdentity; quiz: PreparedArtifactIdentity }
export type KnowledgePracticeView = { status: 'loading' | 'unavailable' | 'missing' } | { status: 'ready'; result: KnowledgePracticeLinksV1 }
export interface KnowledgePracticeNavigation {
  view: KnowledgePracticeView
  jumping: boolean
  reload: () => void
  jump: (kind: 'node' | 'question', id: string) => Promise<void>
}
const verifyPair = (pair: PreparedPair): Promise<void> => db.transaction('r', [db.docs, db.sources, db.analysisTasks], async () => {
  await verifyPreparedArtifactIdentity(pair.mindmap)
  await verifyPreparedArtifactIdentity(pair.quiz)
})

/** One verified pair services every navigation entry; it never owns or copies quiz answers. */
export function useKnowledgePracticeNavigation(mindmap: MindMapEnvelope | undefined, quiz: QuizEnvelope | undefined,
  disabled: boolean, container: RefObject<HTMLDialogElement>): KnowledgePracticeNavigation {
  const [view, setView] = useState<KnowledgePracticeView>({ status: 'missing' })
  const [jumping, setJumping] = useState(false)
  const [reloadSequence, setReloadSequence] = useState(0)
  const generation = useRef(0)
  const permitted = useRef(false)
  const prepared = useRef<PreparedPair>()
  const pendingJump = useRef<number>()
  useLayoutEffect(() => {
    const epoch = generation
    permitted.current = !disabled && !!mindmap && !!quiz
    generation.current++
    prepared.current = undefined
    pendingJump.current = undefined
    return () => { permitted.current = false; epoch.current++; prepared.current = undefined; pendingJump.current = undefined }
  }, [mindmap, quiz, disabled])
  useEffect(() => {
    const epoch = generation
    let disposed = false
    const current = (token: number) => !disposed && permitted.current && token === generation.current
    const reload = () => {
      const token = ++generation.current
      prepared.current = undefined; pendingJump.current = undefined
      setJumping(false)
      setView({ status: disabled ? 'unavailable' : !mindmap || !quiz ? 'missing' : 'loading' })
      if (disabled || !mindmap || !quiz) return
      void (async () => {
        try {
          const mapIdentity = await prepareArtifactIdentity({ docId: mindmap.docId, runId: mindmap.runId, artifact: mindmap })
          if (!current(token)) return
          const quizIdentity = await prepareArtifactIdentity({ docId: quiz.docId, runId: quiz.runId, artifact: quiz })
          if (!current(token)) return
          if (mapIdentity.task.docId !== quizIdentity.task.docId || mapIdentity.task.runId !== quizIdentity.task.runId
            || mapIdentity.task.request.requestKey !== quizIdentity.task.request.requestKey
            || canonicalizeJson(mapIdentity.task.request.manifest) !== canonicalizeJson(quizIdentity.task.request.manifest)
            || canonicalizeJson(mapIdentity.sources) !== canonicalizeJson(quizIdentity.sources)
            || mapIdentity.task.artifactIdentities?.mindmap?.contentHash !== mapIdentity.artifactHash
            || quizIdentity.task.artifactIdentities?.quiz?.contentHash !== quizIdentity.artifactHash) throw new Error('binding unavailable')
          const pair = { mindmap: mapIdentity, quiz: quizIdentity }
          await verifyPair(pair)
          if (!current(token)) return
          prepared.current = pair
          setView({ status: 'ready', result: deriveKnowledgePracticeLinks({ mindmap, quiz }) })
        } catch { if (current(token)) { prepared.current = undefined; setView({ status: 'unavailable' }) } }
      })()
    }
    reload()
    if (disabled || !mindmap || !quiz) return () => { disposed = true }
    const unsubscribe = subscribeAnalysisBinding(mindmap.docId, reload)
    window.addEventListener('focus', reload)
    return () => { disposed = true; epoch.current++; prepared.current = undefined; unsubscribe(); window.removeEventListener('focus', reload) }
  }, [mindmap, quiz, disabled, reloadSequence])
  const jump = async (kind: 'node' | 'question', id: string) => {
    const pair = prepared.current
    if (!permitted.current || view.status !== 'ready' || !pair || !mindmap || !quiz || pendingJump.current !== undefined) return
    // An entry must belong to this verified result, rather than any same-title DOM node.
    if (!view.result.links.some((link) => kind === 'node' ? link.nodeId === id : link.questionId === id)) return
    const token = generation.current
    pendingJump.current = token; setJumping(true)
    const current = () => permitted.current && token === generation.current
    try {
      await verifyPair(pair)
      if (!current()) return
      const dialog = container.current
      if (!dialog?.isConnected || typeof CSS.escape !== 'function') throw new Error('navigation unavailable')
      const artifactSelector = kind === 'node' ? `[data-mindmap-artifact-id="${CSS.escape(mindmap.id)}"]` : `[data-quiz-artifact-id="${CSS.escape(quiz.id)}"]`
      const targetSelector = kind === 'node' ? `[data-mindmap-node-id="${CSS.escape(id)}"]` : `[data-quiz-question-id="${CSS.escape(id)}"]`
      const target = dialog.querySelector<HTMLElement>(`${artifactSelector} ${targetSelector}`)
      if (!target) throw new Error('navigation unavailable')
      target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' })
    } catch { if (current()) { prepared.current = undefined; setView({ status: 'unavailable' }) } }
    finally { if (pendingJump.current === token) pendingJump.current = undefined; if (current()) setJumping(false) }
  }
  // Props invalidate immediately, before the asynchronous effect publishes its new view.
  const activeView: KnowledgePracticeView = disabled ? { status: 'unavailable' }
    : !mindmap || !quiz ? { status: 'missing' }
      : view.status === 'ready' && (view.result.mindmapArtifactId !== mindmap.id || view.result.quizArtifactId !== quiz.id || view.result.runId !== mindmap.runId)
        ? { status: 'loading' } : view
  return { view: activeView, jumping, jump, reload: () => setReloadSequence((sequence) => sequence + 1) }
}
