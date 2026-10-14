import { useState } from 'react'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { loadQuizPractice, type QuizEnvelope, type QuizPracticeState } from '../../analysis/quizPractice'
import { appendAssessment, findArchiveForArtifact, getEntity, recordArchivedQuizSubmission, saveEntity } from '../../learning/repository'
import { learningBase } from '../../learning/model'

const REASONS = ['概念不清', '概念混淆', '步骤遗漏', '计算或操作失误', '暂不确定']
export default function QuizLearningFeedback({ artifact, questionId, form, disabled }: {
  artifact: QuizEnvelope; questionId: string; form: QuizPracticeState; disabled: boolean
}) {
  const [reason, setReason] = useState('')
  const [issue, setIssue] = useState<'answer' | 'ambiguous' | 'outside-source' | ''>('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy || disabled || !reason && !issue) return
    setBusy(true); setMessage('')
    try {
      const record = await loadQuizPractice({ docId: artifact.docId, runId: artifact.runId, artifact })
      if (!record?.submitted) { setMessage('当前提交记录已变化，请重新读取练习后再保存反馈。'); return }
      const archive = await findArchiveForArtifact(artifact.docId, artifact.runId, artifact.id,
        { artifactHash: record.artifactHash, sourceFingerprint: record.sourceFingerprint })
      if (!archive) { setMessage('请先把这次学习保存到课程，再保留错因或题目疑问。'); return }
      if (record && (record.submissionId !== form.submissionId || canonicalizeJson(record.answers) !== canonicalizeJson(form.answers)
        || canonicalizeJson(record.selfAssessments) !== canonicalizeJson(form.selfAssessments))) {
        setMessage('作答已在另一页面变化，请重新读取后再记录反馈。'); return
      }
      if (issue) await saveEntity({ ...learningBase(archive.courseId), kind: 'issue', question: { archiveId: archive.id, artifactId: artifact.id, questionId, confirmed: false }, reason: issue, note, status: 'open' }, null)
      if (reason) {
        const attempts = record?.submitted ? await recordArchivedQuizSubmission(archive.id, record) : []
        const reference = attempts.find((attempt) => attempt.question.questionId === questionId)
        const attempt = reference && await getEntity(reference.id, 'attempt')
        const question = artifact.payload.questions.find((item) => item.id === questionId)
        if (attempt && question) {
          const checks = form.selfAssessments[questionId]
          const outcome = issue ? 'disputed' : question.type === 'short-answer' ? checks?.every(Boolean) ? 'success' : checks?.some(Boolean) ? 'partial' : 'failure'
            : (question.type === 'multiple-choice' ? attempt.answer === question.answerIndex : attempt.answer === question.answer) ? 'success' : 'failure'
          await appendAssessment({ ...learningBase(archive.courseId), kind: 'assessment', attemptId: attempt.id, outcome,
            difficulty: outcome === 'success' ? 'good' : 'again', selfAssessmentComplete: question.type !== 'short-answer' || !!checks, reason: note ? `${reason}：${note}` : reason,
            ...(checks ? { rubricChecks: checks } : {}) })
        } else if (!issue) { setMessage('这道题尚无可用的已提交回答。请先作答，再记录具体错因。'); return }
      }
      setMessage(issue ? '疑问已保存，这道题在问题解决前暂停自动安排。可在课程里回查原文和解决疑问。' : '错因已保存。可回看对应知识点与原文，再次练习。')
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '反馈保存失败，请重新读取。') }
    finally { setBusy(false) }
  }
  return <div className="analysis-quiz-answer" aria-label="错因与题目疑问">
    <label>我的补学原因 <select aria-label={`题目 ${questionId} 补学原因`} value={reason} disabled={disabled || busy} onChange={(event) => setReason(event.target.value)}>
      <option value="">可跳过</option>{REASONS.map((value) => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <label>题目疑问 <select aria-label={`题目 ${questionId} 疑问`} value={issue} disabled={disabled || busy} onChange={(event) => setIssue(event.target.value as typeof issue)}>
      <option value="">没有标记疑问</option><option value="answer">答案有疑问</option><option value="ambiguous">题意不清</option><option value="outside-source">超出资料范围</option>
    </select></label>
    {(reason || issue) && <><textarea aria-label={`题目 ${questionId} 复核备注`} value={note} maxLength={reason ? 1_800 : 10_000} disabled={disabled || busy} onChange={(event) => setNote(event.target.value)} placeholder="记录疑问，或用自己的话写下现在的理解" />
      <button className="tbtn" disabled={disabled || busy} onClick={() => void save()}>{busy ? '正在保存反馈…' : '保存补学反馈'}</button></>}
    {message && <p role="status">{message}</p>}
  </div>
}
