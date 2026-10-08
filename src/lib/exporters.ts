import type { BoundaryBox, DocData, Relation, Summary } from '../types'
import { flushSync } from 'react-dom'
import { computeLayout } from './layout'
import { getTheme } from './theme'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { ganttHolder, worldHolder } from '../store/refs'
import { parseMarkdown, parseOPML, sanitizeFileName, toGanttCSV, toMarkdown, toOPML } from './openFormats'
import { sanitizeHtml } from './sanitizeHtml'
import { jpegToPdf } from './pdf'
import { getBlob } from '../store/db'
import { getCachedBlobURL } from './blobUrl'

const LAST_BACKUP_KEY = 'msz.lastBackupAt'

/** M7-P3：blob → dataURL 转换的尺寸上限（>2MB 不内嵌，避免 JSON 体积爆炸） */
const DATAURL_MAX_BYTES = 2 * 1024 * 1024

export function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}

/** M7-P3：blob → dataURL；分块拼接避免 fromCharCode 一次性传入超大 TypedArray 溢出 */
export async function blobToDataURL(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return 'data:' + blob.type + ';base64,' + btoa(binary)
}

/** M7-P3：收集文档中所有 blobId（去重） */
export function collectBlobIds(doc: DocData): string[] {
  const ids = new Set<string>()
  for (const n of Object.values(doc.nodes)) {
    if (n.images) for (const im of n.images) ids.add(im.blobId)
    if (n.attachments) for (const at of n.attachments) ids.add(at.blobId)
  }
  return [...ids]
}

/**
 * M7-P3：把 SVG 中的 blob: URL 替换为 dataURL，使导出的 SVG/PNG 自包含可移植。
 * 仅替换缓存中已存在的 objectURL（即画布渲染过的图片）；未渲染的图片跳过。
 */
async function embedBlobImages(html: string, doc: DocData): Promise<string> {
  let out = html
  for (const blobId of collectBlobIds(doc)) {
    const cached = getCachedBlobURL(blobId)
    if (!cached) continue
    const blob = await getBlob(blobId)
    if (!blob || blob.size > DATAURL_MAX_BYTES) continue
    const dataURL = await blobToDataURL(blob)
    out = out.split(cached).join(dataURL)
  }
  return out
}

/**
 * 构建自包含导出载荷：文档 + _blobs（M7-P3：≤2MB 的图片/附件内嵌 dataURL，
 * 使 JSON/.msz 文件可跨设备完整恢复）。JSON 导出与 .msz 单文件模式共用此函数。
 */
export async function buildExportPayload(doc: DocData): Promise<string> {
  const _blobs: Record<string, { dataURL: string; type: string; name?: string }> = {}
  for (const blobId of collectBlobIds(doc)) {
    const blob = await getBlob(blobId)
    if (!blob || blob.size > DATAURL_MAX_BYTES) continue
    const dataURL = await blobToDataURL(blob)
    // 查找附件名（若有）
    let name: string | undefined
    for (const n of Object.values(doc.nodes)) {
      if (n.attachments) {
        const at = n.attachments.find((a) => a.blobId === blobId)
        if (at) {
          name = at.name
          break
        }
      }
    }
    _blobs[blobId] = { dataURL, type: blob.type, ...(name ? { name } : {}) }
  }
  return JSON.stringify({ ...doc, _blobs }, null, 2)
}

/** 记录一次完整备份时间（JSON/.msz 均为无损格式，导出/保存成功即视为备份，修审核 R-1） */
export function markBackupNow() {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()))
  } catch {
    /* localStorage 不可用时静默，备份本身已落盘 */
  }
}

export async function exportJSON(doc: DocData) {
  const payload = await buildExportPayload(doc)
  download(
    `${sanitizeFileName('猫思之-' + doc.title)}.json`,
    new Blob([payload], { type: 'application/json' }),
  )
  markBackupNow()
}

