/**
 * M7-P2 富文本备注白名单净化。
 *
 * 设计目标：
 * - 仅保留极小子集：B/I/STRONG/EM/U/UL/OL/LI/A/BR/P/BLOCKQUOTE。
 * - 仅 A 允许 href；其余标签全部属性剥离。
 * - href 必须是 http(s)://、mailto: 或本应用内部锚点 (#node-...)；其余（含 javascript:、data:、vbscript:）一律删 href。
 * - 任何 on* 事件属性、style 属性、script/style/iframe/object/embed 等危险节点整棵子树丢弃。
 * - 输入始终经 DOMParser 解析后再序列化，绝不原样回吐。
 *
 * 不变式：sanitizeHtml(x) 永远不返回包含 <script、on= 或 javascript: 的字符串。
 */

const ALLOWED = new Set([
  'B', 'I', 'STRONG', 'EM', 'U',
  'UL', 'OL', 'LI',
  'A', 'BR', 'P', 'BLOCKQUOTE',
])

/** 危险标签：整棵子树直接移除（不保留 children，避免样式/脚本泄漏） */
const DROP_TREE = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
  'BASE', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SVG', 'MATH',
])

/** URL 协议白名单 */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:']

/**
 * 判定单个 href 是否安全：协议白名单或本应用内部锚点 (#node-xxx)。
 * 非法协议直接 false（含 javascript:、data:、vbscript:、file: 等）。
 */
function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v) return null
  // 内部锚点：本应用约定 #node-<id>
  if (v.startsWith('#')) return v
  // 协议白名单：通过 URL 解析判定（依赖 base 回退到 http://example.com）
  let url: URL
  try {
    url = new URL(v, 'http://example.com/')
  } catch {
    return null
  }
  if (!SAFE_PROTOCOLS.includes(url.protocol)) return null
  // 同源相对路径会被 base 解析为 http://example.com/...；保留原串以保持可读
  return v
}

/**
 * 递归净化单个节点：返回应保留的子节点数组（原位修改 parent）。
 * - DROP_TREE 标签：整棵子树丢弃，返回空。
 * - 允许标签：剥离所有属性，A 单独保留经校验的 href。
 * - 不允许标签但不在 DROP_TREE：保留 children（unwrap），避免内容丢失。
 */
function cleanNode(node: Node, out: Node[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node)
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    // 注释、处理指令等丢弃
    return
  }
  const el = node as Element
  const tag = el.tagName.toUpperCase()
  if (DROP_TREE.has(tag)) return

  if (ALLOWED.has(tag)) {
    // 克隆并清空属性
    const clone = el.ownerDocument!.createElement(tag.toLowerCase())
    if (tag === 'A') {
      const href = safeHref(el.getAttribute('href'))
      if (href) clone.setAttribute('href', href)
      // 防御 target/rel 缺失：新窗口打开 + noopener（仅外部）
      if (href && !href.startsWith('#')) {
        clone.setAttribute('target', '_blank')
        clone.setAttribute('rel', 'noopener noreferrer')
      }
    }
    // 递归处理 children
    const kids: Node[] = []
    for (const c of Array.from(el.childNodes)) cleanNode(c, kids)
    for (const k of kids) clone.appendChild(k)
    out.push(clone)
    return
  }

  // 非白名单非危险：unwrap（保留子节点）
  const kids: Node[] = []
  for (const c of Array.from(el.childNodes)) cleanNode(c, kids)
  for (const k of kids) out.push(k)
}

/**
 * 净化 HTML 字符串：返回白名单子集 HTML，永不包含可执行内容。
 * 输入为空或非字符串返回 ''。解析失败回退 ''。
 *
 * 两道防线：
 * 1) 正则预剥离 script/style/iframe/object/embed 等整棵子树（happy-dom 的 DOMParser
 *    对内嵌 script 处理不稳定，且 iframe 会触发网络请求）；
 * 2) DOMParser 解析后递归白名单净化 + 属性剥离 + 协议白名单。
 */
export function sanitizeHtml(input: string): string {
  if (typeof input !== 'string' || !input) return ''
  // 预剥离：移除危险标签整棵子树（含可能的嵌套同标签）
  const pre = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed\s*>/gi, '')
    // 自闭合或未闭合的危险标签
    .replace(/<(script|iframe|embed|object|base|link|meta)\b[^>]*\/?>/gi, '')
    // HTML 注释（防条件注释等绕过）
    .replace(/<!--[\s\S]*?-->/g, '')

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(pre, 'text/html')
  } catch {
    return ''
  }
  const body = doc.body || doc.documentElement
  if (!body) return ''
  const out: Node[] = []
  for (const c of Array.from(body.childNodes)) cleanNode(c, out)
  // 序列化为 HTML（不接 <body> 外壳）
  const wrap = doc.createElement('div')
  for (const n of out) wrap.appendChild(n)
  return wrap.innerHTML
}

/**
 * 富备注 → 纯文本：用于 toMarkdown 降级、搜索索引、aria-label。
 * - BR / P / BLOCKQUOTE → 换行
 * - LI → 行首 "• "（无序）或保留编号（有序由调用方决定）
 * - A → 文本后跟 [链接](url)（仅外部链接）
 * - 其他标签去标签保文本
 */
export function richNoteToText(html: string): string {
  if (!html) return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return ''
  }
  const buf: string[] = []
  const walk = (n: Node, orderedAncestor: boolean): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      buf.push(n.textContent ?? '')
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as Element
    const tag = el.tagName.toUpperCase()
    switch (tag) {
      case 'BR':
        buf.push('\n')
        return
      case 'P':
      case 'BLOCKQUOTE':
        for (const c of el.childNodes) walk(c, orderedAncestor)
        buf.push('\n')
        return
      case 'UL':
        for (const c of el.childNodes) walk(c, false)
        return
      case 'OL':
        for (const c of el.childNodes) walk(c, true)
        return
      case 'LI': {
        for (const c of el.childNodes) walk(c, orderedAncestor)
        buf.push('\n')
        return
      }
      case 'A': {
        for (const c of el.childNodes) walk(c, orderedAncestor)
        const href = el.getAttribute('href')
        if (href && !href.startsWith('#')) buf.push(` [链接](${href})`)
        return
      }
      default:
        for (const c of el.childNodes) walk(c, orderedAncestor)
    }
  }
  walk(doc.body || doc.documentElement!, false)
  return buf.join('').replace(/\n{3,}/g, '\n\n').trim()
}
