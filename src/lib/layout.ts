import type { DocData } from '../types'
import { measureText } from './measure'

export interface LaidNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** 1 = 子节点在右侧，-1 = 左侧 */
  side: 1 | -1
  level: number
  /** 分支色索引 'b0'..'b5'（'' = 主题默认） */
  color: string
  collapsed: boolean
  hasChildren: boolean
  /** 折叠隐藏的后代数 */
  hidden: number
  fontSize: number
}

export interface LaidEdge {
  from: string
  to: string
  /** [x0,y0,c1x,c1y,c2x,c2y,x1,y1] 三次贝塞尔 */
  points: number[]
  /** 线条色索引（'' = 用主题 ink） */
  color: string
  level: number
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutResult {
  nodes: Map<string, LaidNode>
  edges: LaidEdge[]
  bounds: Bounds
}

const GX = 52
const GY = 14
const PADX = 13
const PADY = 9

interface WT {
  id: string
  w: number
  h: number
  fs: number
  kids: WT[]
  subH: number
  hidden: number
}

function countAll(nodes: DocData['nodes'], id: string): number {
  const n = nodes[id]
  if (!n) return 0
  return n.children.reduce((s, c) => s + 1 + countAll(nodes, c), 0)
}

function measure(text: string, level: number, hasNote: boolean) {
  const fs = level === 0 ? 24 : level === 1 ? 16 : 14
  const tw = measureText(text, fs) + (hasNote ? 18 : 0)
  const w = Math.max(level === 0 ? 100 : 60, tw + PADX * 2)
  const h = level === 0 ? 52 : fs + PADY * 2
  return { w, h, fs }
}

function build(doc: DocData, id: string, level: number): WT | null {
  const n = doc.nodes[id]
  if (!n) return null
  const { w, h, fs } = measure(n.text, level, !!n.note)
  const kids: WT[] = n.collapsed ? [] : (n.children.map((c) => build(doc, c, level + 1)).filter(Boolean) as WT[])
  const subH = kids.length
    ? Math.max(h, kids.reduce((s, k) => s + k.subH, 0) + GY * (kids.length - 1))
    : h
  const hidden = n.collapsed ? countAll(doc.nodes, id) : kids.reduce((s, k) => s + k.hidden, 0)
  return { id, w, h, fs, kids, subH, hidden }
}

/** 递归放置一个分支（含其子树与边）。side=-1 时子节点向左展开。 */
function place(
  doc: DocData,
  wt: WT,
  left: number,
  top: number,
  side: 1 | -1,
  level: number,
  color: string,
  out: Map<string, LaidNode>,
  edges: LaidEdge[],
) {
  const n = doc.nodes[wt.id]
  out.set(wt.id, {
    id: wt.id, x: left, y: top, w: wt.w, h: wt.h,
    side, level, color, collapsed: !!n?.collapsed,
    hasChildren: (n?.children.length ?? 0) > 0,
    hidden: wt.hidden, fontSize: wt.fs,
  })
  if (!wt.kids.length) return
  const totalH = wt.kids.reduce((s, k) => s + k.subH, 0) + GY * (wt.kids.length - 1)
  let cy = top + wt.h / 2 - totalH / 2
  const ax = side === 1 ? left + wt.w : left
  const ay = top + wt.h / 2
  for (const k of wt.kids) {
    const kx = side === 1 ? left + wt.w + GX : left - GX - k.w
    const ky = cy + k.subH / 2 - k.h / 2
    const bx = side === 1 ? kx : kx + k.w
    const by = ky + k.h / 2
    const midX = ax + (bx - ax) * 0.5
    edges.push({
      from: wt.id, to: k.id,
      points: [ax, ay, midX, ay, midX, by, bx, by],
      color: level === 0 ? color : '',
      level: level + 1,
    })
    place(doc, k, kx, ky, side, level + 1, color, out, edges)
    cy += k.subH + GY
  }
}

export function computeLayout(doc: DocData): LayoutResult {
  const out = new Map<string, LaidNode>()
  const edges: LaidEdge[] = []
  const rootWt = build(doc, doc.rootId, 0)
  if (!rootWt) return { nodes: out, edges, bounds: { x: 0, y: 0, w: 100, h: 60 } }

  out.set(doc.rootId, {
    id: doc.rootId, x: 0, y: 0, w: rootWt.w, h: rootWt.h,
    side: 1, level: 0, color: '', collapsed: false,
    hasChildren: (doc.nodes[doc.rootId]?.children.length ?? 0) > 0,
    hidden: rootWt.hidden, fontSize: rootWt.fs,
  })

  const kids = rootWt.kids
  const colorOf = new Map<string, string>()
  kids.forEach((k, i) => colorOf.set(k.id, 'b' + (i % 6)))

  /** 根 → 一级分支的连接（place 只画 wt→孙，根边需单独添加） */
  const rootEdge = (k: WT, kx: number, ky: number, side: 1 | -1, color: string) => {
    const ax = side === 1 ? rootWt.w : 0
    const ay = rootWt.h / 2
    const bx = side === 1 ? kx : kx + k.w
    const by = ky + k.h / 2
    const midX = ax + (bx - ax) * 0.5
    edges.push({
      from: doc.rootId, to: k.id,
      points: [ax, ay, midX, ay, midX, by, bx, by],
      color, level: 1,
    })
  }

  if (doc.layout === 'tree' && kids.length > 1) {
    // 按累计子树高贪心分左右，保持各侧内部顺序
    const right: WT[] = []
    const left: WT[] = []
    let rh = 0, lh = 0
    for (const k of kids) {
      if (rh <= lh) { right.push(k); rh += k.subH + GY } else { left.push(k); lh += k.subH + GY }
    }
    const cy0 = rootWt.h / 2
    let cy = cy0 - (rh - GY) / 2
    for (const k of right) {
      const ky = cy + k.subH / 2 - k.h / 2
      const kx = rootWt.w + GX
      rootEdge(k, kx, ky, 1, colorOf.get(k.id) ?? '')
      place(doc, k, kx, ky, 1, 1, colorOf.get(k.id) ?? '', out, edges)
      cy += k.subH + GY
    }
    let cy2 = cy0 - (lh - GY) / 2
    for (const k of left) {
      const ky = cy2 + k.subH / 2 - k.h / 2
      const kx = -GX - k.w
      rootEdge(k, kx, ky, -1, colorOf.get(k.id) ?? '')
      place(doc, k, kx, ky, -1, 1, colorOf.get(k.id) ?? '', out, edges)
      cy2 += k.subH + GY
    }
  } else {
    const totalH = kids.reduce((s, k) => s + k.subH, 0) + GY * (kids.length - 1)
    let cy = rootWt.h / 2 - totalH / 2
    for (const k of kids) {
      const ky = cy + k.subH / 2 - k.h / 2
      const kx = rootWt.w + GX
      rootEdge(k, kx, ky, 1, colorOf.get(k.id) ?? '')
      place(doc, k, kx, ky, 1, 1, colorOf.get(k.id) ?? '', out, edges)
      cy += k.subH + GY
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of out.values()) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  const bounds: Bounds = out.size
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 100, h: 60 }
  return { nodes: out, edges, bounds }
}