/** M10：导出 OPML 2.0 大纲交换文件（结构格式，不含任务/富内容） */
export function exportOPML(doc: DocData) {
  download(
    `${sanitizeFileName('猫思之-' + doc.title)}.opml`,
    new Blob([toOPML(doc)], { type: 'text/x-opml;charset=utf-8' }),
  )
}

interface ExportInput {
  worldHTML: string
  doc: DocData
  dark: boolean
}

/**
 * SVG 导出标记净化（修 S-2，纵深防御）：
 * - 移除 <script>；
 * - 移除 on* 事件属性（React 事件不会序列化进 innerHTML，正常产物不含，仅防外部脏数据）；
 * - 移除 javascript:/data: 协议的 href/xlink:href。
 * 本应用所有节点文本经 <text> 渲染，正常无脚本入口；此处仅为防御。
 */
function sanitizeSVGMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*"(?:javascript|data):[^"]*"/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*'(?:javascript|data):[^']*'/gi, '')
}

function buildSVG({ worldHTML, doc, dark }: ExportInput): { svg: string; w: number; h: number } {
  const theme = getTheme(dark)
  const b = computeLayout(doc).bounds
  const M = 48
  const x = b.x - M
  const y = b.y - M
  const w = Math.max(1, b.w + M * 2)
  const h = Math.max(1, b.h + M * 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.paper}"/>` +
    sanitizeSVGMarkup(worldHTML) +
    `</svg>`
  return { svg, w, h }
}

export function exportSVG(input: ExportInput) {
  const { svg } = buildSVG(input)
  download(
    `${sanitizeFileName('猫思之-' + input.doc.title)}.svg`,
    new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
  )
}

/** 思维导图 PNG 导出：构建 SVG 后复用 rasterize（修审计 L-5：消除与 rasterize 的重复实现） */
export async function exportPNG(input: ExportInput) {
  const { svg, w, h } = buildSVG(input)
  await rasterize(svg, w, h, input.doc.title)
}

/** M10：思维导图 PDF 导出：构建 SVG → JPEG 栅格化 → 自研 PDF 生成器 */
export async function exportPDF(input: ExportInput) {
  const { svg, w, h } = buildSVG(input)
  await rasterizeToPdf(svg, w, h, input.doc.title)
}

/** 导入防御：节点树最大深度（防恶意/损坏文件深层嵌套打爆递归布局栈） */
const MAX_IMPORT_DEPTH = 2000

/** 节点链接 url 协议白名单（与 sanitizeHtml 的 safeHref 对齐；#node- 为内部锚点） */
function safeLinkUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  return /^https?:\/\//i.test(url) || url.startsWith('#')
}

/**
 * 净化单个节点的富内容字段（修审计 H-1：导入文件可携带恶意 richNote.html，
 * NoteEditor 信任 prop 直写 innerHTML → 存储型 XSS；在导入边界统一净化）。
 * 原位修改通过基础校验的节点对象。
 */
function sanitizeImportedNode(n: Record<string, unknown>): void {
  // richNote.html 必须过白名单净化
  if (n.richNote !== undefined) {
    if (!n.richNote || typeof n.richNote !== 'object') {
      delete n.richNote
    } else {
      const html = (n.richNote as Record<string, unknown>).html
      if (typeof html !== 'string' || !html) delete n.richNote
      else n.richNote = { html: sanitizeHtml(html) }
    }
  }
  // links：剔除非 http(s)/# 锚点的 url（防 javascript: 协议跳转）
  if (n.links !== undefined) {
    if (!Array.isArray(n.links)) {
      delete n.links
    } else {
      n.links = n.links.filter((l): l is Record<string, unknown> => {
        if (!l || typeof l !== 'object') return false
        const r = l as Record<string, unknown>
        if (r.kind === 'url') return safeLinkUrl(r.url)
        if (r.kind === 'node') return typeof r.nodeId === 'string'
        return false
      })
      if (!(n.links as unknown[]).length) delete n.links
    }
  }
}

