import { useState } from 'react'
import type { CourseSnapshot, KnowledgePoint, KnowledgeRelation, ApplicationTask } from '../../learning/model'
import { learningBase, newLearningId } from '../../learning/model'
import { saveEntity, commitGraphChanges } from '../../learning/repository'
import { findKnowledgeCandidates, buildLearningPath, addConfirmedPrerequisite, mergeKnowledgePoints, undoKnowledgeMerge, resolveKnowledgePointId, questionRefKey } from '../../learning/knowledgeGraph'
import { buildKnowledgeCoverage } from '../../learning/coverageView'
import { sourceExcerpt, sameQuestion, archivedQuestions } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'
import GuidedLearning from './GuidedLearning'

const COVERAGE = { 'no-questions': '尚无题目', 'recall-only': '目前只有记忆练习', 'has-explanation': '有解释练习', 'has-application': '有应用任务' }
const OBSERVATION = { unpracticed: '尚未练习', 'needs-remediation': '建议补学', 'awaiting-review': '待复习', 'delayed-success': '已有不同日成功', 'assessment-pending': '待自评', 'self-assessed': '已完成自评', 'practice-recorded': '有练习记录', paused: '已暂停' }
function PointEditor({ point, snapshot, action, busy }: { point: KnowledgePoint; snapshot: CourseSnapshot; action: LearningAction; busy: boolean }) {
  const [title, setTitle] = useState(point.title)
  const [definition, setDefinition] = useState(point.definition)
  const [chapter, setChapter] = useState(point.chapter)
  const [notes, setNotes] = useState(point.notes)
  const [revision, setRevision] = useState(point.revision)
  const [confirmRefs, setConfirmRefs] = useState<string[]>(point.questionRefs.filter((r) => r.confirmed).map((r) => `${r.archiveId}/${r.artifactId}/${r.questionId}`))
  const [includeGoal, setIncludeGoal] = useState(point.goalIncluded === true)
  const [levels, setLevels] = useState(point.questionLevels ?? {})
  const allQuestions = archivedQuestions(snapshot.archives)
  return <form className="learning-form" onSubmit={(e) => { e.preventDefault(); void action(async () => {
    const semanticChange = title !== point.title || definition !== point.definition
    const saved = await saveEntity({ ...point, title, definition, chapter, notes, goalIncluded: includeGoal, questionLevels: levels,
      status: semanticChange ? 'pending' : point.status,
      questionRefs: point.questionRefs.map((r) => ({ ...r, confirmed: !semanticChange && confirmRefs.includes(`${r.archiveId}/${r.artifactId}/${r.questionId}`) })) }, revision)
    setRevision(saved.revision)
  }) }}>
    <label>知识点名称<input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
    <label>核心说明<textarea value={definition} onChange={(e) => setDefinition(e.target.value)} maxLength={10000} /></label>
    <label>所属章节<input value={chapter} maxLength={120} onChange={(e) => setChapter(e.target.value)} /></label>
    <label>我的补充<textarea value={notes} maxLength={10000} onChange={(e) => setNotes(e.target.value)} placeholder="记录自己的解释，和原文依据分开" /></label>
    <label className="learning-option"><input type="checkbox" checked={includeGoal} onChange={(e) => setIncludeGoal(e.target.checked)} />纳入当前课程学习目标</label>
    {point.questionRefs.length > 0 && <fieldset><legend>确认题目归属 共同依据只表示相关</legend>{point.questionRefs.map((ref) => {
      const key = `${ref.archiveId}/${ref.artifactId}/${ref.questionId}`
      const q = allQuestions.find((item) => sameQuestion(item.ref, ref))
      return <div key={key}><label className="learning-option"><input type="checkbox" checked={confirmRefs.includes(key)} onChange={(e) => setConfirmRefs(e.target.checked ? [...confirmRefs, key] : confirmRefs.filter((k) => k !== key))} />{q?.question.prompt ?? '题目不可用'}</label><label>我确认的练习类型 · {q?.question.prompt}<select value={levels[questionRefKey(ref)] ?? 'recall'} onChange={(e) => setLevels({ ...levels, [questionRefKey(ref)]: e.target.value as 'recall' | 'explanation' | 'application' })}><option value="recall">记忆</option><option value="explanation">解释</option><option value="application">应用</option></select></label></div>
    })}</fieldset>}
    <div className="learning-actions"><button className="tbtn" disabled={busy}>保存知识整理</button><button type="button" className="tbtn" disabled={busy || title !== point.title || definition !== point.definition || revision !== point.revision} onClick={() => void action(async () => {
      const saved = await saveEntity({ ...point, status: 'active', questionLevels: levels, questionRefs: point.questionRefs.map((r) => ({ ...r, confirmed: confirmRefs.includes(`${r.archiveId}/${r.artifactId}/${r.questionId}`) })), goalIncluded: includeGoal }, revision)
      setRevision(saved.revision)
    })}>确认当前知识与题目归属</button></div>
    <p>修改名称或核心说明后会转为待确认。原文副本保持保存时的版本。</p>
    {(title !== point.title || definition !== point.definition) && <p>先保存名称与核心说明，再确认这份已保存的知识。</p>}
    {revision !== point.revision && <p role="status">知识点已被其他操作更新。请重新读取后确认。</p>}
    <button className="tbtn" type="button" disabled={busy} onClick={() => { setTitle(point.title); setDefinition(point.definition); setChapter(point.chapter); setNotes(point.notes); setRevision(point.revision); setConfirmRefs(point.questionRefs.filter((r) => r.confirmed).map((r) => `${r.archiveId}/${r.artifactId}/${r.questionId}`)); setIncludeGoal(point.goalIncluded === true); setLevels(point.questionLevels ?? {}) }}>重新读取知识点</button>
  </form>
}

