 import type { DocData, MindNodeData } from '../types'
import { richNoteToText } from './sanitizeHtml'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * 文件名清洗：去除 \\ / : * ? " < > | 与控制字符，首尾空白裁剪；
 * 空名回退「未命名导图」。新老导出统一使用，避免非法文件名触发浏览器降级。
 */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- 有意剔除文件名中的控制字符
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').replace(/[\x00-\x1f]/g, '').trim()
  return cleaned || '未命名导图'
}

/* ---------------- Markdown 导出 ---------------- */

/**
 * 导出为 Markdown（严格子集，可由 parseMarkdown 往返）：
 * - H1 为文档标题；
 * - 先序遍历输出缩进 `- ` 列表（2 空格/层）；
 * - 任务行尾追加 `start → end · progress%`（仅存在的字段拼接，用反引号包裹）；
 * - 里程碑在文本前加 `◇ `；
 * - 超链接行尾追加 ` [🔗](url)`；
 * - 备注转为缩进一层后的 `> ` 引用行（多行逐行）；
 * - 折叠状态不影响导出（始终输出完整树）。
 */
export function toMarkdown(doc: DocData): string {
  const lines: string[] = [`# ${doc.title}`, '']
  const root = doc.nodes[doc.rootId]
  if (!root) return lines.join('\n')

  const walk = (n: MindNodeData, depth: number) => {
    const indent = '  '.repeat(depth)
    const prefix = n.task?.milestone ? '◇ ' : ''
    let line = `${indent}- ${prefix}${n.text}`
    if (n.task) {
      const parts: string[] = []
      if (n.task.start && n.task.end) parts.push(`${n.task.start} → ${n.task.end}`)
      else if (n.task.start) parts.push(`${n.task.start} →`)
      else if (n.task.end) parts.push(`→ ${n.task.end}`)
      if (typeof n.task.progress === 'number') parts.push(`${n.task.progress}%`)
      if (parts.length) line += ` \`${parts.join(' · ')}\``
    }
    // M7-P2：旧单 href 与新多 links 并存，统一降级为多个 [🔗](url) 后缀。
    // 内部节点链接用 [节点→#node-xxx] 标记，无对应 Markdown 语法但可读。
    if (n.href) line += ` [🔗](${n.href})`
    if (n.links && n.links.length) {
      for (const l of n.links) {
        if (l.kind === 'url' && l.url) line += ` [🔗](${l.url})`
        else if (l.kind === 'node' && l.nodeId) line += ` [节点→#${l.nodeId}]`
      }
    }
    lines.push(line)
    // M7-P3：图片/附件以 Markdown 形式附加（缩进与列表项对齐）
    if (n.images && n.images.length) {
      const imgIndent = '  '.repeat(depth + 1)
      for (const im of n.images) lines.push(`${imgIndent}![图片](${im.w}×${im.h})`)
    }
    if (n.attachments && n.attachments.length) {
      const attIndent = '  '.repeat(depth + 1)
      for (const att of n.attachments) lines.push(`${attIndent}> 📎 ${att.name}（${att.size} 字节）`)
    }
    // M7-P2：富备注优先（含格式降级为纯文本），其次旧纯文本 note
    const noteText = n.richNote?.html ? richNoteToText(n.richNote.html) : n.note
    if (noteText) {
      const noteIndent = '  '.repeat(depth + 1)
      for (const nl of noteText.split('\n')) lines.push(`${noteIndent}> ${nl}`)
    }
    for (const cid of n.children) {
      const c = doc.nodes[cid]
      if (c) walk(c, depth + 1)
    }
  }
  // 根节点本身不作为列表项输出（H1 已承载文档标题，root.text 归一为 title）；
  // 仅输出 root.children 作为顶层列表项，保证 parseMarkdown 往返层级一致。
  for (const cid of root.children) {
    const c = doc.nodes[cid]
    if (c) walk(c, 0)
  }
  return lines.join('\n')
}

/* ---------------- Markdown 导入 ---------------- */

interface ParsedItem {
  text: string
  note?: string
  href?: string
  task?: { start?: string; end?: string; progress?: number; milestone?: boolean }
  children: ParsedItem[]
}

const DATE_RE = '(\\d{4}-\\d{2}-\\d{2})'

/**
 * 解析本应用导出的 Markdown 子集：
 * - 首个 `# 标题` 作为文档标题，缺失回退 fallbackTitle；
 * - `- ` / `* ` / `+ ` 列表项，缩进支持 2/4 空格或 Tab（统一按 2 空格归一化为深度）；
 * - 里程碑前缀 `◇ `、任务行尾反引号块 `start → end · progress%`、超链接 ` [🔗](url)`；
 * - 缩进一层的 `> ` 引用行追加到最近列表项的 note；
 * - 无法识别的非空行按文本兜底挂到根（不抛裸错）；
 * - 输入为空（trim 后无内容）抛中文 Error。
 */
