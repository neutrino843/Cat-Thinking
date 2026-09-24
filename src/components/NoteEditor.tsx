import { useEffect, useRef } from 'react'
import { sanitizeHtml } from '../lib/sanitizeHtml'

interface Props {
  /** 初始 HTML（已 sanitize）；外部值变化会重置编辑器 */
  html: string
  /** 输入或失焦时回调，传入净化后 HTML */
  onChange: (sanitizedHtml: string) => void
  placeholder?: string
}

/**
 * M7-P2 轻量富文本备注编辑器。
 * - contentEditable + document.execCommand 实现 bold/italic/list/link。
 * - 输出始终经 sanitizeHtml 净化后再写回 store，杜绝注入。
 * - 不引第三方依赖（Quill/TipTap），符合 M7 体积预算。
 */
export default function NoteEditor({ html, onChange, placeholder = '输入备注…支持加粗/斜体/列表/链接' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const lastRef = useRef<string>(html)

  // 外部 html 变化且与本地不同步时重置（避免光标跳转仅在确实需要时刷新）
  useEffect(() => {
    if (ref.current && html !== lastRef.current) {
      ref.current.innerHTML = html
      lastRef.current = html
    }
  }, [html])

  // 初始挂载写入
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) {
      ref.current.innerHTML = html
      lastRef.current = html
    }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function exec(cmd: string, val?: string) {
    document.execCommand(cmd, false, val)
    ref.current?.focus()
    commit()
  }

  function commit() {
    const raw = ref.current?.innerHTML ?? ''
    const clean = sanitizeHtml(raw)
    // 若净化后与当前 DOM 不同（被剥离危险内容），回写 DOM 避免脏数据停留
    if (ref.current && clean !== raw) ref.current.innerHTML = clean
    if (clean !== lastRef.current) {
      lastRef.current = clean
      onChange(clean)
    }
  }

  function handleLink() {
    const url = window.prompt('输入链接地址（https://…）：')
    if (!url) return
    // 校验协议：仅 http(s) / #node- 内部锚点
    const ok = /^https?:\/\//i.test(url) || /^#node-/i.test(url)
    if (!ok) {
      window.alert('仅支持 http(s):// 开头的链接或内部节点锚点 #node-...')
      return
    }
    exec('createLink', url)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Ctrl+B/I/L 快捷键
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'b') {
        e.preventDefault()
        exec('bold')
      } else if (k === 'i') {
        e.preventDefault()
        exec('italic')
      } else if (k === 'l') {
        e.preventDefault()
        handleLink()
      }
    }
  }

  return (
    <div className="msz-note-editor">
      <div className="msz-ne-toolbar" role="toolbar" aria-label="备注格式工具">
        <button
          type="button"
          className="msz-ne-btn"
          onClick={() => exec('bold')}
          title="加粗 (Ctrl+B)"
          aria-label="加粗"
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className="msz-ne-btn"
          onClick={() => exec('italic')}
          title="斜体 (Ctrl+I)"
          aria-label="斜体"
        >
          <i>I</i>
        </button>
        <button
          type="button"
          className="msz-ne-btn"
          onClick={() => exec('insertUnorderedList')}
          title="无序列表"
          aria-label="无序列表"
        >
          •
        </button>
        <button
          type="button"
          className="msz-ne-btn"
          onClick={() => exec('insertOrderedList')}
          title="有序列表"
          aria-label="有序列表"
        >
          1.
        </button>
        <button
          type="button"
          className="msz-ne-btn"
          onClick={handleLink}
          title="插入链接 (Ctrl+L)"
          aria-label="插入链接"
        >
          🔗
        </button>
        <button
          type="button"
          className="msz-ne-btn"
          onClick={() => exec('formatBlock', '<blockquote>')}
          title="引用块"
          aria-label="引用块"
        >
          ❝
        </button>
      </div>
      <div
        ref={ref}
        className="msz-ne-editable"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        onBlur={commit}
        onInput={commit}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