/**
 * 结构校验：JSON 导入时确认是合法的 DocData（修审核 S-3）。
 * 检查项：顶层字段类型；rootId 指向存在；每个节点 id/parent/children/text 字段类型；
 * parent↔children 双向一致（单父 + 双向一致 ⇒ 必为森林，不存在环）；
 * deps.from 指向存在；树深不超 MAX_IMPORT_DEPTH；富内容字段净化（H-1）。
 * 非法字段直接拒绝。
 */
export function validateDoc(d: unknown): DocData {
  if (!d || typeof d !== 'object') throw new Error('不是有效的猫思之文档')
  const o = d as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.rootId !== 'string') {
    throw new Error('不是有效的猫思之文档：缺少必要字段 id/title/rootId')
  }
  if (o.rootId === '') throw new Error('rootId 不能为空')
  const nodes = o.nodes
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
    throw new Error('nodes 必须是节点映射对象')
  }
  const nodeMap = nodes as Record<string, unknown>
  const root = nodeMap[o.rootId]
  if (!root || typeof root !== 'object') throw new Error('rootId 指向的节点不存在')

  // 校验每个节点
  for (const [id, raw] of Object.entries(nodeMap)) {
    if (!raw || typeof raw !== 'object') throw new Error(`节点 ${id} 不是对象`)
    const n = raw as Record<string, unknown>
    if (typeof n.id !== 'string' || n.id !== id) throw new Error(`节点 ${id} 的 id 字段不一致`)
    if (typeof n.text !== 'string') throw new Error(`节点 ${id} 缺少 text 字符串`)
    // parent 可为 null（根）或字符串
    if (n.parent !== null && typeof n.parent !== 'string') {
      throw new Error(`节点 ${id} 的 parent 字段类型错误`)
    }
    if (!Array.isArray(n.children) || !n.children.every((c) => typeof c === 'string')) {
      throw new Error(`节点 ${id} 的 children 必须是字符串数组`)
    }
    // task 可选
    if (n.task !== undefined) {
      if (!n.task || typeof n.task !== 'object') throw new Error(`节点 ${id} 的 task 字段类型错误`)
      const t = n.task as Record<string, unknown>
      if (t.start !== undefined && typeof t.start !== 'string') throw new Error(`节点 ${id} 的 task.start 必须是字符串`)
      if (t.end !== undefined && typeof t.end !== 'string') throw new Error(`节点 ${id} 的 task.end 必须是字符串`)
      if (t.progress !== undefined && typeof t.progress !== 'number') throw new Error(`节点 ${id} 的 task.progress 必须是数字`)
      if (t.milestone !== undefined && typeof t.milestone !== 'boolean') throw new Error(`节点 ${id} 的 task.milestone 必须是布尔`)
      if (t.deps !== undefined) {
        if (!Array.isArray(t.deps)) throw new Error(`节点 ${id} 的 task.deps 必须是数组`)
        for (const dep of t.deps) {
          if (!dep || typeof dep !== 'object') throw new Error(`节点 ${id} 的 task.deps 项必须是对象`)
          const dk = dep as Record<string, unknown>
          if (typeof dk.from !== 'string' || typeof dk.type !== 'string') {
            throw new Error(`节点 ${id} 的 task.deps 项缺少 from/type 字符串`)
          }
          // 修 L-3：type 必须是四种依赖类型之一，拒绝任意字符串
          if (!['FS', 'SS', 'FF', 'SF'].includes(dk.type)) {
            throw new Error(`节点 ${id} 的 task.deps.type=${dk.type} 非法，须为 FS/SS/FF/SF`)
          }
          if (!nodeMap[dk.from]) throw new Error(`节点 ${id} 的 task.deps.from 指向不存在的节点 ${dk.from}`)
        }
      }
    }
    // 修审计 H-1：富内容字段（richNote/links）在导入边界净化，杜绝存储型 XSS
    sanitizeImportedNode(n)
  }

  // parent↔children 双向一致性
  for (const [id, raw] of Object.entries(nodeMap)) {
    const n = raw as Record<string, unknown>
    const parent = n.parent
    const children = n.children as string[]
    if (parent === null) {
      if (id !== o.rootId) throw new Error(`节点 ${id} 的 parent 为 null 但不是 rootId`)
    } else {
      // 根节点的 parent 必须为 null，指向其它节点视为结构错误
      if (id === o.rootId) throw new Error(`根节点 rootId=${o.rootId} 的 parent 必须为 null`)
      if (typeof parent !== 'string' || !nodeMap[parent]) {
        throw new Error(`节点 ${id} 的 parent 指向不存在的节点 ${String(parent)}`)
      }
      const pn = nodeMap[parent] as Record<string, unknown>
      const pchildren = pn.children as string[]
      if (!pchildren.includes(id)) throw new Error(`节点 ${id} 声明 parent=${parent} 但对方 children 未包含`)
    }
    for (const c of children) {
      if (!nodeMap[c]) throw new Error(`节点 ${id} 的 children 包含不存在的节点 ${c}`)
      const cn = nodeMap[c] as Record<string, unknown>
      if (cn.parent !== id) throw new Error(`节点 ${id} 的 child ${c} 的 parent 不是 ${id}`)
    }
  }

  // 深度上限：防超深嵌套在递归布局（layout.build）处栈溢出（修审计 M-9）
  {
    const stack: [string, number][] = [[o.rootId, 1]]
    while (stack.length) {
      const [id, depth] = stack.pop()!
      if (depth > MAX_IMPORT_DEPTH) throw new Error(`节点树深度超过上限 ${MAX_IMPORT_DEPTH}`)
      for (const c of (nodeMap[id] as Record<string, unknown>).children as string[]) {
        stack.push([c, depth + 1])
      }
    }
  }

  // M9：关系表达可选字段校验（relations/summaries/boundaryBoxes）
  let relations: Relation[] | undefined
  let summaries: Summary[] | undefined
  let boundaryBoxes: BoundaryBox[] | undefined
  if (o.relations !== undefined) {
    if (!Array.isArray(o.relations)) throw new Error('relations 必须是数组')
    const rels: Relation[] = []
    for (const r of o.relations) {
      if (!r || typeof r !== 'object') throw new Error('relations 项必须是对象')
      const rk = r as Record<string, unknown>
      if (typeof rk.id !== 'string' || typeof rk.from !== 'string' || typeof rk.to !== 'string') {
        throw new Error('relation 项缺少 id/from/to 字符串')
      }
      if (!nodeMap[rk.from]) throw new Error(`relation.from 指向不存在的节点 ${rk.from}`)
      if (!nodeMap[rk.to]) throw new Error(`relation.to 指向不存在的节点 ${rk.to}`)
      if (rk.label !== undefined && typeof rk.label !== 'string') throw new Error('relation.label 必须是字符串')
      if (rk.color !== undefined && typeof rk.color !== 'string') throw new Error('relation.color 必须是字符串')
      rels.push(rk as unknown as Relation)
    }
    relations = rels
  }
  if (o.summaries !== undefined) {
    if (!Array.isArray(o.summaries)) throw new Error('summaries 必须是数组')
    const sums: Summary[] = []
    for (const sm of o.summaries) {
      if (!sm || typeof sm !== 'object') throw new Error('summaries 项必须是对象')
      const sk = sm as Record<string, unknown>
      if (typeof sk.id !== 'string') throw new Error('summary 项缺少 id 字符串')
      if (!Array.isArray(sk.members) || !sk.members.every((m) => typeof m === 'string')) {
        throw new Error('summary.members 必须是字符串数组')
      }
      for (const m of sk.members as string[]) {
        if (!nodeMap[m]) throw new Error(`summary.member 指向不存在的节点 ${m}`)
      }
      if (sk.label !== undefined && typeof sk.label !== 'string') throw new Error('summary.label 必须是字符串')
      if (sk.color !== undefined && typeof sk.color !== 'string') throw new Error('summary.color 必须是字符串')
      sums.push(sk as unknown as Summary)
    }
    summaries = sums
  }
  if (o.boundaryBoxes !== undefined) {
    if (!Array.isArray(o.boundaryBoxes)) throw new Error('boundaryBoxes 必须是数组')
    const boxes: BoundaryBox[] = []
    for (const b of o.boundaryBoxes) {
      if (!b || typeof b !== 'object') throw new Error('boundaryBoxes 项必须是对象')
      const bk = b as Record<string, unknown>
      if (typeof bk.id !== 'string') throw new Error('boundaryBox 项缺少 id 字符串')
      if (!Array.isArray(bk.members) || !bk.members.every((m) => typeof m === 'string')) {
        throw new Error('boundaryBox.members 必须是字符串数组')
      }
      for (const m of bk.members as string[]) {
        if (!nodeMap[m]) throw new Error(`boundaryBox.member 指向不存在的节点 ${m}`)
      }
      if (bk.label !== undefined && typeof bk.label !== 'string') throw new Error('boundaryBox.label 必须是字符串')
      if (bk.color !== undefined && typeof bk.color !== 'string') throw new Error('boundaryBox.color 必须是字符串')
      boxes.push(bk as unknown as BoundaryBox)
    }
    boundaryBoxes = boxes
  }

  return { ...(o as unknown as DocData), version: 3, relations, summaries, boundaryBoxes }
}

