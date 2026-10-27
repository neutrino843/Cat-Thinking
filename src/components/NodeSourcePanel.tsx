import { useEffect, useRef, useState } from 'react'
import { useDoc } from '../store/docStore'
import { db } from '../store/db'
import { collectLocalSourceReferences, resolveLocalSourceReference, type LocalSourceReference } from '../analysis/localSourceReferences'
import { subscribeAnalysisBinding } from '../analysis/taskNotifications'
import type { CitationView } from '../analysis/citationView'
import SavedSourceRebuild from './SavedSourceRebuild'

export default function NodeSourcePanel({ onConceptMap }: { onConceptMap: () => void }) {
  const doc = useDoc((s) => s.doc)
  const selection = useDoc((s) => s.selection)
  const id = selection.length === 1 ? selection[0] : undefined
  const node = id ? doc.nodes[id] : undefined
  if (!id || !node) return null
  return <aside className="node-source-panel" aria-label="当前节点资料" data-node-details>
    <h3>{node.text || '未命名节点'}</h3>
    <p className="node-source-caption">单击查看 · 双击或 F2 修改 · Tab 新建子节点</p>
    <button className="tbtn" onClick={() => { useDoc.getState().beginEdit(); useDoc.getState().setEditing({ id, source: 'canvas' }) }}>修改节点标题</button>
    <NodeReading key={`${doc.id}:${id}`} docId={doc.id} nodeId={id} root={id === doc.rootId} relations={doc.relations} />
    {node.note && <section><h4>节点备注</h4><p className="node-source-original">{node.note}</p></section>}
    <section><h4>概念关系图</h4><p>以当前讲义为依据另建一张图。原图和你的笔记保留，生成前可选择材料范围。</p><button className="tbtn primary" onClick={onConceptMap}>整理概念关系图</button></section>
    {id === doc.rootId && <SavedSourceRebuild key={doc.id} docId={doc.id} />}
  </aside>
}

function NodeReading({ docId, nodeId, root, relations }: { docId: string; nodeId: string; root: boolean; relations: Parameters<typeof collectLocalSourceReferences>[0]['relations'] }) {
  const [references, setReferences] = useState<LocalSourceReference[]>()
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [offset, setOffset] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    let disposed = false
    const reload = () => {
      const seq = ++generation.current
      void db.sources.where('docId').equals(docId).toArray().then((sources) => {
        if (disposed || seq !== generation.current) return
        const refs = collectLocalSourceReferences({ relations }, nodeId, sources)
        if (root) for (const source of sources) if (source.text.length) refs.push({ key: `whole:${source.id}`, label: `全部原文：${source.name}`, sourceId: source.id, start: 0, end: source.text.length, contentHash: source.contentHash })
        setReferences(refs); setError('')
      }).catch(() => { if (!disposed && seq === generation.current) setError('读取原文失败，请稍后重选节点。') })
    }
    reload()
    const unsubscribe = subscribeAnalysisBinding(docId, reload)
    window.addEventListener('focus', reload)
    return () => { disposed = true; unsubscribe(); window.removeEventListener('focus', reload) }
  }, [docId, nodeId, root, relations])
  const selected = references?.find((ref) => ref.key === selectedKey) ?? references?.[0]
  return <section><h4>来源原文</h4>
    {error && <p role="alert">{error}</p>}
    {!references && !error && <p role="status">正在读取原文…</p>}
    {references?.length === 0 && <p>该节点没有原文定位。可查看节点备注，或选中根节点阅读讲义。</p>}
    {!!references?.length && <label>原文位置<select value={selected?.key} onChange={(e) => { setSelectedKey(e.target.value); setOffset(0) }}>{references.map((ref) => <option value={ref.key} key={ref.key}>{ref.label}{ref.page ? ` · 第${ref.page}页` : ''}{ref.locator ? ` · ${ref.locator}` : ''}</option>)}</select></label>}
    {selected && <ReferencePage key={`${selected.key}:${offset}`} docId={docId} reference={selected} offset={offset} onOffset={setOffset} />}
  </section>
}

function ReferencePage({ docId, reference, offset, onOffset }: { docId: string; reference: LocalSourceReference; offset: number; onOffset: (offset: number) => void }) {
  const [view, setView] = useState<CitationView>()
  const [error, setError] = useState('')
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    let disposed = false
    void resolveLocalSourceReference(docId, reference, { offset }).then((result) => { if (!disposed) setView(result) })
      .catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : '读取失败。') })
    return () => { disposed = true; live.current = false }
  }, [docId, reference, offset])
  const copy = async () => {
    setCopying(true); setError('')
    try {
      const full = await resolveLocalSourceReference(docId, reference, { full: true })
      if (!live.current) return
      await navigator.clipboard.writeText(full.quote)
      if (live.current) setCopied(true)
    } catch { if (live.current) setError('复制失败，可以选中文字后复制。') }
    finally { if (live.current) setCopying(false) }
  }
  return <div>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">正在核对来源…</p>}
    {view && <><p className="node-source-caption">{view.name} · {view.location}</p><pre className="node-source-original" aria-label="当前节点原文">{view.quote}</pre>
      <div className="node-source-actions"><button className="tbtn" disabled={!offset} onClick={() => onOffset(Math.max(0, offset - 4000))}>上一段</button><span>{offset + 1}–{Math.min(reference.end - reference.start, offset + 4000)} / {reference.end - reference.start}</span><button className="tbtn" disabled={!view.truncated} onClick={() => onOffset(offset + 4000)}>下一段</button></div>
      <button className="tbtn" disabled={copying} onClick={() => void copy()}>{copied ? '已复制完整原文' : '复制此处完整原文'}</button></>}
  </div>
}