function ApplicationEditor({ task, action, busy }: { task: ApplicationTask; action: LearningAction; busy: boolean }) {
  const [response, setResponse] = useState(task.response)
  const [checks, setChecks] = useState(task.checks)
  const [revision, setRevision] = useState(task.revision)
  return <form className="learning-section" onSubmit={(e) => { e.preventDefault(); void action(async () => {
    const saved = await saveEntity({ ...task, response, checks, status: response.trim() && task.rubric.length > 0 && checks.length === task.rubric.length && checks.every(Boolean) ? 'completed' : 'pending' }, revision)
    setRevision(saved.revision)
  }) }}><h4>{task.title}</h4><p>{task.prompt}</p><label>我的解释 预测与实际观察<textarea value={response} maxLength={10000} onChange={(e) => setResponse(e.target.value)} /></label>
    {task.rubric.map((item, index) => <label className="learning-option" key={index}><input type="checkbox" checked={checks[index]} onChange={(e) => setChecks(checks.map((v, i) => i === index ? e.target.checked : v))} />自评 {item}</label>)}
    <button className="tbtn" disabled={busy}>保存应用任务</button><p>自评完成不表示迁移能力已达标；实验与重要结论仍需要实际执行或他人核对。</p></form>
}

export default function KnowledgeWorkspace({ snapshot, selectedPointId, onSelectPoint, onPractice, action, busy, applicationOnly = false }: {
  snapshot: CourseSnapshot; selectedPointId: string; onSelectPoint: (id: string) => void; onPractice: (pointId: string) => void; action: LearningAction; busy: boolean; applicationOnly?: boolean
}) {
  const [newTitle, setNewTitle] = useState('')
  const [query, setQuery] = useState('')
  const [prerequisite, setPrerequisite] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [rubric, setRubric] = useState('说明关键概念\n结合原文或实际观察\n标明仍需核对的问题')
  const [hiddenPointId, setHiddenPointId] = useState('')
  const point = snapshot.points.find((p) => p.id === selectedPointId && p.status !== 'retired') ?? snapshot.points.find((p) => p.status !== 'retired')
  const coverage = buildKnowledgeCoverage(snapshot)
  const observations = new Map(coverage.map((item) => [item.pointId, item]))
  const candidates = point ? findKnowledgeCandidates(point, snapshot.points) : []
  const practiced = snapshot.points.filter((p) => snapshot.attempts.some((a) => p.questionRefs.some((r) => r.confirmed && sameQuestion(r, a.question)))).map((p) => p.id)
  const path = buildLearningPath(snapshot, practiced)
  const mergePoint = snapshot.points.find((p) => p.id === mergeTarget)
  const latestMerge = snapshot.merges.filter((m) => m.action === 'merge' && !snapshot.merges.some((u) => u.undoOf === m.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).at(-1)
  const graphExpected = { points: Object.fromEntries(snapshot.points.map((p) => [p.id, p.revision])), relations: Object.fromEntries(snapshot.relations.map((r) => [r.id, r.revision])) }
  const session = snapshot.sessions.filter((s) => s.status === 'active' && point && s.pointIds.includes(point.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).at(-1)
  return <section><h3>{applicationOnly ? '解释与应用任务' : '知识体系与学习单元'}</h3>
    {!applicationOnly && <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => {
      const saved: KnowledgePoint = await saveEntity({ ...learningBase(snapshot.course.id), kind: 'point', title: newTitle.trim(), definition: '', chapter: '', aliases: [], notes: '', sourceRefs: [], questionRefs: [], status: 'active', goalIncluded: false }, null)
      setNewTitle(''); onSelectPoint(saved.id)
    }) }}><label>新增我的知识点<input value={newTitle} maxLength={200} required onChange={(e) => setNewTitle(e.target.value)} /></label><button className="tbtn" disabled={busy || !newTitle.trim()}>添加知识点</button></form>}
    <div className="learning-split"><aside className="learning-tree"><label>查找知识点<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      {snapshot.points.filter((p) => p.status !== 'retired' && `${p.title} ${p.chapter} ${p.aliases.join(' ')}`.includes(query)).map((p) => <button className="learning-tree-item" key={p.id} aria-pressed={point?.id === p.id} onClick={() => onSelectPoint(p.id)}>
        <strong>{p.title}</strong><small>{p.chapter || '暂未分章'} · {p.status === 'pending' ? '待确认' : OBSERVATION[observations.get(p.id)?.observation ?? 'unpracticed']}</small></button>)}
      {!snapshot.points.length && <p>还没有知识点。可以手工创建，或从 AI 分析保存学习资料。</p>}</aside>
      {point && <div className="learning-detail">
        <h4>{point.title}</h4><p>{point.status === 'pending' ? '资料关联待你确认。' : '知识点身份已确认。'} {COVERAGE[observations.get(point.id)?.coverageStatus ?? 'no-questions']}</p>
        {!applicationOnly && <><div className="learning-actions"><button className="tbtn primary" onClick={() => onPractice(point.id)}>练这个知识点</button>
          <button className="tbtn" disabled={busy || !!session} onClick={() => void action(() => saveEntity({ ...learningBase(snapshot.course.id), kind: 'session', title: point.title, pointIds: [point.id], status: 'active', steps: ['read','recall','practice','source','explain'].map((item) => ({ pointId: point.id, action: item as 'read', status: 'pending', note: '' })) }, null))}>开始引导学习</button></div>
          {session && <GuidedLearning key={session.id} session={session} snapshot={snapshot} point={point} action={action} busy={busy} onPractice={() => onPractice(point.id)} hidden={hiddenPointId === point.id} onHide={(hidden) => setHiddenPointId(hidden ? point.id : '')} />}
          <div hidden={hiddenPointId === point.id}><PointEditor key={point.id} point={point} snapshot={snapshot} action={action} busy={busy} /></div>
          <details className="learning-section"><summary>原文依据 {point.sourceRefs.length}</summary>{point.sourceRefs.map((ref, index) => { const archive = snapshot.archives.find((a) => a.id === ref.archiveId); const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end); return <div key={index}><strong>{source?.name ?? '原文不可用'}</strong><small>{source?.location}</small><blockquote>{source?.quote}</blockquote></div> })}{!point.sourceRefs.length && <p>这是个人整理，尚无已保存原文依据。</p>}</details>
          {observations.get(point.id)?.reasons.map((reason) => <p key={reason}>{reason}</p>)}
          <h4>确认前置知识</h4><form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => {
            const relation: KnowledgeRelation = { ...learningBase(snapshot.course.id), kind: 'relation', fromPointId: prerequisite, toPointId: point.id, type: 'prerequisite', confirmed: true }
            const relations = addConfirmedPrerequisite(snapshot, relation)
            await commitGraphChanges(snapshot.course.id, { points: snapshot.points, relations }, graphExpected)
            setPrerequisite('')
          }) }}><label>先学哪个知识点<select value={prerequisite} onChange={(e) => setPrerequisite(e.target.value)} required><option value="">请选择</option>{snapshot.points.filter((p) => p.id !== point.id && p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label><button className="tbtn" disabled={busy || !prerequisite}>确认前置关系</button></form>
          <p>{path.find((unit) => unit.pointId === point.id)?.reason ?? '确认知识点后可加入学习路径。'}</p>
          <h4>跨资料概念候选</h4><p>同名只产生候选。比较定义与来源后，再决定是否是同一概念。</p><select aria-label="选择概念合并候选" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}><option value="">保持分开</option>{snapshot.points.filter((p) => p.id !== point.id && p.status === 'active').map((p) => <option value={p.id} key={p.id}>{p.title}{candidates.some((c) => c.toPointId === p.id) ? ' · 名称候选' : ''}</option>)}</select>
          {mergePoint && <section className="learning-section"><h4>确认页</h4><p>当前：{point.title} · {hiddenPointId === point.id ? '说明已隐藏，请结束回忆后再比较定义' : point.definition || '尚无定义'} · {point.sourceRefs.length} 条依据</p><p>候选：{mergePoint.title} · {mergePoint.definition || '尚无定义'} · {mergePoint.sourceRefs.length} 条依据</p>
            <div className="learning-actions"><button className="tbtn" disabled={busy} onClick={() => void action(async () => { const transformed = mergeKnowledgePoints(snapshot, point.id, mergePoint.id, { eventId: newLearningId(), at: Date.now(), confirmed: true }); await commitGraphChanges(snapshot.course.id, transformed, graphExpected); onSelectPoint(mergePoint.id); setMergeTarget('') })}>确认为同一概念并合并</button>
              <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...learningBase(snapshot.course.id), kind: 'relation', fromPointId: point.id, toPointId: mergePoint.id, type: 'comparison', confirmed: true }, null))}>相关但不同 记录比较关系</button><button className="tbtn" onClick={() => setMergeTarget('')}>保持分开</button></div></section>}
          {latestMerge && <><button className="tbtn" disabled={busy || !!latestMerge.undoDisabledReason} onClick={() => void action(async () => { const transformed = undoKnowledgeMerge(snapshot, latestMerge.id, { eventId: newLearningId(), at: Date.now() }); await commitGraphChanges(snapshot.course.id, transformed, graphExpected) })}>撤销最近一次概念合并</button>{latestMerge.undoDisabledReason && <p>{latestMerge.undoDisabledReason}</p>}</>}
        </>}
        <h4>我的应用任务</h4><form className="learning-form" onSubmit={(e) => { e.preventDefault(); void action(async () => { const criteria = rubric.split('\n').map((r) => r.trim()).filter(Boolean); await saveEntity({ ...learningBase(snapshot.course.id), kind: 'application', pointIds: [point.id], title: taskTitle, prompt: taskPrompt, response: '', rubric: criteria, checks: criteria.map(() => false), status: 'pending' }, null); setTaskTitle(''); setTaskPrompt('') }) }}>
          <label>任务名称<input value={taskTitle} maxLength={200} onChange={(e) => setTaskTitle(e.target.value)} required placeholder="解释、比较、案例或实验观察" /></label><label>我要验证什么<textarea value={taskPrompt} maxLength={10000} onChange={(e) => setTaskPrompt(e.target.value)} required /></label><label>自评要点 每行一项<textarea value={rubric} onChange={(e) => setRubric(e.target.value)} maxLength={2000} required /></label><button className="tbtn" disabled={busy || !rubric.trim() || !taskTitle.trim() || !taskPrompt.trim()}>创建应用任务</button></form>
        {snapshot.applicationTasks.filter((task) => task.pointIds.some((id) => resolveKnowledgePointId(id, snapshot.merges) === point.id)).map((task) => <ApplicationEditor key={task.id} task={task} action={action} busy={busy} />)}
      </div>}
    </div>
  </section>
}