/**
 * 解析导入内容：按扩展名分流（修审核 S-3）。
 * - .json / .msz：JSON.parse + 结构校验；剥离 _blobs 单独返回（M7-P3 由调用方落盘）
 * - .md / .markdown：parseMarkdown（容错兜底）
 * - .opml：parseOPML（XML 大纲交换格式，M10）
 * - filename 缺省（如剪贴板粘贴 JSON）：按 JSON 解析
 */
export function parseImported(
  text: string,
  filename?: string,
): { doc: DocData; blobs: Record<string, { dataURL: string; type: string; name?: string }> } {
  const ext = filename ? filename.toLowerCase().replace(/^.*\./, '') : ''
  if (ext === 'md' || ext === 'markdown') {
    const fallback = filename ? filename.replace(/\.[^.]+$/, '') : '未命名导图'
    return { doc: parseMarkdown(text, fallback), blobs: {} }
  }
  if (ext === 'opml' || ext === 'xml') {
    const fallback = filename ? filename.replace(/\.[^.]+$/, '') : '未命名导图'
    return { doc: parseOPML(text, fallback), blobs: {} }
  }
  // 默认按 JSON 处理
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch (e) {
    throw new Error('不是有效的 JSON 文档：' + (e as Error).message, { cause: e })
  }
  const o = d as Record<string, unknown>
  const blobs = (o._blobs as Record<string, { dataURL: string; type: string; name?: string }>) ?? {}
  const doc = validateDoc(d)
  // _blobs 不进入文档本体
  delete (doc as unknown as Record<string, unknown>)._blobs
  return { doc, blobs }
}

