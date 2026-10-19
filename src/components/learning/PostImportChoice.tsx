import { useEffect, useRef } from 'react'

/**
 * v2.1 需求4：资料导入并归属课程后的三选一层（纯展示组件）。
 * ① 查看思维导图 ② 直接开始学习（推荐，默认主按钮）③ 回到学习首页（底部保留导图入口）。
 * A2 优化：「直接开始学习」为主按钮，降低新用户决策成本。
 */
interface PostImportChoiceProps {
  docTitle: string
  onOpenMindMap: () => void
  onStartLearning: () => void
  onStayHome: () => void
}

export default function PostImportChoice({ docTitle, onOpenMindMap, onStartLearning, onStayHome }: PostImportChoiceProps) {
  const card = useRef<HTMLElement>(null)
  useEffect(() => { card.current?.querySelector<HTMLElement>('button')?.focus() }, [])
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !card.current) return
    const items = Array.from(card.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !card.current.contains(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || !card.current.contains(active))) { event.preventDefault(); first.focus() }
  }
  return (
    <div className="post-import-overlay" data-post-import onKeyDown={trapTab}>
      <section ref={card} role="dialog" aria-modal="true" aria-label="资料已加入课程，下一步">
        <h2>资料已加入课程</h2>
        <p>《{docTitle}》的可编辑导图已生成，选择接下来要做什么：</p>
        <div className="post-import-options">
          <button type="button" className="post-import-option post-import-primary" onClick={onStartLearning}>
            <strong>直接开始学习</strong>
            <span>读一小段已保存的原文，完成第一道入门题</span>
          </button>
          <button type="button" className="post-import-option" onClick={onOpenMindMap}>
            <strong>查看思维导图</strong>
            <span>打开导图，继续调整结构、备注与关系线</span>
          </button>
          <button type="button" className="post-import-option" onClick={onStayHome}>
            <strong>回到学习首页</strong>
            <span>首页底部保留导图入口，稍后再看也可以</span>
          </button>
        </div>
      </section>
    </div>
  )
}