export function parseMarkdown(md: string, fallbackTitle = '未命名导图'): DocData {
  if (!md || !md.trim()) throw new Error('Markdown 内容为空，无法导入')

  const lines = md.split(/\r?\n/)
  let title = fallbackTitle
  let i = 0

  // 跳过空行直到首个 H1 或首个非空行
  for (; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    const h1 = raw.match(/^#\s+(.+?)\s*$/)
    if (h1) {
      title = h1[1].trim() || fallbackTitle
      i++
      break
    }
    // 第一个非空非 H1 行：不作为标题，回退 fallbackTitle，进入列表解析
    break
  }

  const root: ParsedItem = { text: title, children: [] }
  // 栈：{ item, indent }，根占位 indent=-1 保证任何 ≥0 缩进都是根的子
  const stack: { item: ParsedItem; indent: number }[] = [{ item: root, indent: -1 }]
  let lastItem: ParsedItem | null = null

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue

    // 引用行（备注）
    const noteM = line.match(/^(\s*)>\s?(.*)$/)
    if (noteM) {
      if (lastItem) {
        lastItem.note = lastItem.note ? `${lastItem.note}\n${noteM[2]}` : noteM[2]
      }
      continue
    }

    // 列表项
    const listM = line.match(/^(\s*)(?:[-*+])\s+(.+)$/)
    if (!listM) {
      // 无法识别的行：跳过不报错（外部任意 .md 容错）
      continue
    }

    // 归一化缩进：Tab 按 4 空格展开
    const expanded = listM[1].replace(/\t/g, '    ')
    const indent = expanded.length
    let text = listM[2]
    const item: ParsedItem = { text: '', children: [] }

    // 里程碑前缀
    const msM = text.match(/^◇\s+(.+)$/)
    if (msM) {
      item.task = { milestone: true }
      text = msM[1]
    }

    // 超链接行尾
    const hrefM = text.match(/\s\[🔗\]\(([^)\s]+)\)\s*$/)
    if (hrefM) {
      item.href = hrefM[1]
      text = text.slice(0, text.length - hrefM[0].length)
    }

    // 任务行尾反引号块
    const taskM = text.match(/^(.+?)\s`([^`]+)`\s*$/)
    if (taskM) {
      text = taskM[1]
      if (!item.task) item.task = {}
      for (const seg of taskM[2].split('·').map((s) => s.trim())) {
        const range = seg.match(new RegExp(`^${DATE_RE}\\s*→\\s*${DATE_RE}$`))
        const startOnly = seg.match(new RegExp(`^${DATE_RE}\\s*→$`))
        const endOnly = seg.match(new RegExp(`^→\\s*${DATE_RE}$`))
        const prog = seg.match(/^(\d+)%$/)
        if (range) {
          item.task.start = range[1]
          item.task.end = range[2]
        } else if (startOnly) {
          item.task.start = startOnly[1]
        } else if (endOnly) {
          item.task.end = endOnly[1]
        } else if (prog) {
          item.task.progress = Number(prog[1])
        }
      }
    }

    item.text = text.trim() || '(空)'

    // 弹出缩进 >= 当前的栈顶，挂到新栈顶下
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].item
    parent.children.push(item)
    stack.push({ item, indent })
    lastItem = item
  }

  // 无任何列表项：root.text 保持 title，保证至少有一个根节点

  // 转换为 DocData
  const nodes: Record<string, MindNodeData> = {}
  const mk = (it: ParsedItem, parent: string | null): string => {
    const id = uid()
    nodes[id] = {
      id,
      parent,
      children: [],
      text: it.text,
      ...(it.note ? { note: it.note } : {}),
      ...(it.href ? { href: it.href } : {}),
      ...(it.task ? { task: { ...it.task } } : {}),
    }
    if (parent) nodes[parent].children.push(id)
    for (const c of it.children) mk(c, id)
    return id
  }
  const rootId = mk(root, null)

  const now = Date.now()
  return {
    version: 3,
    id: uid(),
    title,
    rootId,
    layout: 'logic',
    nodes,
    createdAt: now,
    updatedAt: now,
  }
}

/* ---------------- OPML 导入导出（M10，PRD 4.3 P1） ---------------- */

/**
 * XML 文本/属性转义（& 必须最先替换），并剔除 XML 1.0 非法控制字符
 * （保留 \t \n \r）。OPML 属性用双引号包裹，故同时转义引号。
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex -- 有意剔除 XML 1.0 非法控制字符
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

/* ---- 极简 XML 解析（仅服务 OPML 导入）----
 * 不使用 DOMParser：happy-dom 对 application/xml 会退化为 HTML 解析而破坏
 * head/body 结构，真实浏览器与测试环境行为不一致。OPML 用到的 XML 子集很小
 * （元素嵌套 + 属性 + 文本节点），~90 行确定性分词器即可，且天然不执行脚本：
 * 所有文本（含属性值）都只是字符串，节点文本最终经 React <text> 渲染再转义。 */

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 直接文本内容（供 <title> 读取） */
  text: string
}

/** 解码 XML 五个预定义实体 + 数字字符引用；未识别实体原样保留 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

class XmlParseError extends Error {}

/** 解析开始标签头部：`outline text="a" _note="b"` → 标签名 + 属性表 */
function splitTagHead(inner: string): { tag: string; attrs: Record<string, string> } {
  const m = inner.match(/^([A-Za-z][\w.-]*)([\s\S]*)$/)
  if (!m) throw new XmlParseError('标签名非法')
  const tag = m[1]
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let am: RegExpExecArray | null
  while ((am = re.exec(m[2]))) {
    attrs[am[1].toLowerCase()] = decodeXmlEntities(am[2] ?? am[3] ?? '')
  }
  return { tag, attrs }
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      stack[stack.length - 1].text += decodeXmlEntities(xml.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decodeXmlEntities(xml.slice(i, lt))

    // 注释、CDATA 段：直接跳过内容（OPML 不使用 CDATA，容错）
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlParseError('注释未闭合')
      i = end + 3
      continue
    }
    // 处理指令 <?xml?> 与声明 <!DOCTYPE>：跳到 >
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const gt = xml.indexOf('>', lt)
      if (gt === -1) throw new XmlParseError('声明未闭合')
      i = gt + 1
      continue
    }

    const gt = xml.indexOf('>', lt)
    if (gt === -1) throw new XmlParseError('标签未闭合')
    const closing = xml.startsWith('</', lt)
    let inner = xml.slice(lt + (closing ? 2 : 1), gt)
    const selfClose = !closing && inner.endsWith('/')
    if (selfClose) inner = inner.slice(0, -1)
    const { tag, attrs } = splitTagHead(inner.trim())
    i = gt + 1

    if (closing) {
      if (stack.length <= 1 || stack[stack.length - 1].tag !== tag) {
        throw new XmlParseError(`结束标签 </${tag}> 与开始标签不匹配`)
      }
      stack.pop()
    } else {
      const node: XmlNode = { tag, attrs, children: [], text: '' }
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
    }
  }
  if (stack.length !== 1) throw new XmlParseError('存在未闭合的标签')
  return root
}

/** 在直接子节点中按标签名（小写）查找第一个 */
function findChild(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  return node?.children.find((c) => c.tag.toLowerCase() === tag)
}

/** 深度优先找第一个具名元素 */
function findDeep(node: XmlNode, tag: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.tag.toLowerCase() === tag) return c
    const hit = findDeep(c, tag)
    if (hit) return hit
  }
  return undefined
}

/**
 * 导出为 OPML 2.0（大纲交换标准格式，可被 XMind / FreeMind / Workflowy 等读写）：
 * - head/title 承载文档标题；
 * - body 下单个顶层 outline 为根节点（与 XMind 导出惯例一致，保证往返根文本不丢）；
 * - 嵌套 outline 表达层级；备注（richNote 降级纯文本或旧 note）写入 _note 属性；
 * - 任务/标签等非 OPML 标准字段不导出（结构交换格式定位，无损往返请用 JSON/.msz）。
 */
export function toOPML(doc: DocData): string {
  const root = doc.nodes[doc.rootId]

  const outline = (n: MindNodeData, depth: number): string => {
    const ind = '  '.repeat(depth + 2)
    const noteText = n.richNote?.html ? richNoteToText(n.richNote.html) : n.note
    const attrs =
      `text="${xmlEscape(n.text)}"` + (noteText ? ` _note="${xmlEscape(noteText)}"` : '')
    if (!n.children.length) return `${ind}<outline ${attrs}/>`
    const inner = n.children
      .map((cid) => doc.nodes[cid])
      .filter(Boolean)
      .map((c) => outline(c, depth + 1))
      .join('\n')
    return `${ind}<outline ${attrs}>\n${inner}\n${ind}</outline>`
  }

  const body = root ? `  <body>\n${outline(root, 0)}\n  </body>` : '  <body/>'
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<opml version="2.0">\n` +
    `  <head>\n    <title>${xmlEscape(doc.title)}</title>\n  </head>\n` +
    `${body}\n</opml>\n`
  )
}

