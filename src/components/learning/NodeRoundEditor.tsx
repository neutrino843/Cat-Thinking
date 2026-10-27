import { useEffect, useRef, useState } from 'react'
import type { CourseSnapshot } from '../../learning/model'
import { collectNodeNote, prepareNodeHint, reloadNodeState, saveNodeDraft } from '../../learning/nodeLearning'
import type { NodeLearningState, NodeRound, NodeSourceRef } from '../../learning/nodeTypes'
import type { LearningAction } from './CourseOverview'
import NodeHintPanel from './NodeHintPanel'
import NodeFormulaText from './NodeFormulaText'

export default function NodeRoundEditor({ round, state, snapshot, action, busy, onDirty }: { round: NodeRound; state: NodeLearningState; snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onDirty: (dirty: boolean) => void }) {
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
  const readConflictingVersion = async () => {
    const latest = await reloadNodeState(state.id)
    const newer = latest.rounds.find((r) => r.id === round.id)
    if (!newer) throw new Error('这一轮已不存在，请先复制本页文字。')
    setError(`另一页面内容：${newer.question}\n${newer.input}\n请先复制需要保留的两版内容，再明确保存本页草稿。`)
    base.current = latest
  }
  const viewed = state.events.filter((e) => e.roundId === round.id && e.type === 'hint-viewed')
  const nextLevel = Math.min(2, Math.max(0, ...viewed.map((e) => e.level ?? 0)) + 1) as 1 | 2
  return <section className="node-round" aria-label="本轮自主推导">
    <h3>从这里继续推导</h3>
    <label>这一轮想弄清什么<textarea aria-label="这一轮想弄清什么" maxLength={3000} value={question} onChange={(e) => { change(); setQuestion(e.target.value) }} placeholder="例如：这一步为什么可以成立？我缺少哪一个前提？" /></label>
    <label>我已经想到的步骤<textarea aria-label="我已经想到的步骤" className="node-draft" maxLength={10000} value={input} onChange={(e) => { change(); setInput(e.target.value) }} placeholder="写关键理由、步骤或卡住的位置。可以用 $...$ 记录公式。" /></label>
    <p role="status">{saved ? '草稿已保存在本机，尚未自动收录为个人理解。' : error ? '草稿尚未保存，当前文字仍在此处。' : '正在保存草稿…'}</p>
    {error && <section role="alert"><p>{error}</p><button className="tbtn" onClick={() => void readConflictingVersion().catch((err: unknown) => setError(String(err)))}>读取另一版本，保留本页文字</button><button className="tbtn" onClick={() => { sequence.current++; edited.current = true; setError('') }}>明确重试保存本页草稿</button></section>}
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

