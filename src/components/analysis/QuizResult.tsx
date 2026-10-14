import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { scoreQuiz, type QuizEnvelope } from '../../analysis/quizPractice'
import { deriveQuizReviewItems } from '../../analysis/quizReview'
import { QuizPracticeController } from '../../analysis/quizPracticeController'
import ArtifactCitations, { type OpenArtifactCitation } from './ArtifactCitations'
import QuizReviewList from './QuizReviewList'
import type { MindMapEnvelope } from '../../analysis/mindMapApplication'
import type { KnowledgePracticeNavigation } from './useKnowledgePracticeNavigation'
import QuizLearningFeedback from './QuizLearningFeedback'
import { subscribeAnalysisBinding } from '../../analysis/taskNotifications'
import { useArchivedQuizIssues } from './useArchivedQuizIssues'

export default function QuizResult({ artifact, disabled, onOpen, navigation, mindmap }: { artifact: QuizEnvelope; disabled: boolean; onOpen: OpenArtifactCitation; navigation?: KnowledgePracticeNavigation; mindmap?: MindMapEnvelope }) {
  const [controller] = useState(() => new QuizPracticeController({ docId: artifact.docId, runId: artifact.runId, artifact }))
  const questionElements = useRef(new Map<string, HTMLFieldSetElement>())
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const issues = useArchivedQuizIssues(artifact, disabled)
  useEffect(() => { if (!disabled) return controller.connect() }, [controller, disabled])
  useEffect(() => {
    if (disabled) return
    const reload = () => { void controller.reload() }
    const unsubscribe = subscribeAnalysisBinding(artifact.docId, reload)
    window.addEventListener('focus', reload)
    return () => { unsubscribe(); window.removeEventListener('focus', reload) }
  }, [artifact.docId, controller, disabled])
  const { form, loading, writing, ready, error, corrupt } = state
  const locked = disabled || !ready || loading
  const score = form.submitted && !locked && issues.ready && issues.questionIds.length === 0 ? scoreQuiz(artifact, form.answers, form.selfAssessments) : undefined
  const reviewItems = form.submitted && !locked && issues.ready ? deriveQuizReviewItems(artifact, form).filter((item) => !issues.questionIds.includes(item.questionId)) : undefined
  const answerValue = (id: string) => Object.prototype.hasOwnProperty.call(form.answers, id) ? form.answers[id] : undefined
  return <div className="analysis-quiz" data-quiz-artifact-id={artifact.id}>
    <h4>{artifact.payload.title}</h4>
    <p>作答仅保存在本机。提交后查看答案；简答题按评分标准自行评估。</p>
    <p role="status">{loading ? '正在读取本地练习…' : writing ? '正在保存作答…' : ready ? '作答已保存到本机' : '练习暂不可用'}</p>
    {error && <p role="alert">{error}</p>}
    {issues.error && <p role="alert">{issues.error}</p>}
    {!issues.ready && !issues.error && !disabled && <p role="status">正在核对题目疑问状态…</p>}
    {issues.questionIds.length > 0 && <p className="analysis-notice" role="status">这份测验有 {issues.questionIds.length} 道待核对题目，相关作答与整份提交已暂停。草稿保留；请到课程记录页解决疑问后继续。</p>}
    {error && <button className="tbtn" disabled={disabled || writing || loading} onClick={() => void controller.reload()}>重新读取练习</button>}
    {corrupt && <button className="tbtn" disabled={disabled || writing || loading} onClick={() => void controller.clearCorrupt()}>清理损坏练习</button>}
    {score && <p role="status">客观题：{score.objectiveCorrect} / {score.objectiveTotal} 正确，{score.objectiveUnanswered} 题未答。简答题：{score.shortAnswerAnswered} / {score.shortAnswerTotal} 已作答，{score.selfAssessed} 题已自评。</p>}
    {reviewItems && <QuizReviewList artifact={artifact} items={reviewItems} disabled={writing} onOpen={onOpen} navigation={navigation} mindmap={mindmap}
      onQuestion={(id) => {
        const element = questionElements.current.get(id)
        element?.focus({ preventScroll: true })
        element?.scrollIntoView({ block: 'start' })
      }} />}
    {!locked && artifact.payload.questions.map((question, index) => <fieldset key={question.id} disabled={locked || !issues.ready} tabIndex={-1} data-quiz-question-id={question.id}
      ref={(element) => { if (element) questionElements.current.set(question.id, element); else questionElements.current.delete(question.id) }}>
      <legend>{index + 1}. {question.prompt}</legend>
      {issues.questionIds.includes(question.id) && <p role="status">该题待核对，作答和自评暂停。仍可回查原文与对应知识点。</p>}
      {navigation?.view.status === 'ready' && <div className="analysis-actions" aria-label={`第 ${index + 1} 题对应知识点`}>
        {navigation.view.result.links.filter((link) => link.questionId === question.id).map((link) => <button className="tbtn" type="button" key={link.nodeId} disabled={navigation.jumping}
          onClick={() => void navigation.jump('node', link.nodeId)}>对应知识点：{mindmap?.payload.nodes.find((node) => node.id === link.nodeId)?.text ?? link.nodeId}</button>)}
      </div>}
      {question.type === 'multiple-choice' && question.options.map((option, optionIndex) => <label key={optionIndex} className="analysis-quiz-option">
        <input type="radio" name={`${artifact.id}:${question.id}`} disabled={form.submitted || issues.questionIds.includes(question.id)} checked={answerValue(question.id) === optionIndex}
          onChange={() => void controller.answer(question.id, optionIndex)} />{option}
      </label>)}
      {question.type === 'true-false' && [true, false].map((value) => <label key={String(value)} className="analysis-quiz-option">
        <input type="radio" name={`${artifact.id}:${question.id}`} disabled={form.submitted || issues.questionIds.includes(question.id)} checked={answerValue(question.id) === value}
          onChange={() => void controller.answer(question.id, value)} />{value ? '正确' : '错误'}
      </label>)}
      {question.type === 'short-answer' && <textarea aria-label={`第 ${index + 1} 题简答`} disabled={form.submitted || issues.questionIds.includes(question.id)} maxLength={10_000} value={String(answerValue(question.id) ?? '')}
        onChange={(event) => void controller.answer(question.id, event.target.value)} />}
      <ArtifactCitations citations={question.citations} onOpen={onOpen} />
      {form.submitted && <div className="analysis-quiz-answer">
        <p>参考答案：{question.type === 'multiple-choice' ? question.options[question.answerIndex] : question.type === 'true-false' ? question.answer ? '正确' : '错误' : question.answer}</p>
        <p>{question.explanation}</p>
        {question.type === 'short-answer' && question.rubric.map((criterion, criterionIndex) => <label key={criterionIndex} className="analysis-quiz-option">
          <input type="checkbox" disabled={issues.questionIds.includes(question.id)} checked={form.selfAssessments[question.id]?.[criterionIndex] ?? false} onChange={(event) => void controller.assess(question.id, criterionIndex, event.target.checked)} />自评：{criterion}
        </label>)}
        <QuizLearningFeedback key={`${form.submissionId ?? 'legacy'}:${question.id}`} artifact={artifact} questionId={question.id} form={form} disabled={locked || writing || issues.questionIds.includes(question.id)} />
      </div>}
    </fieldset>)}
    {!form.submitted && <button className="tbtn primary" disabled={locked || writing || !issues.ready || issues.questionIds.length > 0} onClick={() => void controller.submit()}>提交练习</button>}
    {form.submitted && <button className="tbtn" disabled={locked || writing} onClick={() => void controller.reset()}>重新作答</button>}
  </div>
}
