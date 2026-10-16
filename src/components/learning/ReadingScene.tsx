import { useEffect, useRef, useState } from 'react'

export interface ReadingDocument { id: string; name: string; text: string; start?: number; end?: number }

/** A separate reading scene leaves the mounted learning form and its draft untouched. */
export default function ReadingScene({ documents, onClose }: { documents: ReadingDocument[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const mark = useRef<HTMLElement>(null)
  const positions = useRef(new Map<string, number>())
  const [selected, setSelected] = useState(documents[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const current = documents.find((d) => d.id === selected) ?? documents[0]
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current; element?.showModal()
    return () => { element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (!current || !region.current) return
    const offset = positions.current.get(current.id)
    if (offset !== undefined) region.current.scrollTop = offset
    else mark.current?.scrollIntoView({ block: 'center' })
  }, [current])
  const start = Math.max(0, Math.min(current?.start ?? 0, current?.text.length ?? 0))
  const end = Math.max(start, Math.min(current?.end ?? start, current?.text.length ?? 0))
  return <dialog ref={dialog} className="reading-scene" aria-label="独立阅读" data-reading-scene onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}>
    <header><div><p className="learning-eyebrow">独立阅读 · 当前保存的原文</p><h2>{current?.name ?? '没有可读取的原文'}</h2></div><button className="tbtn" data-reader-return onClick={onClose}>返回刚才的学习</button></header>
    <div className="reader-toolbar">
      {documents.length > 1 && <label>阅读资料<select value={current?.id} onChange={(event) => setSelected(event.target.value)}>{documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      <form onSubmit={(event) => { event.preventDefault(); const index = current?.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) ?? -1; if (index < 0 || !query.trim()) { setNotice('没有找到这段文字。'); return }; const content = region.current?.querySelector('[data-reader-text]'); if (content && region.current) { const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); let offset = 0; while (walker.nextNode()) { const node = walker.currentNode; const length = node.textContent?.length ?? 0; if (index < offset + length) { const range = document.createRange(); range.setStart(node, index - offset); range.setEnd(node, Math.min(length, index - offset + query.trim().length)); region.current.scrollTop += range.getBoundingClientRect().top - region.current.getBoundingClientRect().top - 40; break }; offset += length } }; setNotice('已定位到匹配位置。') }}><input aria-label="搜索阅读原文" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在原文中查找"/><button className="tbtn" disabled={!query.trim()}>查找</button><small role="status">{notice}</small></form>
    </div>
    <div className="reader-body" ref={region} onScroll={(event) => { if (current) positions.current.set(current.id, event.currentTarget.scrollTop) }}><article data-reader-text>{current ? <>{current.text.slice(0, start)}{end > start && <mark ref={mark}>{current.text.slice(start, end)}</mark>}{current.text.slice(end > start ? end : start)}</> : <p>原文暂时不可用，请返回资料检查。</p>}</article></div>
    <footer><small>可以正常滚动阅读；返回后继续原来的题目和回答。</small><div className="focus-perch reader-cat-place" data-isis-perch /></footer>
  </dialog>
}
