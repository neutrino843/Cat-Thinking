import type { DocData } from '../types'
import { computeLayout } from './layout'
import { getTheme } from './theme'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { ganttHolder, worldHolder } from '../store/refs'
import { parseMarkdown, sanitizeFileName, toGanttCSV, toMarkdown } from './openFormats'
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
async function blobToDataURL(blob: Blob): Promise<string> {
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
function collectBlobIds(doc: DocData): string[] {
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

export async function exportJSON(doc: DocData) {
  // M7-P3：把 blob 内嵌为 _blobs map，导出文件自包含可跨设备恢复
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
  const payload = { ...doc, _blobs }
  download(
    `${sanitizeFileName('猫思之-' + doc.title)}.json`,
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  )
  // JSON 是唯一无损格式，导出成功即视为一次完整备份（修审核 R-1）
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()))
  } catch {
    /* localStorage 不可用时静默，备份本身已落盘 */
  }
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

export async function exportPNG(input: ExportInput, scale = 2) {
  const { svg, w, h } = buildSVG(input)
  const img = new Image()
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('SVG 渲染失败'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 上下文不可用，无法导出 PNG')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) download(`${sanitizeFileName('猫思之-' + input.doc.title)}.png`, blob)
}

/**
 * 结构校验：JSON 导入时确认是合法的 DocData（修审核 S-3）。
 * 检查项：顶层字段类型；rootId 指向存在；每个节点 id/parent/children/text 字段类型；
 * parent↔children 双向一致；deps.from 指向存在；非法字段直接拒绝。
 */
function validateDoc(d: unknown): DocData {
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

  return { ...(o as unknown as DocData), version: 2 }
}

/**
 * 解析导入内容：按扩展名分流（修审核 S-3）。
 * - .json：JSON.parse + 结构校验；剥离 _blobs 单独返回（M7-P3 由调用方落盘）
 * - .md / .markdown：parseMarkdown（容错兜底）
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
  // 默认按 JSON 处理
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch (e) {
    throw new Error('不是有效的 JSON 文档：' + (e as Error).message)
  }
  const o = d as Record<string, unknown>
  const blobs = (o._blobs as Record<string, { dataURL: string; type: string; name?: string }>) ?? {}
  const doc = validateDoc(d)
  // _blobs 不进入文档本体
  delete (doc as unknown as Record<string, unknown>)._blobs
  return { doc, blobs }
}

/** 从当前应用状态导出（先取消选择以获得干净画面） */
export async function exportCurrent(kind: 'json' | 'svg' | 'png' | 'md' | 'csv') {
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
  if (kind === 'csv') {
    download(
      `${sanitizeFileName('猫思之-' + doc.title + '-甘特')}.csv`,
      new Blob([toGanttCSV(doc)], { type: 'text/csv;charset=utf-8' }),
    )
    return
  }
  useDoc.getState().clearSel()
  // 修 F-4：等两帧确保 React 完成重渲染并绘制（比固定 80ms 在慢机/大文档上可靠）
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  )
  if (useSettings.getState().view === 'gantt' && ganttHolder.current) {
    const svg = new XMLSerializer().serializeToString(ganttHolder.current)
    if (kind === 'svg') {
      download(
        `${sanitizeFileName('猫思之-' + doc.title + '-甘特')}.svg`,
        new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      )
    } else {
      await rasterize(svg, ganttHolder.current.width.baseVal.value, ganttHolder.current.height.baseVal.value, doc.title + '-甘特')
    }
    return
  }
  const worldHTML = worldHolder.current?.innerHTML ?? ''
  // M7-P3：把 blob: URL 替换为 dataURL，使 SVG/PNG 自包含可移植
  const embedded = await embedBlobImages(worldHTML, doc)
  const input: ExportInput = { worldHTML: embedded, doc, dark: useSettings.getState().dark }
  if (kind === 'svg') exportSVG(input)
  else await exportPNG(input)
}

async function rasterize(svg: string, w: number, h: number, name: string) {
  const img = new Image()
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('SVG 渲染失败'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 上下文不可用，无法导出 PNG')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) download(`${sanitizeFileName('猫思之-' + name)}.png`, blob)
}