/**
 * 解析 OPML 2.0 为本文档模型：
 * - DOMParser 按 application/xml 解析（XML 数据模型天然不执行脚本，无 XSS 面；
 *   节点文本最终经 React <text> 渲染也会自动转义）；
 * - head/title 缺省时用 fallbackTitle；
 * - body 下 0 个顶层 outline → 仅根；1 个 → 该 outline 即根（标准往返）；
 *   多个 → 以标题为文本建包裹根（外部工具允许 body 多顶层）；
 * - text 属性缺省时退 title 属性，再退「(空)」；_note → 纯文本备注；
 * - 空输入 / XML 非法 / 缺 opml 根 → 抛中文 Error（best-effort 不静默吞错结构）。
 */
export function parseOPML(xml: string, fallbackTitle = '未命名导图'): DocData {
  if (!xml || !xml.trim()) throw new Error('OPML 内容为空，无法导入')

  let tree: XmlNode
  try {
    tree = parseXml(xml)
  } catch (e) {
    if (e instanceof XmlParseError) {
      throw new Error('不是有效的 OPML 文件：XML 格式错误', { cause: e })
    }
    throw new Error('OPML 解析失败：' + (e as Error).message, { cause: e })
  }
  const opmlEl = findDeep(tree, 'opml')
  if (!opmlEl) throw new Error('不是有效的 OPML 文件：缺少 <opml> 根元素')

  const title = findChild(findChild(opmlEl, 'head'), 'title')?.text.trim() || fallbackTitle
  const bodyEl = findChild(opmlEl, 'body')
  const tops = bodyEl ? bodyEl.children.filter((c) => c.tag.toLowerCase() === 'outline') : []

  const nodes: Record<string, MindNodeData> = {}
  const mk = (el: XmlNode, parent: string | null): string => {
    const id = uid()
    const text = (el.attrs.text ?? el.attrs.title ?? '').trim() || '(空)'
    const noteAttr = el.attrs._note
    nodes[id] = {
      id,
      parent,
      children: [],
      text,
      ...(noteAttr ? { note: noteAttr } : {}),
    }
    if (parent) nodes[parent].children.push(id)
    for (const c of el.children) {
      if (c.tag.toLowerCase() === 'outline') mk(c, id)
    }
    return id
  }

  let rootId: string
  if (tops.length === 0) {
    rootId = uid()
    nodes[rootId] = { id: rootId, parent: null, children: [], text: title }
  } else if (tops.length === 1) {
    rootId = mk(tops[0], null)
  } else {
    // 多个顶层 outline：建标题包裹根，保证单根树结构（mk 内部负责挂到 parent.children）
    rootId = uid()
    nodes[rootId] = { id: rootId, parent: null, children: [], text: title }
    for (const t of tops) mk(t, rootId)
  }

  const now = Date.now()
  return {
    version: 3,
    id: uid(),
    title,
    rootId,
    layout: 'logic',
    nodes,
    createdAt: now,
    updatedAt: now,
  }
}

