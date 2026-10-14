import { useState } from 'react'
import type { CourseSnapshot } from '../../learning/model'
import { buildDailyPlan } from '../../learning/dailyPlan'
import { learningDate } from '../../learning/reviewScheduler'
import { buildKnowledgeCoverage, summarizeLearningCoverage } from '../../learning/coverageView'
import { buildExamPlan, assembleExamQuestions, examQuestionInventory } from '../../learning/examPlan'
import { coursePlanCandidates } from '../../learning/planCandidates'
import { saveEntity } from '../../learning/repository'
import { questionKey } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'
import { useLearningClock } from './useLearningClock'
import ExamSessionPanel from './ExamSessionPanel'
import { loadPersonalCapacity } from '../../learning/preferences'

export default function ReviewDashboard({ snapshot, exam, onPractice, onKnowledge, action, busy }: {
  snapshot: CourseSnapshot; exam: boolean; onPractice: (pointId?: string, questionKey?: string, sessionId?: string) => void; onKnowledge: (id: string) => void; action: LearningAction; busy: boolean
}) {
  const [scope, setScope] = useState(snapshot.points.filter((p) => p.status === 'active' && (snapshot.course.goals ? snapshot.course.goals.some((goal) => goal.confirmed && goal.pointIds.includes(p.id)) : p.goalIncluded)).map((p) => p.id))
  const [date, setDate] = useState(snapshot.course.examDate ?? '')
  const [count, setCount] = useState(10)
  const [showExam, setShowExam] = useState(false)
  const [priorities, setPriorities] = useState<string[]>([])
  const [customTypes, setCustomTypes] = useState(false)
  const [choiceCount, setChoiceCount] = useState(5)
  const [booleanCount, setBooleanCount] = useState(2)
  const [shortCount, setShortCount] = useState(3)
  const [examMinutes, setExamMinutes] = useState(30)
  const now = useLearningClock()
  const today = learningDate(now, snapshot.course.timeZone)
  const candidates = coursePlanCandidates(snapshot)
  const goalPoints = snapshot.points.map((point) => snapshot.course.goals ? { ...point, goalIncluded: snapshot.course.goals.some((goal) => goal.confirmed && goal.pointIds.includes(point.id)) } : point)
  const capacity = loadPersonalCapacity()
  const timeBudgetMinutes = Math.min(capacity.minutes, snapshot.course.dailyMinutes)
  const plan = buildDailyPlan(candidates, { learningDate: today, timeBudgetMinutes, questionLimit: Math.min(capacity.questions, snapshot.course.dailyQuestionLimit) })
  const coverage = buildKnowledgeCoverage(snapshot)
  const summary = summarizeLearningCoverage(goalPoints, coverage, snapshot.course.goalVersion)
  const typeCountValid = !customTypes || [choiceCount, booleanCount, shortCount].every((value) => Number.isInteger(value) && value >= 0) && choiceCount + booleanCount + shortCount === count
  const selectedExam = showExam && typeCountValid ? assembleExamQuestions(examQuestionInventory(snapshot.points, snapshot.archives, snapshot.issues), { scopePointIds: scope, count, ...(customTypes ? { typeCounts: { 'multiple-choice': choiceCount, 'true-false': booleanCount, 'short-answer': shortCount } } : {}) }) : undefined
  let examPlan: ReturnType<typeof buildExamPlan> | undefined
  let dateError = ''
  if (exam && date) { try { examPlan = buildExamPlan(snapshot.points, candidates, { startDate: today, examDate: date, scopePointIds: scope, priorityPointIds: priorities, timeBudgetMinutes, questionLimit: Math.min(capacity.questions, snapshot.course.dailyQuestionLimit) }) } catch { dateError = '考试日期或范围无效，请选择今天之后的日期和有效知识点。' } }
  const openTask = (task: { pointId?: string; targetId?: string }) => task.targetId ? onPractice('', task.targetId) : task.pointId ? onKnowledge(task.pointId) : undefined
  return <section><h3>{exam ? '考前安排' : '今天从这里继续'}</h3><p>{snapshot.course.name} · {today} · 每日 {snapshot.course.dailyMinutes} 分钟 / {snapshot.course.dailyQuestionLimit} 题上限</p>
    {!exam && <><dl className="learning-counts"><div><dt>当前目标知识点</dt><dd>{goalPoints.filter((p) => p.status === 'active' && p.goalIncluded).length}</dd></div><div><dt>有题目关联</dt><dd>{coverage.filter((p) => p.availableQuestionCount > 0).length}</dd></div><div><dt>需要补学</dt><dd>{coverage.filter((p) => p.observation === 'needs-remediation').length}</dd></div><div><dt>未排入今天</dt><dd>{plan.unscheduledCount}</dd></div></dl>
      <p>目标版本 {summary.goalVersion}。这里记录练习和覆盖情况，不计算知识掌握率。</p>
      {plan.selected.length > 0 && <button className="tbtn primary" onClick={() => openTask(plan.selected[0])}>开始今天的学习</button>}
      <ol className="learning-list">{plan.selected.map((task) => <li key={task.id}><strong>{task.title}</strong><span>{task.recommendationReason} · 预计 {task.estimatedMinutes} 分钟</span><button className="tbtn" onClick={() => openTask(task)}>开始</button></li>)}</ol>
      {!plan.selected.length && <p>今天没有已排入的任务。确认知识点、添加复习日期，或在资料页调整每天可用时间。</p>}
      {plan.backlog.length > 0 && <details><summary>查看未排入的 {plan.backlog.length} 项</summary><ul className="learning-list">{plan.backlog.map((task) => <li key={task.id}><strong>{task.title}</strong><span>{task.deferredReason}</span></li>)}</ul></details>}
      {snapshot.sessions.some((s) => s.status === 'active') && <section><h4>继续上次学习</h4>{snapshot.sessions.filter((s) => s.status === 'active').map((s) => <button key={s.id} className="tbtn" onClick={() => onKnowledge(s.pointIds[0])}>{s.title}</button>)}</section>}
      <h4>复习队列</h4><ul className="learning-list">{snapshot.schedules.map((schedule) => <li key={schedule.id}><strong>{schedule.dueDate}</strong><span>{schedule.status === 'paused' ? '已暂停' : schedule.status === 'remediation' ? '先补学再验证' : schedule.manual ? '手动安排' : '规则建议'} · {schedule.ruleVersion}</span>
        <div className="learning-actions"><button className="tbtn" onClick={() => onPractice('', questionKey(schedule.question))}>打开题目</button><button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...schedule, status: schedule.status === 'paused' ? 'active' : 'paused' }, schedule.revision))}>{schedule.status === 'paused' ? '恢复队列' : '暂停复习'}</button></div></li>)}</ul>
    </>}
    {exam && <><p>范围与重点由你确认。系统显示时间和题库缺口，不猜测考试重点或预测成绩。</p><label>考试日期<input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} /></label>
      <fieldset><legend>考试范围</legend>{snapshot.points.filter((p) => p.status === 'active').map((point) => <label className="learning-option" key={point.id}><input type="checkbox" checked={scope.includes(point.id)} onChange={(e) => { setScope(e.target.checked ? [...scope, point.id] : scope.filter((id) => id !== point.id)); setShowExam(false) }} />{point.title}</label>)}</fieldset>
      <fieldset><legend>我标记的重点</legend>{snapshot.points.filter((p) => p.status === 'active' && scope.includes(p.id)).map((point) => <label className="learning-option" key={point.id}><input type="checkbox" checked={priorities.includes(point.id)} onChange={(e) => setPriorities(e.target.checked ? [...priorities, point.id] : priorities.filter((id) => id !== point.id))} />重点 {point.title}</label>)}</fieldset>
      {dateError && <p role="alert">{dateError}</p>}{examPlan && <section><h4>分日安排</h4><p>未安排 {examPlan.unplannedCount} 项，缺学习任务的目标 {examPlan.noTaskPointIds.length} 项。可减少范围或增加可用时间。</p>{examPlan.days.map((day, index) => <div key={index} className="learning-section"><strong>第 {index + 1} 天 · {day.selected.length} 项 / 预计 {day.estimatedMinutes} 分钟</strong><ul>{day.selected.map((task) => <li key={task.id}><button className="tbtn" onClick={() => openTask(task)}>{task.title}</button></li>)}</ul></div>)}</section>}
      <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); setShowExam(true) }}><label>模拟题量<input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label><button className="tbtn" disabled={!scope.length}>用已有题库组卷</button></form>
      <label className="learning-option"><input type="checkbox" checked={customTypes} onChange={(event) => { setCustomTypes(event.target.checked); setShowExam(false) }} />指定各题型数量</label>{customTypes && <div className="learning-fields"><label>选择题数<input type="number" min="0" max="100" value={choiceCount} onChange={(event) => { setChoiceCount(Number(event.target.value)); setShowExam(false) }} /></label><label>判断题数<input type="number" min="0" max="100" value={booleanCount} onChange={(event) => { setBooleanCount(Number(event.target.value)); setShowExam(false) }} /></label><label>简答题数<input type="number" min="0" max="100" value={shortCount} onChange={(event) => { setShortCount(Number(event.target.value)); setShowExam(false) }} /></label></div>}{!typeCountValid && <p role="alert">各题型数量合计须等于模拟题量。</p>}
      <label>模拟时长（分钟）<input type="number" min="1" max="180" value={examMinutes} onChange={(event) => setExamMinutes(Number(event.target.value))} /></label>
      {selectedExam && <section><h4>模拟练习</h4><p>已有 {selectedExam.selected.length} 题，缺 {selectedExam.missingCount} 题；{selectedExam.uncoveredPointIds.length} 个范围知识点没有题目。不会自动补题。</p><p>题型：选择 {selectedExam.typeCounts['multiple-choice']}，判断 {selectedExam.typeCounts['true-false']}，简答 {selectedExam.typeCounts['short-answer']}。检查类型：记忆 {selectedExam.levelCounts.recall}，解释 {selectedExam.levelCounts.explanation}，应用 {selectedExam.levelCounts.application}。</p><ol>{selectedExam.selected.map((item) => <li key={questionKey(item.question)}><button className="tbtn" onClick={() => onPractice('', questionKey(item.question))}>练习 {item.title}</button></li>)}</ol></section>}
      <ExamSessionPanel snapshot={snapshot} selection={selectedExam} scope={scope} action={action} busy={busy} onPractice={onPractice} durationMinutes={examMinutes} />
    </>}
  </section>
}
