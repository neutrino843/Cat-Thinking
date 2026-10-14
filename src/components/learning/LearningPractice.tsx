import { useRef, useState } from 'react'
import type { CourseSnapshot, PracticeAttempt, AssessmentEvent, ReviewSchedule, QuestionRef, PracticeDraft } from '../../learning/model'
import { learningBase, newLearningId } from '../../learning/model'
import { saveEntity, savePracticeBundle, saveLearningBatch } from '../../learning/repository'
import { learningDate, addLearningDays, proposeReviewSchedule, REVIEW_RULE_VERSION } from '../../learning/reviewScheduler'
import { visibleQuestions, questionKey, sameQuestion, referenceAnswer, sourceExcerpt, type ArchivedQuestion } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'
import LearningSupportPanel from './LearningSupportPanel'
import { useLearningClock } from './useLearningClock'

function scheduleFor(snapshot: CourseSnapshot, question: QuestionRef, date: string, manual: boolean): ReviewSchedule {
  return { ...learningBase(snapshot.course.id), kind: 'schedule', question, status: 'active', dueDate: date, stage: 0, manual, ruleVersion: REVIEW_RULE_VERSION }
}

function QuestionPractice({ item, snapshot, action, busy, onKnowledge, sessionId, cardMode = false }: { item: ArchivedQuestion; snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onKnowledge: (id: string) => void; sessionId?: string; cardMode?: boolean }) {
  const q = item.question
  const initial = snapshot.drafts.find((draft) => sameQuestion(draft.question, item.ref))
  const storedAttempt = sessionId ? snapshot.attempts.filter((attempt) => attempt.sessionId === sessionId && sameQuestion(attempt.question, item.ref)).sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))[0] : undefined
  const [answer, setAnswer] = useState<string | number | boolean>(initial?.answer ?? (typeof storedAttempt?.answer === 'string' || typeof storedAttempt?.answer === 'number' || typeof storedAttempt?.answer === 'boolean' ? storedAttempt.answer : ''))
  const [submitted, setSubmitted] = useState<PracticeAttempt | undefined>(storedAttempt)
  const [rubricChecks, setRubricChecks] = useState<boolean[]>(q.type === 'short-answer' ? snapshot.assessments.filter((event) => event.attemptId === storedAttempt?.id).at(-1)?.rubricChecks ?? q.rubric.map(() => false) : [])
  const [difficulty, setDifficulty] = useState<'again' | 'hard' | 'good' | 'easy'>('good')
  const [reason, setReason] = useState('')
  const [nextDate, setNextDate] = useState(() => addLearningDays(learningDate(Date.now(), snapshot.course.timeZone), 1))
  const [draftError, setDraftError] = useState('')
  const [writing, setWriting] = useState(false)
  const [selfSaved, setSelfSaved] = useState(false)
  const [confidence, setConfidence] = useState('')
  const [recallText, setRecallText] = useState(initial?.recallText ?? '')
  const [cardRevealed, setCardRevealed] = useState(initial?.answerRevealed ?? false)
  const draft = useRef<PracticeDraft>(initial ?? { ...learningBase(snapshot.course.id), kind: 'draft', question: item.ref, answer: null, answerRevealed: false, attemptId: newLearningId() })
  const revision = useRef<number | null>(initial?.revision ?? null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const draftFailed = useRef(false)
  const issue = snapshot.issues.find((record) => sameQuestion(record.question, item.ref) && record.status === 'open')
  const schedule = snapshot.schedules.find((record) => sameQuestion(record.question, item.ref))
  const related = snapshot.points.filter((point) => point.status !== 'retired' && point.questionRefs.some((ref) => sameQuestion(ref, item.ref)))
  const currentAssessment = submitted && snapshot.assessments.filter((r) => r.attemptId === submitted.id).at(-1)
  const examSession = sessionId ? snapshot.sessions.find((session) => session.id === sessionId && session.purpose === 'exam') : undefined
  const simulated = examSession?.examConfig?.mode === 'simulation'
  const now = useLearningClock()
  const remainingSeconds = simulated && examSession.examConfig ? Math.max(0, Math.ceil((examSession.createdAt + examSession.examConfig.durationMinutes * 60000 - now) / 1000)) : undefined
  const sourceViewed = () => {
    if (submitted || simulated || draft.current.assistance?.sourceViewed) return
    pending.current++; setWriting(true)
    queue.current = queue.current.then(async () => {
      if (draftFailed.current) return
      const saved = await saveEntity({ ...draft.current, assistance: { hints: 0, fullExplanation: false, recorded: true, ...draft.current.assistance, sourceViewed: true } }, revision.current)
      draft.current = saved; revision.current = saved.revision
    }).catch(() => { draftFailed.current = true; setDraftError('原文查看记录保存失败，请重新读取本题。') }).finally(() => { pending.current--; if (!pending.current) setWriting(false) })
  }
  const updateAnswer = (value: string | number | boolean) => {
    setAnswer(value); setWriting(true); pending.current++
    queue.current = queue.current.then(async () => {
      if (draftFailed.current) return
      const saved = await saveEntity({ ...draft.current, answer: value }, revision.current)
      draft.current = saved; revision.current = saved.revision
    }).catch(() => { draftFailed.current = true; setDraftError('草稿保存冲突或失败，请离开该题再重新读取。') }).finally(() => { pending.current--; if (!pending.current) setWriting(false) })
  }
  const updateRecall = (value: string, reveal = false) => {
    setRecallText(value); if (reveal) setCardRevealed(true)
    pending.current++; setWriting(true)
    queue.current = queue.current.then(async () => {
      if (draftFailed.current) return
      const saved = await saveEntity({ ...draft.current, recallText: value, answerRevealed: draft.current.answerRevealed || reveal }, revision.current)
      draft.current = saved; revision.current = saved.revision
    }).catch(() => { draftFailed.current = true; setDraftError('卡片回忆保存失败，请重新读取。') }).finally(() => { pending.current--; if (!pending.current) setWriting(false) })
  }
  const answered = q.type === 'short-answer' ? typeof answer === 'string' && !!answer.trim() : q.type === 'multiple-choice' ? typeof answer === 'number' : typeof answer === 'boolean'
  const outcome = q.type === 'short-answer' ? 'partial' : q.type === 'multiple-choice' ? answer === q.answerIndex ? 'success' : 'failure' : answer === q.answer ? 'success' : 'failure'
  const propose = (attempt: PracticeAttempt, event: AssessmentEvent) => {
    if (!snapshot.course.automaticReviews) return undefined
    const previous = schedule ?? scheduleFor(snapshot, item.ref, attempt.learningDate, false)
    if (attempt.submittedAt === null) return undefined
    return proposeReviewSchedule(previous, { attemptId: attempt.id, utcTimestamp: attempt.submittedAt, timeZone: snapshot.course.timeZone,
      outcome: event.outcome, answerProvided: answered, answerRevealedBeforeSubmit: attempt.answerRevealed,
      questionType: q.type === 'short-answer' ? 'short-answer' : 'objective', selfAssessmentComplete: event.selfAssessmentComplete, recallDifficulty: event.difficulty }).schedule
  }
  const submit = () => void action(async () => {
    await queue.current
    if (draftFailed.current || !answered || issue) return
    const at = Date.now()
    const previousAt = Math.max(0, ...snapshot.attempts.filter((attempt) => sameQuestion(attempt.question, item.ref)).map((attempt) => attempt.submittedAt ?? 0))
    const supports = (snapshot.supports ?? []).filter((support) => support.questionRef && sameQuestion(support.questionRef, item.ref) && support.viewedAt && support.viewedAt > previousAt && support.mode !== 'feedback')
    const assistance = { hints: supports.filter((support) => support.mode === 'hint' && support.hintLevel !== 3).length, fullExplanation: supports.some((support) => support.mode !== 'hint' || support.hintLevel === 3), sourceViewed: draft.current.assistance?.sourceViewed ?? false, recorded: true }
    const attempt: PracticeAttempt = { ...learningBase(snapshot.course.id, draft.current.attemptId, at), kind: 'attempt', question: item.ref,
      answer, submittedAt: at, learningDate: learningDate(at, snapshot.course.timeZone), answerRevealed: draft.current.answerRevealed || assistance.hints > 0 || assistance.fullExplanation || assistance.sourceViewed, origin: 'practice', assistance, ...(recallText ? { recallText } : {}), ...(confidence ? { confidence: Number(confidence) } : {}), ...(sessionId ? { sessionId } : {}) }
    const assessment: AssessmentEvent | undefined = q.type === 'short-answer' ? undefined : { ...learningBase(snapshot.course.id, newLearningId(), at), kind: 'assessment', attemptId: attempt.id,
      outcome, difficulty: outcome === 'success' ? 'good' : 'again', selfAssessmentComplete: true }
    await savePracticeBundle(attempt, assessment, assessment ? propose(attempt, assessment) : undefined, schedule?.revision ?? null,
      revision.current === null ? undefined : { kind: 'draft', id: draft.current.id, expectedRevision: revision.current })
    setSubmitted(attempt)
  })
  const assess = () => submitted && void action(async () => {
    const complete = answered && rubricChecks.length > 0 && rubricChecks.every(Boolean)
    const event: AssessmentEvent = { ...learningBase(snapshot.course.id), kind: 'assessment', attemptId: submitted.id,
      outcome: complete ? 'success' : rubricChecks.some(Boolean) ? 'partial' : 'failure', difficulty, selfAssessmentComplete: true, rubricChecks, ...(reason ? { reason } : {}) }
    const next = propose(submitted, event)
    await saveLearningBatch([{ entity: event, expectedRevision: null }, ...(next ? [{ entity: next, expectedRevision: schedule?.revision ?? null }] : [])])
    setSelfSaved(true)
  })
  return <article className="learning-question"><h4>{q.prompt}</h4>
    {remainingSeconds !== undefined && <p role="status">模拟剩余 {Math.ceil(remainingSeconds / 60)} 分钟；{remainingSeconds ? '答案和辅助在结束后开放。' : '时间已到，请在备考页结束本场查看报告。'}</p>}
    {cardMode && !simulated && !submitted && <section className="learning-section"><h5>回忆卡片 · 先回想，再翻面</h5><label>我回忆到的内容<textarea maxLength={10000} value={recallText} disabled={busy || !!draftError} onChange={(event) => updateRecall(event.target.value)} /></label><button className="tbtn" disabled={busy || writing || !!draftError || !recallText.trim()} onClick={() => updateRecall(recallText, true)}>已回忆，查看卡片背面</button>{cardRevealed && <><p>参考：{referenceAnswer(item)}</p><p>{q.explanation}</p><p>翻面后的核对作答会记录为看过答案，不计独立延迟成功。</p></>}</section>}
    {issue && <p role="status">这道题已标记有疑问，暂停提交与复习。请在记录页核对并解决疑问。</p>}
    <fieldset hidden={cardMode && !cardRevealed && !submitted} disabled={busy || !!submitted || !!issue || !!draftError || remainingSeconds === 0}><legend>先回答，再查看参考答案</legend>
      {q.type === 'multiple-choice' && q.options.map((option, index) => <label key={index} className="learning-option"><input type="radio" name={questionKey(item.ref)} checked={answer === index} onChange={() => updateAnswer(index)} />{option}</label>)}
      {q.type === 'true-false' && <><label className="learning-option"><input type="radio" name={questionKey(item.ref)} checked={answer === true} onChange={() => updateAnswer(true)} />正确</label><label className="learning-option"><input type="radio" name={questionKey(item.ref)} checked={answer === false} onChange={() => updateAnswer(false)} />错误</label></>}
      {q.type === 'short-answer' && <textarea aria-label="本题简答" maxLength={10000} value={String(answer)} onChange={(e) => updateAnswer(e.target.value)} />}
    </fieldset>
    {!submitted && <><label>提交前的信心（可跳过）<select value={confidence} onChange={(event) => setConfidence(event.target.value)}><option value="">暂不记录</option><option value="25">不太确定</option><option value="50">一般</option><option value="75">比较确定</option><option value="100">很确定</option></select></label><button className="tbtn primary" disabled={busy || writing || !answered || !!draftError || !!issue || remainingSeconds === 0} onClick={submit}>提交本题</button></>}
    {draftError && <p role="alert">{draftError}</p>}{writing && <p role="status">正在保存草稿…</p>}
    {submitted && !simulated && <section className="learning-feedback"><h4>本次反馈</h4><p>{q.type === 'short-answer' ? '简答由你逐项自评。' : outcome === 'success' ? '本次回答与参考答案一致。' : '本次回答与参考答案不一致，建议回查原文。'}</p><p>参考答案：{referenceAnswer(item)}</p><p>{q.explanation}</p>
      {q.type === 'short-answer' && <div>{q.rubric.map((criterion, index) => <label className="learning-option" key={index}><input type="checkbox" checked={rubricChecks[index]} onChange={(e) => { setRubricChecks(rubricChecks.map((value, i) => i === index ? e.target.checked : value)); setSelfSaved(false) }} />{criterion}</label>)}
        <label>回忆难度<select value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}><option value="again">需要再学</option><option value="hard">回忆困难</option><option value="good">可以回忆</option><option value="easy">轻松回忆</option></select></label>
        <button className="tbtn" disabled={busy} onClick={() => void assess()}>保存自评与复习安排</button>{selfSaved && <p role="status">自评已记录，原始答案保留。</p>}</div>}
      <label>这次需要补学的原因<select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">暂不确定</option>{['概念不清','前置不足','读题问题','表达遗漏','暂时忘记','题目疑问','概念混淆','步骤遗漏','计算或操作失误'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="tbtn" disabled={busy || !reason} onClick={() => void action(() => saveLearningBatch([{ entity: { ...learningBase(snapshot.course.id), kind: 'assessment', attemptId: submitted.id,
        outcome: currentAssessment?.outcome ?? (q.type === 'short-answer' ? 'partial' : outcome), difficulty: currentAssessment?.difficulty ?? difficulty,
        selfAssessmentComplete: currentAssessment?.selfAssessmentComplete ?? q.type !== 'short-answer', reason, ...(q.type === 'short-answer' ? { rubricChecks } : {}) }, expectedRevision: null }]))}>记录错因</button>
      <p>当次纠正与不同学习日的再次作答分开记录。同题答对不表示知识点已全部掌握。</p>
      <button className="tbtn" disabled={busy} onClick={() => { setSubmitted(undefined); setAnswer(''); setSelfSaved(false); setRecallText(''); setCardRevealed(false); setConfidence(''); setRubricChecks(q.type === 'short-answer' ? q.rubric.map(() => false) : []); draft.current = { ...learningBase(snapshot.course.id), kind: 'draft', question: item.ref, answer: null, answerRevealed: false, attemptId: newLearningId() }; revision.current = null }}>再练本题 保留历史</button>
    </section>}
    {submitted && simulated && <p role="status">本题已提交。模拟期间隐藏答案、提示与原文；结束场次后在备考报告核对。</p>}
    {!simulated && <><details className="learning-section" onToggle={(event) => { if (event.currentTarget.open) sourceViewed() }}><summary>回看原文依据</summary><p>当前保存的原文版本。引用位置正确不保证参考答案完全正确。</p>{q.citations.filter((citation) => citation.provenance === 'source').map((citation, index) => { const source = sourceExcerpt(item.archive, citation.sourceId, citation.start, citation.end); return <div key={index}><strong>{source?.name ?? '引用不可用'}</strong><small>{source?.location}</small><blockquote>{source?.quote}</blockquote>{source?.truncated && <p>片段过长，仅展示前 4,000 字符。</p>}</div> })}</details>
    <LearningSupportPanel key={submitted?.id ?? 'before-submit'} snapshot={snapshot} pointIds={related.map((point) => point.id)} action={action} busy={busy || writing} questionRef={item.ref} prompt={(q.type === 'multiple-choice' ? `${q.prompt}\n候选说法：${q.options.join('；')}` : q.prompt).slice(0, 3000)} learnerAnswer={submitted ? q.type === 'multiple-choice' && typeof submitted.answer === 'number' ? q.options[submitted.answer] : typeof submitted.answer === 'boolean' ? submitted.answer ? '正确' : '错误' : String(submitted.answer) : undefined} attemptId={submitted?.id} sessionId={sessionId} /></>}
    {!simulated && related.length > 0 && <section><h4>对应知识点</h4><div className="learning-actions">{related.map((point) => <button key={point.id} className="tbtn" onClick={() => onKnowledge(point.id)}>{point.title}</button>)}</div></section>}
    <div className="learning-fields"><label>下次复习日期<input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label><button className="tbtn" disabled={busy || !!issue || !nextDate} onClick={() => void action(() => saveEntity({ ...(schedule ?? scheduleFor(snapshot, item.ref, nextDate, true)), dueDate: nextDate, status: 'active', manual: true }, schedule?.revision ?? null))}>保存手动复习日期</button></div>
    <button className="tbtn" disabled={busy || !!issue} onClick={() => void action(async () => { const record = { ...learningBase(snapshot.course.id), kind: 'issue' as const, question: item.ref, reason: 'answer' as const, note: '用户标记参考答案需要核对', status: 'open' as const };
      await saveLearningBatch([{ entity: record, expectedRevision: null }, ...(schedule ? [{ entity: { ...schedule, status: 'paused' as const, suspendedReason: '题目待核对' }, expectedRevision: schedule.revision }] : [])]) })}>标记题目或答案有疑问</button>
  </article>
}

