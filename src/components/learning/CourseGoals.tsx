import { useState } from 'react'
import { newLearningId, type CourseGoal, type CourseSnapshot } from '../../learning/model'
import { updateCourse } from '../../learning/repository'
import { courseGoalCoverage } from '../../learning/goalCoverage'
import type { LearningAction } from './CourseOverview'
const LEVELS = { recall: '记忆', explanation: '解释', application: '应用' }
export default function CourseGoals({ snapshot, action, busy }: { snapshot: CourseSnapshot; action: LearningAction; busy: boolean }) {
  const [title, setTitle] = useState('')
  const [level, setLevel] = useState<CourseGoal['level']>('recall')
  const [priority, setPriority] = useState<CourseGoal['priority']>('normal')
  const [pointIds, setPointIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState('')
  const rows = courseGoalCoverage(snapshot)
  return <section className="learning-section"><h4>课程目标目录</h4><p>范围由你确认。目标版本 {snapshot.course.goalVersion}；缺资料、缺题和未练习分别检查，不代表掌握率。</p>
    <form className="learning-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      const goal = { id: editingId || newLearningId(), title: title.trim(), level, priority, pointIds, confirmed: true }
      await updateCourse({ ...snapshot.course, goals: editingId ? snapshot.course.goals?.map((item) => item.id === editingId ? goal : item) : [...snapshot.course.goals ?? [], goal] })
      setTitle(''); setPointIds([]); setEditingId('')
    }) }}>
      <label>本课程要学会什么<input required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="如：解释两阶段之间的联系" /></label>
      <div className="learning-fields"><label>目标层次<select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>{Object.entries(LEVELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
        <label>范围优先级<select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="normal">普通</option><option value="important">重点</option><option value="required">必学</option></select></label></div>
      <fieldset><legend>关联知识点（可稍后完善）</legend>{snapshot.points.filter((point) => point.status !== 'retired').map((point) => <label className="learning-option" key={point.id}><input type="checkbox" checked={pointIds.includes(point.id)} onChange={(event) => setPointIds(event.target.checked ? [...pointIds, point.id] : pointIds.filter((id) => id !== point.id))} />{point.title}</label>)}</fieldset>
      <button className="tbtn" disabled={busy || !title.trim()}>{editingId ? '确认并保存当前目标' : '确认并添加学习目标'}</button>{editingId && <button type="button" className="tbtn" onClick={() => { setEditingId(''); setTitle(''); setPointIds([]) }}>取消编辑目标</button>}
    </form>
    <ul className="learning-list">{rows.map((row) => <li key={row.goal.id}><strong>{row.goal.title}</strong><p>{LEVELS[row.goal.level]} · {row.goal.priority === 'required' ? '必学' : row.goal.priority === 'important' ? '重点' : '普通'} · {row.points.map((point) => point.title).join('、') || '待关联知识点'}</p>
      <p>资料：{row.material ? '有有效依据' : '需要补齐'} · 练习：{row.questions ? '有对应训练' : '需要补齐'} · 作答：{row.practiced ? '有关联作答记录' : '尚未练习'}</p>{row.reasons.map((reason) => <small key={reason}>{reason}；</small>)}
      <div className="learning-actions"><button className="tbtn" disabled={busy} onClick={() => { setEditingId(row.goal.id); setTitle(row.goal.title); setLevel(row.goal.level); setPriority(row.goal.priority); setPointIds(row.goal.pointIds) }}>{row.goal.confirmed ? '编辑目标与关联' : '核对并确认目标'}</button>
        <button className="tbtn" disabled={busy} onClick={() => void action(() => updateCourse({ ...snapshot.course, goals: snapshot.course.goals?.filter((goal) => goal.id !== row.goal.id) }))}>移出当前目标目录</button></div></li>)}</ul>
    <p>{rows.filter((row) => row.goal.confirmed && row.practiced).length} / {rows.filter((row) => row.goal.confirmed).length} 个确认目标有关联作答。统计可逐项回到关联知识及记录；复制或删除目标不会删除历史。</p>
  </section>
}
