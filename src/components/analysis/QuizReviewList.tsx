import type { QuizEnvelope } from '../../analysis/quizPractice'
import type { QuizReviewItem, QuizReviewReason } from '../../analysis/quizReview'
import ArtifactCitations, { type OpenArtifactCitation } from './ArtifactCitations'
import type { KnowledgePracticeNavigation } from './useKnowledgePracticeNavigation'
import type { MindMapEnvelope } from '../../analysis/mindMapApplication'

const REASON_LABELS: Record<QuizReviewReason, string> = {
  'objective-incorrect': '与参考答案不一致',
  unanswered: '尚未作答',
  'self-assessment-pending': '简答待自评',
  'self-assessment-incomplete': '自评还有待补充的要点',
}

export default function QuizReviewList({ artifact, items, disabled, onQuestion, onOpen, navigation, mindmap }: {
  artifact: QuizEnvelope
  items: readonly QuizReviewItem[]
  disabled: boolean
  onQuestion: (id: string) => void
  onOpen: OpenArtifactCitation
  navigation?: KnowledgePracticeNavigation
  mindmap?: MindMapEnvelope
}) {
  return <section className="analysis-quiz-review" aria-label="本次待复习内容">
    <h4>本次待复习内容</h4>
    <p>依据这次作答整理；客观题按本次生成的参考答案判断，简答由你自评。可回到原文复核题目和答案。</p>
    {items.length === 0 ? <p role="status">本次没有待复习项。答对或完成自评不能代表已经掌握全部知识。</p>
      : <><p role="status">有 {items.length} 题值得回看。</p><ol>{items.map((item) => {
        const question = artifact.payload.questions[item.questionIndex]
        return <li key={item.questionId}>
          <p><strong>第 {item.questionIndex + 1} 题 · {REASON_LABELS[item.reason]}</strong><br />{question.prompt}</p>
          <div className="analysis-actions">
            <button type="button" className="tbtn" disabled={disabled} onClick={() => onQuestion(item.questionId)}>回看第 {item.questionIndex + 1} 题</button>
            {navigation?.view.status === 'ready' && navigation.view.result.links.filter((link) => link.questionId === item.questionId).map((link) => <button type="button" className="tbtn" key={link.nodeId} disabled={disabled || navigation.jumping}
              onClick={() => void navigation.jump('node', link.nodeId)}>补学知识点：{mindmap?.payload.nodes.find((node) => node.id === link.nodeId)?.text ?? link.nodeId}</button>)}
            <ArtifactCitations citations={question.citations} onOpen={onOpen} />
          </div>
        </li>
      })}</ol></>}
    <p className="analysis-source-caption">查看清单、答案和原文不会新增 AI 生成调用。加入课程后，每次提交将保留历史；重新作答只清空当前草稿。</p>
  </section>
}
