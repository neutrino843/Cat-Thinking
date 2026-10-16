import { useState } from 'react'
import PagedText from './PagedText'

export default function YesterdayNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false)
  if (!note.trim()) return null
  return <section className="yesterday-note"><button className="tbtn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起昨日便签' : '我已尝试回忆，翻开上次的便签'}</button>{open && <><p className="focus-muted">这是你上次写下的理解，不是标准答案。对照原文看看哪些地方变清楚了。</p><PagedText text={note} label="昨日便签" /></>}</section>
}
