import { useEffect, useId, useState } from 'react'
import ReadingScene, { type ReadingDocument } from './ReadingScene'

export default function SourceHelp({ documents, passages, onViewed }: { documents: ReadingDocument[]; passages: { name: string; quote: string }[]; onViewed?: () => void }) {
  const id = useId()
  const [related, setRelated] = useState(false)
  const [reader, setReader] = useState(false)
  useEffect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; action: string }>).detail
      if (detail?.id !== id) return
      onViewed?.()
      if (detail.action === 'read' && documents.length) setReader(true)
      else if (detail.action === 'related') setRelated(true)
    }
    window.addEventListener('msz:source-action', command)
    return () => window.removeEventListener('msz:source-action', command)
  }, [id, documents.length, onViewed])
  return <section className="source-help" data-source-help={id} data-can-read={documents.length > 0 ? 'true' : 'false'}>
    <button type="button" className="study-text-button" aria-expanded={related} onClick={() => { if (!related) onViewed?.(); setRelated(!related) }}>{related ? '收起相关段落' : '需要帮助，查看相关段落'}</button>
    {related && <aside className="related-passage" aria-label="相关段落"><div className="study-section-head"><h4>只看与当前任务相关的内容</h4><button className="tbtn" disabled={!documents.length} onClick={() => { onViewed?.(); setReader(true) }}>进入独立阅读</button></div>{passages.length ? passages.map((p, index) => <div key={index}><small>{p.name}</small><blockquote>{p.quote}</blockquote></div>) : <p>当前没有可用的原文引用，可在资料中核对。</p>}</aside>}
    {reader && <ReadingScene documents={documents} onClose={() => setReader(false)} />}
  </section>
}
