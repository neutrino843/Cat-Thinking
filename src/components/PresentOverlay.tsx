import { useEffect, useRef } from 'react'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { buildSlides } from '../lib/presentation'
import { getTheme } from '../lib/theme'

/**
 * 演示模式覆盖层（M5）：标题、页码、进度条、翻页控件与左右热区。
 * 键盘路由在 App 全局处理；这里仅提供可点击/可聚焦控件。
 */
export default function PresentOverlay() {
  const doc = useDoc((s) => s.doc)
  const dark = useSettings((s) => s.dark)
  const slide = useSettings((s) => s.slide)
  const setSlide = useSettings((s) => s.setSlide)
  const exit = useSettings((s) => s.exitPresenting)
  const theme = getTheme(dark)
  const rootRef = useRef<HTMLDivElement>(null)

  const slides = buildSlides(doc)
  const total = slides.length
  const i = Math.max(0, Math.min(slide, total - 1))
  const focusText = doc.nodes[slides[i]?.focusId ?? '']?.text ?? ''

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const exitAll = () => {
    exit()
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }

  const go = (n: number) => setSlide(Math.max(0, Math.min(n, total - 1)))
  const prev = () => go(i - 1)
  const next = () => go(i + 1)

  const btn = {
    background: 'transparent',
    border: 'none',
    color: theme.ink,
    font: 'inherit',
    cursor: 'pointer',
  } as const

  return (
    <div
      className="present-overlay"
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`演示模式：${doc.title}`}
      style={{ color: theme.ink }}
    >
      {/* 左右翻页热区 */}
      <button className="present-zone left" aria-label="上一页" onClick={prev} disabled={i === 0} />
      <button className="present-zone right" aria-label="下一页" onClick={next} disabled={i === total - 1} />

      <div className="present-top">
        <span className="present-doc-title">{doc.title}</span>
        <button className="present-exit" style={btn} onClick={exitAll} aria-label="退出演示 (Esc)">
          退出演示 ✕
        </button>
      </div>

      <div className="present-bottom" style={{ background: theme.panel, borderColor: theme.inkSoft }}>
        <button className="present-nav" style={btn} onClick={prev} disabled={i === 0} aria-label="上一页">
          ‹
        </button>
        <div className="present-meta">
          <span className="present-focus" aria-live="polite">
            {focusText || ' '}
          </span>
          <div className="present-progress" aria-hidden="true">
            <div className="present-progress-fill" style={{ width: `${total ? ((i + 1) / total) * 100 : 0}%`, background: theme.accent }} />
          </div>
          <span className="present-count">
            {i + 1} / {total}
          </span>
        </div>
        <button className="present-nav" style={btn} onClick={next} disabled={i === total - 1} aria-label="下一页">
          ›
        </button>
      </div>
    </div>
  )
}