/* ---------------- 甘特 CSV 导出 ---------------- */

/** CSV 单元格标准转义：含 , " \r \n 则用双引号包裹，内部 " 翻倍 */
function csvCell(s: string): string {
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/**
 * 导出甘特任务表 CSV（带 BOM 保证 Excel 中文不乱码）：
 * 列＝层级,任务,开始,结束,进度%,里程碑,前置任务；
 * 先序行；deps 的 from 解析为对应节点文本（重名不消歧，仅文本 join）；
 * 折叠状态不影响导出（完整树）。
 */
export function toGanttCSV(doc: DocData): string {
  const header = ['层级', '任务', '开始', '结束', '进度%', '里程碑', '优先级', '负责人', '备注', '前置任务']
  const rows: string[][] = [header]
  const root = doc.nodes[doc.rootId]
  if (!root) return '\ufeff' + header.map(csvCell).join(',') + '\r\n'

  const PRIORITY = ['', '低', '中', '高']

  // 先序收集 id→text，保证后续 deps 解析完整
  const textMap = new Map<string, string>()
  const order: { n: MindNodeData; lv: number }[] = []
  const collect = (n: MindNodeData, lv: number) => {
    textMap.set(n.id, n.text)
    order.push({ n, lv })
    for (const cid of n.children) {
      const c = doc.nodes[cid]
      if (c) collect(c, lv + 1)
    }
  }
  collect(root, 0)

  for (const { n, lv } of order) {
    const t = n.task
    const deps = t?.deps?.map((d) => textMap.get(d.from) ?? d.from).join('; ') ?? ''
    rows.push([
      String(lv),
      n.text,
      t?.start ?? '',
      t?.milestone ? '' : t?.end ?? '',
      typeof t?.progress === 'number' ? String(Math.round(t.progress * 100)) : '',
      t?.milestone ? '是' : '',
      t?.priority ? PRIORITY[t.priority] : '',
      t?.owner ?? '',
      t?.note ?? '',
      deps,
    ])
  }

  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}
