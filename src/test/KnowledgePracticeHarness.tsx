import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { MindMapEnvelope } from '../analysis/mindMapApplication'
import type { QuizEnvelope } from '../analysis/quizPractice'
import KnowledgePracticeBridge from '../components/analysis/KnowledgePracticeBridge'
import MindMapResult from '../components/analysis/MindMapResult'
import QuizResult from '../components/analysis/QuizResult'
import { useKnowledgePracticeNavigation } from '../components/analysis/useKnowledgePracticeNavigation'
import AnalysisArchiveAction from '../components/analysis/AnalysisArchiveAction'

/** Synthetic browser-only harness: exercises real IndexedDB and UI without a Provider. */
function Harness({ mindmap, quiz }: { mindmap: MindMapEnvelope; quiz: QuizEnvelope }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const navigation = useKnowledgePracticeNavigation(mindmap, quiz, false, dialog)
  return <dialog open ref={dialog} data-test-learning-dialog>
    <AnalysisArchiveAction docId={mindmap.docId} runId={mindmap.runId} artifacts={[mindmap, quiz]} disabled={false} bindingKey="synthetic-binding" onClose={() => {}} />
    <KnowledgePracticeBridge mindmap={mindmap} quiz={quiz} navigation={navigation} />
    <MindMapResult artifact={mindmap} disabled={false} onOpen={() => {}} onClose={() => {}} navigation={navigation} />
    <QuizResult artifact={quiz} disabled={false} onOpen={() => {}} navigation={navigation} mindmap={mindmap} />
  </dialog>
}
export function mountKnowledgePracticeHarness(mindmap: MindMapEnvelope, quiz: QuizEnvelope): () => void {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  root.render(<Harness mindmap={mindmap} quiz={quiz} />)
  return () => { root.unmount(); container.remove() }
}
