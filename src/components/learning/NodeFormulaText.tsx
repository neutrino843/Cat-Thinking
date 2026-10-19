import { useEffect, useRef } from 'react'
import 'katex/dist/katex.min.css'

function Formula({ text }: { text: string }) {
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let live = true
    void import('katex').then(({ default: katex }) => {
      if (!live || !element.current) return
      try { katex.render(text, element.current, { throwOnError: true, trust: false, maxExpand: 500, maxSize: 10, strict: 'warn', output: 'htmlAndMathml' }) }
      catch { element.current.textContent = `公式暂无法显示，原始表达：${text}` }
    }).catch(() => { if (live && element.current) element.current.textContent = text })
    return () => { live = false }
  }, [text])
  return <span ref={element} className="node-formula" />
}
export default function NodeFormulaText({ text }: { text: string }) {
  return <div className="node-note-text">{text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g).map((part, i) => part.startsWith('$$') && part.endsWith('$$') ? <Formula key={i} text={part.slice(2, -2)} /> : part.startsWith('$') && part.endsWith('$') ? <Formula key={i} text={part.slice(1, -1)} /> : <span key={i}>{part}</span>)}</div>
}
