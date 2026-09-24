 import type { DocData, MindNodeData } from '../types'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

const DAY = 86400000

/**
 * 文件名清洗：去除 \\ / : * ? " < > | 与控制字符，首尾空白裁剪；
 * 空名回退「未命名导图」。新老导出统一使用，避免非法文件名触发浏览器降级。
 */
export function sanitizeFileName(name: string): string {
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
    if (n.href) line += ` [🔗](${n.href})`
    lines.push(line)
    if (n.note) {
      const noteIndent = '  '.repeat(depth + 1)
      for (const nl of n.note.split('\n')) lines.push(`${noteIndent}> ${nl}`)
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
  let foundTitle = false

  // 跳过空行直到首个 H1 或首个非空行
  for (; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    const h1 = raw.match(/^#\s+(.+?)\s*$/)
    if (h1) {
      title = h1[1].trim() || fallbackTitle
      foundTitle = true
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
        const endOnly = seg.match(`^→\\s*${DATE_RE}$`)
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
    version: 2,
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
  const header = ['层级', '任务', '开始', '结束', '进度%', '里程碑', '前置任务']
  const rows: string[][] = [header]
  const root = doc.nodes[doc.rootId]
  if (!root) return '\ufeff' + header.map(csvCell).join(',') + '\r\n'

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
    const deps = n.task?.deps?.map((d) => textMap.get(d.from) ?? d.from).join(', ') ?? ''
    rows.push([
      String(lv),
      n.text,
      n.task?.start ?? '',
      n.task?.end ?? '',
      typeof n.task?.progress === 'number' ? String(n.task.progress) : '',
      n.task?.milestone ? '是' : '',
      deps,
    ])
  }

  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}
