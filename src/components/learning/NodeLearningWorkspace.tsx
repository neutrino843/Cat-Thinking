/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { useEffect, useRef, useState } from 'react'
import type { CourseSnapshot, KnowledgeRelationType } from '../../learning/model'
import { newLearningId } from '../../learning/model'
import { beginNodeRound, captureNodeSources, collectNodeNote, connectNodePoints, createNodePoint, latestNodeNote, moveNodeBranch, nodeState, prepareNodeHint, reloadNodeState, renameNodeChapter, saveNodeDraft, updateNodeState } from '../../learning/nodeLearning'
import type { NodeLearningState, NodeRound, NodeSourceRef } from '../../learning/nodeTypes'
import { saveEntity } from '../../learning/repository'
import { db } from '../../store/db'
import type { LearningAction } from './CourseOverview'
import NodeHintPanel from './NodeHintPanel'
import NodeFormulaText from './NodeFormulaText'
import './nodeLearning.css'

const RELATIONS: Record<KnowledgeRelationType, string> = { prerequisite: '是其前置知识', step: '用于推导', comparison: '与之对比', application: '应用于', cause: '解释原因', part: '属于其组成' }

function RoundEditor({ round, state, snapshot, action, busy, onDirty }: { round: NodeRound; state: NodeLearningState; snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onDirty: (dirty: boolean) => void }) {
  const [question, setQuestion] = useState(round.question)
  const [input, setInput] = useState(round.input)
  const [refs, setRefs] = useState<NodeSourceRef[]>(round.refs)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(true)
  const base = useRef(state); const edited = useRef(false); const sequence = useRef(0); const saving = useRef(Promise.resolve())
  const refsKey = JSON.stringify(refs)
  useEffect(() => {
    let live = true
    queueMicrotask(() => {
      if (live && !edited.current && state.revision > base.current.revision) {
        const current = state.rounds.find((r) => r.id === round.id)
        if (current) { setQuestion(current.question); setInput(current.input); setRefs(current.refs) }
        base.current = state
      }
    })
    return () => { live = false }
  }, [state, round.id])
  useEffect(() => {
    if (!edited.current || error) return
    const token = sequence.current
    const timer = setTimeout(() => {
      saving.current = saving.current.then(async () => {
        try {
          const next = await saveNodeDraft(base.current, round.id, question, input, refs)
          base.current = next
          if (token === sequence.current) { edited.current = false; setSaved(true); onDirty(false) }
        } catch (err) { setError(err instanceof Error ? err.message : '草稿保存失败。请保留文字后重试。'); setSaved(false); onDirty(true) }
      })
    }, 500)
    return () => clearTimeout(timer)
  // Local edits alone schedule writes. Snapshot refreshes do not restart or overwrite drafts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, input, refsKey, error])
  const change = () => { edited.current = true; sequence.current++; setSaved(false); onDirty(true) }
  const viewed = state.events.filter((e) => e.roundId === round.id && e.type === 'hint-viewed')
  const nextLevel = Math.min(2, Math.max(0, ...viewed.map((e) => e.level ?? 0)) + 1) as 1 | 2
  return <section className="node-round" aria-label="本轮自主推导">
    <h3>从这里继续推导</h3>
    <label>这一轮想弄清什么<textarea aria-label="这一轮想弄清什么" maxLength={3000} value={question} onChange={(e) => { change(); setQuestion(e.target.value) }} placeholder="例如：这一步为什么可以成立？我缺少哪一个前提？" /></label>
    <label>我已经想到的步骤<textarea aria-label="我已经想到的步骤" className="node-draft" maxLength={10000} value={input} onChange={(e) => { change(); setInput(e.target.value) }} placeholder="写关键理由、步骤或卡住的位置。可以用 $...$ 记录公式。" /></label>
    <p role="status">{saved ? '草稿已保存在本机，尚未自动收录为个人理解。' : error ? '草稿尚未保存，当前文字仍在此处。' : '正在保存草稿…'}</p>
    {error && <section role="alert"><p>{error}</p><button className="tbtn" onClick={() => void (async () => { const latest = await reloadNodeState(state.id); const newer = latest.rounds.find((r) => r.id === round.id); if (newer && (newer.question !== round.question || newer.input !== round.input)) setError(`另一页面内容：${newer.question}\n${newer.input}\n请先复制需要保留的两版内容，再明确保存本页草稿。`); base.current = latest })().catch((err: unknown) => setError(String(err)))}>读取另一版本，保留本页文字</button><button className="tbtn" onClick={() => { sequence.current++; edited.current = true; setError('') }}>明确重试保存本页草稿</button></section>}
    <details className="node-sources"><summary>本次提示依据 · {refs.length} 处片段，可调整</summary>
      <p>只发送勾选片段和本轮文字，合计最多 24,000 字符；不是发送整本教材。图片和公式仍需核对原附件。</p>
      {state.sources.map((source) => {
        const selected = refs.find((r) => r.snapshotId === source.id)
        const update = (start: number, end: number) => { change(); setRefs(refs.map((r) => r.snapshotId === source.id ? { ...r, start, end } : r)) }
        return <section key={source.id}><label className="learning-option"><input type="checkbox" checked={!!selected} onChange={(e) => { change(); setRefs(e.target.checked ? [...refs, { snapshotId: source.id, start: 0, end: Math.min(source.text.length, 12000) }] : refs.filter((r) => r.snapshotId !== source.id)) }} />{source.role === 'textbook' ? '教材' : source.role === 'slides' ? '课件' : '笔记'} · {source.name}</label>
          {selected && <div className="learning-fields"><label>起始字符<input type="number" min={0} max={source.text.length - 1} value={selected.start} onChange={(e) => update(Number(e.target.value), selected.end)} /></label><label>结束字符<input type="number" min={selected.start + 1} max={source.text.length} value={selected.end} onChange={(e) => update(selected.start, Number(e.target.value))} /></label></div>}
          <details><summary>阅读原文快照</summary><p>可用位置：{source.locators.slice(0, 8).map((l) => l.page ? `文档页 ${l.page}` : l.titlePath.join(' / ')).join('；') || '字符位置'}。页码为文档页，不保证等于教材印刷页码。</p><pre>{selected ? source.text.slice(selected.start, selected.end) : source.text}</pre></details>
        </section>
      })}
      {!state.sources.length && <p>先在“关联资料”保存课件或教材快照，再选取相关片段。</p>}
    </details>
    <div className="learning-actions">
      <button className="tbtn primary" disabled={!saved || busy || !input.trim()} onClick={() => void action(async () => { await collectNodeNote(await reloadNodeState(state.id), round.pointId, input, round.id) })}>保存为个人理解</button>
      <button className="tbtn" disabled={!saved || busy || !question.trim() || !refs.length} onClick={() => void action(async () => { await prepareNodeHint(await reloadNodeState(state.id), round.id, nextLevel) })}>{nextLevel === 1 ? '准备第一级提示' : '准备更明确的提示'}</button>
      <button className="tbtn" disabled={!saved || busy || !question.trim() || !refs.length} onClick={() => void action(async () => { await prepareNodeHint(await reloadNodeState(state.id), round.id, 3) })}>准备完整解释（会揭示完整思路）</button>
    </div>
    <details><summary>预览我的公式与文字</summary><NodeFormulaText text={input} /></details>
    <p>提示只在确认生成后调用模型。看过解释与自己推导分别记录，不自动评定掌握程度。</p>
    {state.supports.filter((s) => s.roundId === round.id).map((support) => <NodeHintPanel key={support.id} support={support} snapshot={snapshot} action={action} busy={busy || !saved} />)}
  </section>
}

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
  const [roundId, setRoundId] = useState(''); const [candidates, setCandidates] = useState<{ key: string; parentKey?: string; title: string; refs: NodeSourceRef[] }[]>([])
  const [checkedCandidates, setCheckedCandidates] = useState<number[]>([])
  const onDirty = (value: boolean) => { setDirty(value); onDirtyChange(value) }
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const point = snapshot.points.find((p) => p.id === selected && p.status !== 'retired') ?? snapshot.points.find((p) => p.status !== 'retired')
  const binding = state?.bindings.find((b) => b.pointId === point?.id)
  const activeChapter = state?.chapters.find((c) => c.id === (chapter || binding?.chapterId)) ?? state?.chapters[0]
  const selectedChapterId = activeChapter?.id ?? ''
  const round = state?.rounds.find((r) => r.id === roundId && r.pointId === point?.id) ?? state?.rounds.find((r) => r.id === state.lastRoundId && r.pointId === point?.id) ?? state?.rounds.filter((r) => r.pointId === point?.id).at(-1)
  const go = (id: string, selectedRound = '') => { if (dirty) return; setSelected(id); setRoundId(selectedRound); setReview(false); setNoteEditing(false) }
  if (!state) return <section className="learning-section"><h3>开始搭建这一门课的知识框架</h3><p>先建立章节和节点，再关联课件与教材。没有题库或模型，也可以写理解和连接前面章节。</p><button className="tbtn primary" disabled={busy} onClick={() => void action(() => nodeState(snapshot.course.id))}>建立章节框架</button></section>
  const chooseCandidates = async () => {
    const result: typeof candidates = []
    for (const membership of snapshot.documents) {
      const row = await db.docs.get(membership.docId)
      if (!row) continue
      const doc = JSON.parse(row.payload) as { rootId: string; nodes: Record<string, { id: string; text: string; parent: string | null; children: string[] }> }
      const visit = (id: string, parentKey?: string) => {
        const node = doc.nodes[id]; if (!node) return
        const key = JSON.stringify(['doc', membership.docId, node.id])
        if (id !== doc.rootId && node.text.trim()) result.push({ key, parentKey, title: node.text.slice(0, 200), refs: state.sources.filter((s) => s.originDocId === membership.docId && s.role === 'slides').flatMap((s) => (s.anchors ?? []).filter((a) => a.nodeId === node.id).map((a) => ({ snapshotId: s.id, start: a.start, end: a.end }))) })
        node.children.forEach((child) => visit(child, id === doc.rootId ? undefined : key))
      }
      visit(doc.rootId)
    }
    for (const archive of snapshot.archives) for (const artifact of archive.artifacts) if (artifact.kind === 'outline') {
      const visit = (nodes: typeof artifact.payload.nodes, parentKey?: string) => { for (const node of nodes) {
        const key = JSON.stringify(['archive', archive.id, node.id])
        const refs = node.citations.flatMap((cite) => cite.provenance === 'source' ? state.sources.filter((s) => s.originSourceId === cite.sourceId && s.contentHash === archive.sources.find((s) => s.id === cite.sourceId)?.contentHash).map((s) => ({ snapshotId: s.id, start: cite.start, end: cite.end })) : [])
        result.push({ key, parentKey, title: node.title.slice(0, 200), refs }); visit(node.children, key)
      } }; visit(artifact.payload.nodes)
    }
    setCandidates(result.slice(0, 500)); setCheckedCandidates([])
  }
  return <section className="node-learning" aria-label="节点学习工作区">
    <header className="node-learning-head"><div><p className="learning-eyebrow">知识框架 · 自主推导</p><h2>{snapshot.course.name}</h2><p>沿着节点学一章，把自己的理由留在框架里。</p></div><button className="tbtn" disabled={dirty} aria-pressed={review} onClick={() => setReview(!review)}>{review ? '回到节点学习' : '整章复习'}</button></header>
    <details className="learning-section"><summary>框架与资料</summary>
      <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => { await updateNodeState(state, (next) => next.chapters.push({ id: newLearningId(), title: newChapter.trim() })); setNewChapter('') }) }}><label>新章节名称<input required maxLength={120} value={newChapter} onChange={(e) => setNewChapter(e.target.value)} /></label><button className="tbtn" disabled={busy || dirty || !newChapter.trim()}>添加章节</button></form>
      <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => { const p = await createNodePoint(state, selectedChapterId, newTitle); setNewTitle(''); go(p.id) }) }}><label>所属章节<select value={activeChapter?.id ?? ''} onChange={(e) => setChapter(e.target.value)}>{state.chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>新知识节点<input required maxLength={200} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /></label><button className="tbtn" disabled={busy || dirty || !newTitle.trim()}>添加知识节点</button></form>
      <details><summary>调整章节名称</summary><form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); void action(() => renameNodeChapter(state, selectedChapterId, String(form.get('chapterTitle')))) }}><label>当前章节的新名称<input key={activeChapter?.id} name="chapterTitle" required defaultValue={activeChapter?.title} maxLength={120} /></label><button className="tbtn" disabled={busy || dirty}>保存章节名称</button></form></details>
      <h3>关联资料</h3><p>先在课程“资料”加入文档，再保存可回查的原文快照。不会发给模型，也不创建虚假的生成记录。</p>
      <div className="learning-fields"><label>课程资料<select value={sourceDoc} onChange={(e) => setSourceDoc(e.target.value)}><option value="">选择一份资料</option>{snapshot.docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label><label>资料用途<select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="slides">课件</option><option value="textbook">指定教材</option><option value="notes">个人笔记</option></select></label><button className="tbtn" disabled={busy || dirty || !sourceDoc} onClick={() => void action(() => captureNodeSources(state.courseId, sourceDoc, role))}>保存原文快照</button></div>
      <button className="tbtn" disabled={busy || dirty} onClick={() => void action(chooseCandidates)}>检查已有导图与 AI 大纲的节点候选</button><p>AI 生成仍在原“AI 分析”入口明确发起；这里仅检查已保存内容，不新增调用。重复导入只新增勾选节点，不改已有理解。</p>
      {candidates.length > 0 && <section><h4>选择并入当前章节的候选</h4><p>保留所选父子层级。没有准确原文定位的节点标为待关联，不用文档开头冒充依据。</p>{candidates.map((c, i) => <label className="learning-option" key={c.key}><input type="checkbox" disabled={state.bindings.some((b) => b.originKey === c.key)} checked={checkedCandidates.includes(i)} onChange={(e) => setCheckedCandidates(e.target.checked ? [...checkedCandidates, i] : checkedCandidates.filter((n) => n !== i))} />{c.title} · {c.refs.length ? '有原文定位' : '原文待关联'}{c.parentKey ? ` · 上级：${candidates.find((p) => p.key === c.parentKey)?.title ?? '原结构节点'}` : ''}{state.bindings.some((b) => b.originKey === c.key) ? '（已并入）' : ''}</label>)}<button className="tbtn" disabled={busy || dirty || !checkedCandidates.length} onClick={() => void action(async () => {
        const imported = new Map(state.bindings.filter((b) => b.originKey).map((b) => [b.originKey ?? '', b.pointId]))
        for (let i = 0; i < candidates.length; i++) if (checkedCandidates.includes(i)) { const c = candidates[i]; const parentId = c.parentKey ? imported.get(c.parentKey) : undefined; const p = await createNodePoint(await reloadNodeState(state.id), selectedChapterId, c.title, c.refs, { key: c.key, ...(parentId ? { parentId } : {}) }); imported.set(c.key, p.id) }
        setCandidates([]); setCheckedCandidates([])
      })}>确认新增所选节点</button></section>}
      <details><summary>伊希斯的模型配置教程</summary><ol><li>打开“更多 → AI 设置”，选择你的服务商与模型。</li><li>在设置中的密钥框填写凭据，确认目的主机，保存并连接。不要在学习笔记中填写密钥。</li><li>如需测试问答，主动点击测试，可能消耗模型额度。</li><li>回到节点，选择课件片段；教材按需要补选。准备提示后再次确认生成。</li></ol><p>连接成功只代表连通，提示仍须核对原文。不连接模型也能整理框架、保存理解和复习。</p></details>
    </details>
      <details><summary>已归档节点</summary>{snapshot.points.filter((p) => p.status === 'retired').map((p) => <p key={p.id}>{p.title}<button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => saveEntity({ ...p, status: p.questionRefs.length ? 'pending' : 'active' }, p.revision))}>恢复节点</button></p>)}</details>
    <div className="node-layout"><aside className="node-outline" aria-label="章节大纲"><label>找知识节点<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>{state.chapters.map((c) => <section key={c.id}><h3>{c.title}</h3>{state.bindings.filter((b) => b.chapterId === c.id).map((b) => snapshot.points.find((p) => p.id === b.pointId)).filter((p) => p && p.status !== 'retired' && `${p.title} ${p.notes}`.includes(query)).map((p) => p && <button className="node-outline-item" key={p.id} disabled={dirty} aria-pressed={p.id === point?.id} onClick={() => go(p.id)}>{p.title}</button>)}</section>)}</aside>
      <main className="node-main">{review ? <section aria-label="整章复习"><h3>找回整章思路</h3><p>这是你保存的理解和联系；阅读不会调用模型。</p>{state.chapters.map((c) => <section key={c.id}><h3>{c.title}</h3>{state.bindings.filter((b) => b.chapterId === c.id).map((b) => { const p = snapshot.points.find((p) => p.id === b.pointId); return p && <details key={p.id}><summary>{p.title}</summary><NodeFormulaText text={latestNodeNote(snapshot, p.id) || '还没有收录个人理解，可以回节点继续。'} />{snapshot.relations.filter((r) => r.confirmed && (r.fromPointId === p.id || r.toPointId === p.id)).map((r) => <p key={r.id}>{snapshot.points.find((node) => node.id === r.fromPointId)?.title} → {RELATIONS[r.type]} → {snapshot.points.find((node) => node.id === r.toPointId)?.title}<br />{r.reason}</p>)}<button className="tbtn" onClick={() => go(p.id)}>回到这个节点</button></details> })}</section>)}</section>
        : point && binding ? <section aria-label="当前知识节点"><h3>{point.title}</h3><p>{state.chapters.find((c) => c.id === binding.chapterId)?.title}</p>
          {!!returnTo.length && <button className="tbtn" disabled={dirty} onClick={() => { const target = returnTo.at(-1); if (!target) return; setReturnTo(returnTo.slice(0, -1)); go(target.pointId, target.roundId) }}>返回刚才的知识节点</button>}
          <div className="learning-actions"><button className="tbtn" disabled={busy || dirty} onClick={() => void action(async () => { setRoundId(await beginNodeRound(state, point.id)) })}>{round ? '另起一轮自主推导' : '开始这一节点的推导'}</button>{round && <label>学习轮次<select aria-label="学习轮次" disabled={dirty} value={round.id} onChange={(e) => setRoundId(e.target.value)}>{state.rounds.filter((r) => r.pointId === point.id).map((r, i) => <option value={r.id} key={r.id}>第 {i + 1} 轮 · {r.question || '尚未填写问题'}</option>)}</select></label>}</div>
          {round && <RoundEditor key={round.id} round={round} state={state} snapshot={snapshot} action={action} busy={busy} onDirty={onDirty} />}
          <details><summary>个人理解与历史修订</summary><NodeFormulaText text={latestNodeNote(snapshot, point.id) || '本节点尚未收录个人理解。'} />
            <button className="tbtn" disabled={busy || dirty} onClick={() => { setNoteText(latestNodeNote(snapshot, point.id)); setNoteEditing(true); onDirty(true) }}>编辑个人理解</button>
            {noteEditing && <form onSubmit={(e) => { e.preventDefault(); void action(async () => { await collectNodeNote(state, point.id, noteText); setNoteEditing(false); onDirty(false) }) }}><label>修改我的理解<textarea maxLength={20000} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></label><button className="tbtn" disabled={busy || !noteText.trim()}>保存为新的个人理解修订</button><button type="button" className="tbtn" onClick={() => { setNoteEditing(false); onDirty(false) }}>取消本次修改</button></form>}
            {state.notes.filter((n) => n.pointId === point.id).slice().reverse().map((note, i) => <details key={note.id}><summary>修订 {state.notes.filter((n) => n.pointId === point.id).length - i} · {new Date(note.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</summary><NodeFormulaText text={note.text} /><button className="tbtn" disabled={busy || dirty} onClick={() => void action(() => collectNodeNote(state, point.id, note.text))}>以此内容追加新修订</button></details>)}</details>
          <section className="node-relations"><h3>连接前面学过的内容</h3>{snapshot.relations.filter((r) => r.confirmed && (r.fromPointId === point.id || r.toPointId === point.id)).map((r) => { const other = snapshot.points.find((p) => p.id === (r.fromPointId === point.id ? r.toPointId : r.fromPointId)); return <article key={r.id}><p>{snapshot.points.find((p) => p.id === r.fromPointId)?.title} → {RELATIONS[r.type]} → {snapshot.points.find((p) => p.id === r.toPointId)?.title}</p><p>{r.reason || '尚未写下联系的理由。'}</p><button className="tbtn" disabled={dirty || !other || other.status === 'retired'} onClick={() => { if (other) { setReturnTo([...returnTo, { pointId: point.id, roundId: round?.id }]); go(other.id) } }}>查看关联节点 · {other?.chapter || '未分章'} · {other?.title}</button></article> })}
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