/** 从当前应用状态导出（先取消选择以获得干净画面） */
export async function exportCurrent(kind: 'json' | 'svg' | 'png' | 'pdf' | 'md' | 'csv' | 'opml') {
  const doc = useDoc.getState().doc
  if (kind === 'json') {
    await exportJSON(doc)
    return
  }
  if (kind === 'md') {
    download(
      `${sanitizeFileName('猫思之-' + doc.title)}.md`,
      new Blob([toMarkdown(doc)], { type: 'text/markdown;charset=utf-8' }),
    )
    return
  }
  if (kind === 'opml') {
    exportOPML(doc)
    return
  }
  if (kind === 'csv') {
    download(
      `${sanitizeFileName('猫思之-' + doc.title + '-甘特')}.csv`,
      new Blob([toGanttCSV(doc)], { type: 'text/csv;charset=utf-8' }),
    )
    return
  }
  // M8-P2-2（R1 红线）：flushSync 强制 React 同步提交全量渲染（concurrent 模式下
  // 大文档渲染可能被切片，两帧 rAF 不足以保证全部节点入 DOM）。
  // clearSel + exportFullRender 一起 flush，再等两帧确保浏览器绘制完毕。
  flushSync(() => {
    useDoc.getState().clearSel()
    useSettings.setState({ exportFullRender: true })
  })
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  )
  try {
    if (useSettings.getState().view === 'gantt' && ganttHolder.current) {
      const svg = new XMLSerializer().serializeToString(ganttHolder.current)
      const gw = ganttHolder.current.width.baseVal.value
      const gh = ganttHolder.current.height.baseVal.value
      const gname = doc.title + '-甘特'
      if (kind === 'svg') {
        download(
          `${sanitizeFileName('猫思之-' + gname)}.svg`,
          new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
        )
      } else if (kind === 'pdf') {
        await rasterizeToPdf(svg, gw, gh, gname)
      } else {
        await rasterize(svg, gw, gh, gname)
      }
      return
    }
    const worldHTML = worldHolder.current?.innerHTML ?? ''
    // M7-P3：把 blob: URL 替换为 dataURL，使 SVG/PNG/PDF 自包含可移植
    const embedded = await embedBlobImages(worldHTML, doc)
    const input: ExportInput = { worldHTML: embedded, doc, dark: useSettings.getState().dark }
    if (kind === 'svg') exportSVG(input)
    else if (kind === 'pdf') await exportPDF(input)
    else await exportPNG(input)
  } finally {
    useSettings.setState({ exportFullRender: false })
  }
}