export default function LearningPractice({ snapshot, pointId, selectedQuestionKey, action, busy, onKnowledge, sessionId, onSelectedQuestion }: { snapshot: CourseSnapshot; pointId: string; selectedQuestionKey: string; action: LearningAction; busy: boolean; onKnowledge: (id: string) => void; sessionId?: string; onSelectedQuestion?: (key: string) => void }) {
  const [selected, setSelected] = useState(selectedQuestionKey)
  const [cardMode, setCardMode] = useState(false)
  const session = sessionId ? snapshot.sessions.find((s) => s.id === sessionId) : undefined
  const questions = visibleQuestions(snapshot, pointId).filter((item) => !sessionId || session?.purpose !== 'exam' || session.questions?.some((ref) => sameQuestion(ref, item.ref)))
  const current = questions.find((item) => questionKey(item.ref) === selected) ?? questions[0]
  return <section><h3>{pointId ? `专项练习 · ${snapshot.points.find((p) => p.id === pointId)?.title ?? ''}` : '课程题库'}</h3>
    <p>使用已有题目，不重新生成。每次提交独立保存；简答由你自评。</p>
    {session?.purpose !== 'exam' && <button className="tbtn" aria-pressed={cardMode} disabled={busy} onClick={() => setCardMode(!cardMode)}>{cardMode ? '切回题目练习' : '切换回忆卡片'}</button>}
    {!!questions.length && <label>选择练习<select aria-label="选择练习" value={current ? questionKey(current.ref) : ''} onChange={(e) => { setSelected(e.target.value); onSelectedQuestion?.(e.target.value) }}>{questions.map((item, index) => <option key={questionKey(item.ref)} value={questionKey(item.ref)}>{index + 1}. {item.question.prompt}</option>)}</select></label>}
    {!questions.length && <p>尚无可准确关联的题目。可以在 AI 分析中明确选择测验并保存资料，已有任务不能事后追加内容。</p>}
    {sessionId && session?.status !== 'active' && <p role="status">这组模拟练习已结束；报告和历史保留。新的练习请从课程题库开始。</p>}
    {current && (!sessionId || session?.status === 'active') && <QuestionPractice key={questionKey(current.ref)} item={current} snapshot={snapshot} action={action} busy={busy} onKnowledge={onKnowledge} sessionId={sessionId} cardMode={cardMode} />}
  </section>
}
