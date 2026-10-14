import { useEffect, useRef, useState } from 'react'
import type { DocData } from '../types'
import { db } from '../store/db'
import { collectLocalSourceReferences, LOCAL_REFERENCE_LIMIT, resolveLocalSourceReference, type LocalSourceReference } from '../analysis/localSourceReferences'
import { subscribeAnalysisBinding } from '../analysis/taskNotifications'
import type { CitationView } from '../analysis/citationView'

export default function LocalSourceReferences({ doc, nodeId }: { doc: DocData; nodeId: string }) {
  const [references, setReferences] = useState<LocalSourceReference[]>([])
  const [view, setView] = useState<CitationView>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    const invalidate = () => { generation.current += 1 }
    const reload = () => {
      const currentGeneration = ++generation.current
      setReferences([]); setView(undefined); setError(''); setLoading(false)
      void db.sources.where('docId').equals(doc.id).limit(32).toArray().then((sources) => {
        if (!disposed && currentGeneration === generation.current) setReferences(collectLocalSourceReferences({ relations: doc.relations }, nodeId, sources))
      }).catch(() => { if (!disposed && currentGeneration === generation.current) setError('无法读取本地原文来源。') })
    }
    reload()
    const unsubscribe = subscribeAnalysisBinding(doc.id, reload)
    window.addEventListener('focus', reload)
    return () => { disposed = true; invalidate(); unsubscribe(); window.removeEventListener('focus', reload) }
  }, [doc.id, doc.relations, nodeId])

  const inspect = async (reference: LocalSourceReference) => {
    const currentGeneration = ++generation.current
    setLoading(true); setError(''); setView(undefined)
    try {
      const resolved = await resolveLocalSourceReference(doc.id, reference)
      if (currentGeneration === generation.current) setView(resolved)
    } catch (failure) {
      if (currentGeneration === generation.current) setError(failure instanceof Error ? failure.message : '无法读取本地原文。')
    } finally { if (currentGeneration === generation.current) setLoading(false) }
  }

  if (!references.length && !error) return null
  return <section className="msz-np-section" aria-label="本地原文引用" data-analysis-panel>
    <div className="msz-np-label">原文依据</div>
    <div className="msz-np-att-list">
      {references.map((reference) => <button key={reference.key} type="button" className="msz-np-add-btn" onClick={() => void inspect(reference)} disabled={loading}>
        {reference.label} · {reference.start}–{reference.end}
      </button>)}
    </div>
    {references.length >= LOCAL_REFERENCE_LIMIT && <p className="msz-np-note-hint">最多显示 {LOCAL_REFERENCE_LIMIT} 条引用。</p>}
    {loading && <p role="status">正在核对原文…</p>}
    {error && <p role="alert">{error}</p>}
    {view && <div aria-label="本地引用原文">
      <p>{view.name} · {view.location}</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 260 }}>{view.before}<mark>{view.quote}</mark>{view.after}</pre>
      {view.truncated && <p className="msz-np-note-hint">引用较长，显示前 4,000 个字符。</p>}
    </div>}
  </section>
}
