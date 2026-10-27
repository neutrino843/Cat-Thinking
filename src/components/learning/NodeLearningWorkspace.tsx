/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { useEffect, useState } from 'react'
import type { CourseSnapshot, KnowledgeRelationType } from '../../learning/model'
import { newLearningId } from '../../learning/model'
import { beginNodeRound, captureNodeSources, collectNodeNote, connectNodePoints, createNodePoint, latestNodeNote, moveNodeBranch, nodeState, reloadNodeState, renameNodeChapter, selectNodePosition, updateNodeState } from '../../learning/nodeLearning'
import { saveEntity } from '../../learning/repository'
import { getNodeCandidatePage, updateNodeFromCandidate, type NodeCandidate } from '../../learning/nodeCandidates'
import type { LearningAction } from './CourseOverview'
import NodeRoundEditor from './NodeRoundEditor'
import NodeFormulaText from './NodeFormulaText'
import './nodeLearning.css'

const RELATIONS: Record<KnowledgeRelationType, string> = { prerequisite: '是其前置知识', step: '用于推导', comparison: '与之对比', application: '应用于', cause: '解释原因', part: '属于其组成' }


export default function NodeLearningWorkspace({ snapshot, action, busy, initialPointId, onDirtyChange }: { snapshot: CourseSnapshot; action: LearningAction; busy: boolean; initialPointId?: string; onDirtyChange: (dirty: boolean) => void }) {
  const state = snapshot.nodeWorkspace
  // 空串不代表「未指定」：必须回退到上次学习节点，否则初始选中退化为索引序随机节点
  const [selected, setSelected] = useState(initialPointId || state?.lastPointId || '')
  const [query, setQuery] = useState(''); const [review, setReview] = useState(false)
  const [newTitle, setNewTitle] = useState(''); const [newChapter, setNewChapter] = useState('')
  const [chapter, setChapter] = useState(state?.chapters[0]?.id ?? '')
  const [sourceDoc, setSourceDoc] = useState(''); const [role, setRole] = useState<'slides' | 'textbook' | 'notes'>('slides')
  const [relationTarget, setRelationTarget] = useState(''); const [relationType, setRelationType] = useState<KnowledgeRelationType>('prerequisite'); const [reason, setReason] = useState('')
  const [returnTo, setReturnTo] = useState<{ pointId: string; roundId?: string }[]>([]); const [dirty, setDirty] = useState(false)
  const [noteEditing, setNoteEditing] = useState(false); const [noteText, setNoteText] = useState('')
  const [roundId, setRoundId] = useState(''); const [candidates, setCandidates] = useState<NodeCandidate[]>([])
  const [checkedCandidates, setCheckedCandidates] = useState<number[]>([])
  const [candidatePage, setCandidatePage] = useState({ offset: 0, hasMore: false })
  const onDirty = (value: boolean) => { setDirty(value); onDirtyChange(value) }
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const point = snapshot.points.find((p) => p.id === (selected || state?.lastPointId) && p.status !== 'retired') ?? snapshot.points.find((p) => p.status !== 'retired')
  const binding = state?.bindings.find((b) => b.pointId === point?.id)
  const activeChapter = state?.chapters.find((c) => c.id === (chapter || binding?.chapterId)) ?? state?.chapters[0]
  const selectedChapterId = activeChapter?.id ?? ''
  const round = state?.rounds.find((r) => r.id === roundId && r.pointId === point?.id) ?? state?.rounds.find((r) => r.id === state.lastRoundId && r.pointId === point?.id) ?? state?.rounds.filter((r) => r.pointId === point?.id).at(-1)
  const go = (id: string, selectedRound = '') => {
    if (dirty || busy || !state) return
    void action(async () => {
      const latest = await reloadNodeState(state.id)
      const targetRound = selectedRound || latest.rounds.filter((r) => r.pointId === id).at(-1)?.id
      await selectNodePosition(latest, id, targetRound)
      setSelected(id); setRoundId(targetRound ?? ''); setReview(false); setNoteEditing(false)
    })
  }
  const depth = (pointId: string) => {
    let node = snapshot.points.find((p) => p.id === pointId)
    const seen = new Set([pointId])
    let value = 0
    while (node?.parentId && !seen.has(node.parentId)) {
      seen.add(node.parentId); node = snapshot.points.find((p) => p.id === node?.parentId); value++
    }
    return Math.min(value, 6)
  }
  if (!state) return <section className="learning-section"><h3>开始搭建这一门课的知识框架</h3><p>先建立章节和节点，再关联课件与教材。没有题库或模型，也可以写理解和连接前面章节。</p><button className="tbtn primary" disabled={busy} onClick={() => void action(() => nodeState(snapshot.course.id))}>建立章节框架</button></section>
  const chooseCandidates = async (offset = 0) => {
    const page = await getNodeCandidatePage(snapshot, offset)
    setCandidates(page.items)
    setCandidatePage({ offset: page.offset, hasMore: page.hasMore })
    setCheckedCandidates([])
  }

  return <section className="node-learning" aria-label="节点学习工作区">
    <header className="node-learning-head"><div><p className="learning-eyebrow">知识框架 · 自主推导</p><h2>{snapshot.course.name}</h2><p>沿着节点学一章，把自己的理由留在框架里。</p></div><button className="tbtn" disabled={dirty} aria-pressed={review} onClick={() => setReview(!review)}>{review ? '回到节点学习' : '整章复习'}</button></header>
    <details className="learning-section"><summary>框架与资料</summary>
      <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => { await updateNodeState(state, (next) => next.chapters.push({ id: newLearningId(), title: newChapter.trim() })); setNewChapter('') }) }}><label>新章节名称<input required maxLength={120} value={newChapter} onChange={(e) => setNewChapter(e.target.value)} /></label><button className="tbtn" disabled={busy || dirty || !newChapter.trim()}>添加章节</button></form>
      <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => { const p = await createNodePoint(state, selectedChapterId, newTitle); setNewTitle(''); setSelected(p.id); setRoundId(''); setReview(false) }) }}><label>所属章节<select value={activeChapter?.id ?? ''} onChange={(e) => setChapter(e.target.value)}>{state.chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>新知识节点<input required maxLength={200} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /></label><button className="tbtn" disabled={busy || dirty || !newTitle.trim()}>添加知识节点</button></form>
      <details><summary>调整章节名称</summary><form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); void action(() => renameNodeChapter(state, selectedChapterId, String(form.get('chapterTitle')))) }}><label>当前章节的新名称<input key={activeChapter?.id} name="chapterTitle" required defaultValue={activeChapter?.title} maxLength={120} /></label><button className="tbtn" disabled={busy || dirty}>保存章节名称</button></form></details>
      <h3>关联资料</h3><p>先在课程“资料”加入文档，再保存可回查的原文快照。不会发给模型，也不创建虚假的生成记录。</p>
      <div className="learning-fields"><label>课程资料<select value={sourceDoc} onChange={(e) => setSourceDoc(e.target.value)}><option value="">选择一份资料</option>{snapshot.docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label><label>资料用途<select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="slides">课件</option><option value="textbook">指定教材</option><option value="notes">个人笔记</option></select></label><button className="tbtn" disabled={busy || dirty || !sourceDoc} onClick={() => void action(() => captureNodeSources(state.courseId, sourceDoc, role))}>保存原文快照</button></div>
      <button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => chooseCandidates())}>检查已有导图与 AI 大纲的节点候选</button><p>AI 生成仍在原“AI 分析”入口明确发起；这里仅检查已保存内容，不新增调用。候选每页最多 500 项，可翻页继续检查；翻页会清除本页勾选。</p>
      {candidates.length > 0 && <nav aria-label="候选分页"><p>第 {Math.floor(candidatePage.offset / 500) + 1} 页，显示 {candidates.length} 项{candidatePage.hasMore ? '；后面还有候选。' : '；已到最后一页。'}</p><button className="tbtn" disabled={busy || dirty || candidatePage.offset === 0} onClick={() => void action(() => chooseCandidates(Math.max(0, candidatePage.offset - 500)))}>上一页候选</button><button className="tbtn" disabled={busy || dirty || !candidatePage.hasMore} onClick={() => void action(() => chooseCandidates(candidatePage.offset + 500))}>下一页候选</button></nav>}
      {candidates.length > 0 && <section><h4>选择并入当前章节的候选</h4><p>保留所选父子层级。没有准确原文定位的节点标为待关联，不用文档开头冒充依据。</p>{candidates.map((c, i) => <div key={c.key}><label className="learning-option"><input type="checkbox" disabled={state.bindings.some((b) => b.originKey === c.key)} checked={checkedCandidates.includes(i)} onChange={(e) => setCheckedCandidates(e.target.checked ? [...checkedCandidates, i] : checkedCandidates.filter((n) => n !== i))} />{c.title} · {c.refs.length ? '有原文定位' : '原文待关联'}{c.parentKey ? ` · 上级：${candidates.find((p) => p.key === c.parentKey)?.title ?? '原结构节点'}` : ''}{state.bindings.some((b) => b.originKey === c.key) ? '（已并入）' : ''}</label>{(() => {
        const matched = state.bindings.find((b) => b.originKey === c.key)
        const existing = snapshot.points.find((p) => p.id === matched?.pointId)
        return existing && existing.title !== c.title && <section><p>名称变化：{existing.title} → {c.title}</p><p>只采用候选名称，保留个人理解、资料和知识联系；旧题关联需重新核对。</p><button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => updateNodeFromCandidate(state, c, existing.revision))}>采用候选名称 · {c.title}</button></section>
      })()}</div>)}<button className="tbtn" disabled={busy || dirty || !checkedCandidates.length} onClick={() => void action(async () => {
        const imported = new Map(state.bindings.filter((b) => b.originKey).map((b) => [b.originKey ?? '', b.pointId]))
        for (let i = 0; i < candidates.length; i++) if (checkedCandidates.includes(i)) { const c = candidates[i]; const parentId = c.parentKey ? imported.get(c.parentKey) : undefined; const p = await createNodePoint(await reloadNodeState(state.id), selectedChapterId, c.title, c.refs, { key: c.key, ...(parentId ? { parentId } : {}) }); imported.set(c.key, p.id) }
        setCandidates([]); setCheckedCandidates([])
      })}>确认新增所选节点</button></section>}
      <details><summary>伊希斯的模型配置教程</summary><ol><li>打开“更多 → AI 设置”，选择你的服务商与模型。</li><li>在设置中的密钥框填写凭据，确认目的主机，保存并连接。不要在学习笔记中填写密钥。</li><li>如需测试问答，主动点击测试，可能消耗模型额度。</li><li>回到节点，选择课件片段；教材按需要补选。准备提示后再次确认生成。</li></ol><p>连接成功只代表连通，提示仍须核对原文。不连接模型也能整理框架、保存理解和复习。</p></details>
    </details>
      <details><summary>已归档节点</summary>{snapshot.points.filter((p) => p.status === 'retired').map((p) => <p key={p.id}>{p.title}<button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => saveEntity({ ...p, status: p.questionRefs.length ? 'pending' : 'active' }, p.revision))}>恢复节点</button></p>)}</details>
    <div className="node-layout"><aside className="node-outline" aria-label="章节大纲"><label>找知识节点<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>{state.chapters.map((c) => <section key={c.id}><h3>{c.title}</h3>{state.bindings.filter((b) => b.chapterId === c.id).map((b) => snapshot.points.find((p) => p.id === b.pointId)).filter((p) => p && p.status !== 'retired' && `${p.title} ${p.notes}`.includes(query)).map((p) => p && <button className="node-outline-item" style={{ paddingInlineStart: `${8 + depth(p.id) * 12}px` }} key={p.id} disabled={busy || dirty} aria-pressed={p.id === point?.id} onClick={() => go(p.id)}>{p.title}</button>)}</section>)}</aside>
      <main className="node-main">{review ? <section aria-label="整章复习"><h3>找回整章思路</h3><p>这是你保存的理解和联系；阅读不会调用模型。</p>{state.chapters.map((c) => <section key={c.id}><h3>{c.title}</h3>{state.bindings.filter((b) => b.chapterId === c.id).map((b) => { const p = snapshot.points.find((p) => p.id === b.pointId); return p && p.status !== 'retired' && <details key={p.id}><summary>{p.title}</summary><NodeFormulaText text={latestNodeNote(snapshot, p.id) || '还没有收录个人理解，可以回节点继续。'} />{snapshot.relations.filter((r) => r.confirmed && (r.fromPointId === p.id || r.toPointId === p.id)).map((r) => <p key={r.id}>{snapshot.points.find((node) => node.id === r.fromPointId)?.title} → {RELATIONS[r.type]} → {snapshot.points.find((node) => node.id === r.toPointId)?.title}<br />{r.reason}</p>)}<button className="tbtn" onClick={() => go(p.id)}>回到这个节点</button></details> })}</section>)}</section>
        : point && binding ? <section aria-label="当前知识节点"><h3>{point.title}</h3><p>{state.chapters.find((c) => c.id === binding.chapterId)?.title}</p>
          {!!returnTo.length && <button className="tbtn" disabled={busy || dirty} onClick={() => { const target = returnTo.at(-1); if (!target) return; setReturnTo(returnTo.slice(0, -1)); go(target.pointId, target.roundId) }}>返回刚才的知识节点</button>}
          <div className="learning-actions"><button className="tbtn" disabled={busy || dirty} onClick={() => void action(async () => { setRoundId(await beginNodeRound(state, point.id)) })}>{round ? '另起一轮自主推导' : '开始这一节点的推导'}</button>{round && <label>学习轮次<select aria-label="学习轮次" disabled={busy || dirty} value={round.id} onChange={(e) => go(point.id, e.target.value)}>{state.rounds.filter((r) => r.pointId === point.id).map((r, i) => <option value={r.id} key={r.id}>第 {i + 1} 轮 · {r.question || '尚未填写问题'}</option>)}</select></label>}</div>
          {round && <NodeRoundEditor key={round.id} round={round} state={state} snapshot={snapshot} action={action} busy={busy} onDirty={onDirty} />}
          <details><summary>个人理解与历史修订</summary><NodeFormulaText text={latestNodeNote(snapshot, point.id) || '本节点尚未收录个人理解。'} />
            <button className="tbtn" disabled={busy || dirty} onClick={() => { setNoteText(latestNodeNote(snapshot, point.id)); setNoteEditing(true); onDirty(true) }}>编辑个人理解</button>
            {noteEditing && <form onSubmit={(e) => { e.preventDefault(); void action(async () => { await collectNodeNote(state, point.id, noteText); setNoteEditing(false); onDirty(false) }) }}><label>修改我的理解<textarea maxLength={20000} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></label><button className="tbtn" disabled={busy || !noteText.trim()}>保存为新的个人理解修订</button><button type="button" className="tbtn" onClick={() => { setNoteEditing(false); onDirty(false) }}>取消本次修改</button></form>}
            {state.notes.filter((n) => n.pointId === point.id).slice().reverse().map((note, i) => <details key={note.id}><summary>修订 {state.notes.filter((n) => n.pointId === point.id).length - i} · {new Date(note.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</summary><NodeFormulaText text={note.text} /><button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => collectNodeNote(state, point.id, note.text))}>以此内容追加新修订</button></details>)}</details>
          <section className="node-relations"><h3>连接前面学过的内容</h3>{snapshot.relations.filter((r) => r.confirmed && (r.fromPointId === point.id || r.toPointId === point.id)).map((r) => { const other = snapshot.points.find((p) => p.id === (r.fromPointId === point.id ? r.toPointId : r.fromPointId)); return <article key={r.id}><p>{snapshot.points.find((p) => p.id === r.fromPointId)?.title} → {RELATIONS[r.type]} → {snapshot.points.find((p) => p.id === r.toPointId)?.title}</p><p>{r.reason || '尚未写下联系的理由。'}</p><button className="tbtn" disabled={busy || dirty || !other || other.status === 'retired'} onClick={() => { if (other) { setReturnTo([...returnTo, { pointId: point.id, roundId: round?.id }]); go(other.id) } }}>查看关联节点 · {other?.chapter || '未分章'} · {other?.title}</button></article> })}
            <form onSubmit={(e) => { e.preventDefault(); void action(async () => { await connectNodePoints(state.courseId, relationType === 'prerequisite' ? relationTarget : point.id, relationType === 'prerequisite' ? point.id : relationTarget, relationType, reason); setReason(''); setRelationTarget('') }) }}>
              <label>关联节点<select required value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)}><option value="">选择另一章节或当前章节的节点</option>{snapshot.points.filter((p) => p.id !== point.id && p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.chapter || '未分章'} · {p.title}</option>)}</select></label>
              <label>关系类型<select value={relationType} onChange={(e) => setRelationType(e.target.value as KnowledgeRelationType)}><option value="prerequisite">所选节点是当前节点的前置知识</option><option value="step">当前节点用于推导所选节点</option><option value="comparison">当前节点与所选节点对比</option><option value="application">当前节点应用于所选节点</option></select></label><label>为什么有这个联系<textarea maxLength={3000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：这一等式用到了前面定义中的哪个条件。" /></label><button className="tbtn" disabled={busy || dirty || !relationTarget}>保存知识联系</button>
            </form>
          </section>
          <details><summary>移动或归档这个节点</summary><form onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); void action(() => moveNodeBranch(state, point.id, String(data.get('moveChapter')))) }}><label>移动到章节<select name="moveChapter" defaultValue={binding.chapterId}>{state.chapters.map((c) => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label><p>同时移动子节点；个人理解、推导和知识联系保留。</p><button className="tbtn" disabled={busy || dirty}>移动节点及子节点</button></form><button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => saveEntity({ ...point, status: 'retired' }, point.revision))}>归档节点，保留学习历史</button></details>
          <details><summary>修改节点名称与说明</summary><form key={point.id + ':' + point.revision} onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); void action(() => saveEntity({ ...point, title: String(form.get('title')), definition: String(form.get('definition')), questionRefs: point.questionRefs.map((ref) => ({ ...ref, confirmed: false })) }, point.revision)) }}><label>节点名称<input name="title" defaultValue={point.title} required maxLength={200} /></label><label>核心说明<textarea name="definition" defaultValue={point.definition} maxLength={10000} /></label><button className="tbtn" disabled={busy || dirty}>保存节点修订</button></form><p>修改概念含义后须重新核对旧题关联，旧历史保留。</p></details>
        </section> : <p>先展开“框架与资料”，建立一个知识节点。可以手动添加，不需要先生成题目。</p>}
      </main></div>
  </section>
}