/** Canvas 单边像素上限（Chrome/Safari 硬限制约 16384，留余量取 14000） */
const MAX_CANVAS_DIM = 14000

/** 把 SVG 载入 Image 并绘制到 2x 离屏 canvas；超大图自动降档避免越过浏览器尺寸上限 */
async function svgToCanvas(svg: string, w: number, h: number): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const img = new Image()
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('SVG 渲染失败'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
  let scale = 2
  if (Math.round(w * scale) > MAX_CANVAS_DIM || Math.round(h * scale) > MAX_CANVAS_DIM) {
    scale = Math.min(1, MAX_CANVAS_DIM / Math.max(w, h))
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 上下文不可用，无法栅格化')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  return { canvas, scale }
}

async function rasterize(svg: string, w: number, h: number, name: string) {
  const { canvas } = await svgToCanvas(svg, w, h)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) download(`${sanitizeFileName('猫思之-' + name)}.png`, blob)
}

/**
 * M10：SVG → JPEG → 单页 PDF。JPEG 质量 0.92（奶油纸底+手绘线条，0.92 视觉无可见损失）；
 * 页面尺寸用 CSS 像素当 PDF point（72dpi 常规屏幕观感），图像用 2x 像素保证打印清晰。
 */
async function rasterizeToPdf(svg: string, w: number, h: number, name: string) {
  const { canvas, scale } = await svgToCanvas(svg, w, h)
  const jpegBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92))
  if (!jpegBlob) throw new Error('JPEG 编码失败，无法导出 PDF')
  const buf = new Uint8Array(await jpegBlob.arrayBuffer())
  const pdf = jpegToPdf({
    jpeg: buf,
    pxW: canvas.width,
    pxH: canvas.height,
    ptW: Math.round(canvas.width / scale),
    ptH: Math.round(canvas.height / scale),
  })
  download(
    `${sanitizeFileName('猫思之-' + name)}.pdf`,
    // pdf 为精确分配的 Uint8Array，其 buffer 即完整 ArrayBuffer（TS 5.5 BlobPart 类型收窄）
    new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' }),
  )
}
