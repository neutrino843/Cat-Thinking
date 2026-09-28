import type { DocData, NodeImage } from '../types'
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
  /** M7-P3：节点图片占用的高度（文本区以下），无图片为 0 */
  imgH: number
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

/** M7-P3：节点图片最大显示宽度，超出按此宽度等比缩放 */
const IMG_MAX_W = 140

/* ---- M7-P4 新布局常量 ---- */
/** org：父子垂直间距 */
const GY_TOP = 28
/** fishbone：一级分支水平间距 */
const FISH_LEVEL1_GAP = 90
/** fishbone：分支内子节点步进 */
const FISH_STEP = 20
/** timeline：水平列间距 */
const TIMELINE_COL_GAP = 140
/** timeline：上下行高 */
const TIMELINE_ROW_H = 36

interface WT {
  id: string
  w: number
  h: number
  fs: number
  imgH: number
  kids: WT[]
  /** 子树总高（含兄弟间距） */
  subH: number
  /** M7-P4 org：子树总宽（含兄弟间距） */
  subW: number
  hidden: number
}

function countAll(nodes: DocData['nodes'], id: string): number {
  const n = nodes[id]
  if (!n) return 0
  return n.children.reduce((s, c) => s + 1 + countAll(nodes, c), 0)
}

/**
 * M7-P3：计算节点图片占用高度。
 * 每张图按 Math.min(IMG_MAX_W, img.w) 等比缩放，行间 6px 间距；
 * 无图片返回 0。
 */
function imagesExtraH(images: NodeImage[] | undefined, _nodeW: number): number {
  if (!images || !images.length) return 0
  let h = 0
  for (const img of images) {
    const displayW = Math.min(IMG_MAX_W, img.w)
    const displayH = img.h * (displayW / img.w)
    h += displayH
  }
  return h + 6 * images.length
}

function measure(text: string, level: number, hasNote: boolean, images?: NodeImage[]) {
  const fs = level === 0 ? 24 : level === 1 ? 16 : 14
  const tw = measureText(text, fs) + (hasNote ? 18 : 0)
  const w = Math.max(level === 0 ? 100 : 60, tw + PADX * 2)
  const imgH = imagesExtraH(images, w)
  const h = (level === 0 ? 52 : fs + PADY * 2) + imgH
  return { w, h, fs, imgH }
}

function build(doc: DocData, id: string, level: number): WT | null {
  const n = doc.nodes[id]
  if (!n) return null
  const { w, h, fs, imgH } = measure(n.text, level, !!n.note, n.images)
  const kids: WT[] = n.collapsed ? [] : (n.children.map((c) => build(doc, c, level + 1)).filter(Boolean) as WT[])
  const subH = kids.length
    ? Math.max(h, kids.reduce((s, k) => s + k.subH, 0) + GY * (kids.length - 1))
    : h
  // M7-P4 org：子树总宽，叶子为自身宽，父为 max(自身, Σ子宽 + 间距)
  const subW = kids.length
    ? Math.max(w, kids.reduce((s, k) => s + k.subW, 0) + GY * (kids.length - 1))
    : w
  const hidden = n.collapsed ? countAll(doc.nodes, id) : kids.reduce((s, k) => s + k.hidden, 0)
  return { id, w, h, fs, imgH, kids, subH, subW, hidden }
}

/** M7-P4：bounds 计算，5 个分支函数共用。 */
function boundsOf(out: Map<string, LaidNode>): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of out.values()) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return out.size
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 100, h: 60 }
}

/* =============== logic / tree（原布局，重构后共用 placeLogicOrTree） =============== */

/** 递归放置一个分支（含其子树与边）。side=-1 时子节点向左展开。 */
function placeLogicOrTree(
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
    hidden: wt.hidden, fontSize: wt.fs, imgH: wt.imgH,
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
    placeLogicOrTree(doc, k, kx, ky, side, level + 1, color, out, edges)
    cy += k.subH + GY
  }
}

/** logic：根在左，全部一级分支向右展开 */
function layoutLogic(doc: DocData, rootWt: WT, out: Map<string, LaidNode>, edges: LaidEdge[]) {
  out.set(doc.rootId, {
    id: doc.rootId, x: 0, y: 0, w: rootWt.w, h: rootWt.h,
    side: 1, level: 0, color: '', collapsed: false,
    hasChildren: (doc.nodes[doc.rootId]?.children.length ?? 0) > 0,
    hidden: rootWt.hidden, fontSize: rootWt.fs, imgH: rootWt.imgH,
  })
  const kids = rootWt.kids
  const colorOf = new Map<string, string>()
  kids.forEach((k, i) => colorOf.set(k.id, 'b' + (i % 6)))
  const totalH = kids.reduce((s, k) => s + k.subH, 0) + GY * Math.max(0, kids.length - 1)
  let cy = rootWt.h / 2 - totalH / 2
  for (const k of kids) {
    const ky = cy + k.subH / 2 - k.h / 2
    const kx = rootWt.w + GX
    const color = colorOf.get(k.id) ?? ''
    const ax = rootWt.w
    const ay = rootWt.h / 2
    const bx = kx
    const by = ky + k.h / 2
    const midX = ax + (bx - ax) * 0.5
    edges.push({
      from: doc.rootId, to: k.id,
      points: [ax, ay, midX, ay, midX, by, bx, by],
      color, level: 1,
    })
    placeLogicOrTree(doc, k, kx, ky, 1, 1, color, out, edges)
    cy += k.subH + GY
  }
}

/** tree：多分支时左右贪心平衡；单分支退化到 logic */
function layoutTree(doc: DocData, rootWt: WT, out: Map<string, LaidNode>, edges: LaidEdge[]) {
  const kids = rootWt.kids
  if (kids.length <= 1) {
    return layoutLogic(doc, rootWt, out, edges)
  }
  out.set(doc.rootId, {
    id: doc.rootId, x: 0, y: 0, w: rootWt.w, h: rootWt.h,
    side: 1, level: 0, color: '', collapsed: false,
    hasChildren: (doc.nodes[doc.rootId]?.children.length ?? 0) > 0,
    hidden: rootWt.hidden, fontSize: rootWt.fs, imgH: rootWt.imgH,
  })
  // 按累计子树高贪心分左右，保持各侧内部顺序
  const right: WT[] = []
  const left: WT[] = []
  let rh = 0, lh = 0
  for (const k of kids) {
    if (rh <= lh) { right.push(k); rh += k.subH + GY } else { left.push(k); lh += k.subH + GY }
  }
  const colorOf = new Map<string, string>()
  kids.forEach((k, i) => colorOf.set(k.id, 'b' + (i % 6)))
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
  const cy0 = rootWt.h / 2
  let cy = cy0 - (rh - GY) / 2
  for (const k of right) {
    const ky = cy + k.subH / 2 - k.h / 2
    const kx = rootWt.w + GX
    rootEdge(k, kx, ky, 1, colorOf.get(k.id) ?? '')
    placeLogicOrTree(doc, k, kx, ky, 1, 1, colorOf.get(k.id) ?? '', out, edges)
    cy += k.subH + GY
  }
  let cy2 = cy0 - (lh - GY) / 2
  for (const k of left) {
    const ky = cy2 + k.subH / 2 - k.h / 2
    const kx = -GX - k.w
    rootEdge(k, kx, ky, -1, colorOf.get(k.id) ?? '')
    placeLogicOrTree(doc, k, kx, ky, -1, 1, colorOf.get(k.id) ?? '', out, edges)
    cy2 += k.subH + GY
  }
}

/* =============== M7-P4 org（组织架构图） =============== */

/**
 * org：根在顶部居中，子节点向下展开，同层水平排布居中。
 * 子树宽度 subW 递归累积；父节点居中后子节点按 subW 分配水平位置。
 */
function placeOrg(
  doc: DocData,
  wt: WT,
  cx: number,
  top: number,
  level: number,
  color: string,
  colorOf: Map<string, string>,
  out: Map<string, LaidNode>,
  edges: LaidEdge[],
) {
  const n = doc.nodes[wt.id]
  out.set(wt.id, {
    id: wt.id, x: cx - wt.w / 2, y: top, w: wt.w, h: wt.h,
    side: 1, level, color, collapsed: !!n?.collapsed,
    hasChildren: (n?.children.length ?? 0) > 0,
    hidden: wt.hidden, fontSize: wt.fs, imgH: wt.imgH,
  })
  if (!wt.kids.length) return
  const totalW = wt.kids.reduce((s, k) => s + k.subW, 0) + GY * (wt.kids.length - 1)
  let x = cx - totalW / 2
  const ay = top + wt.h
  let i = 0
  for (const k of wt.kids) {
    const kcx = x + k.subW / 2
    const ky = top + wt.h + GY_TOP
    const by = ky + k.h / 2
    // 根的子节点分配轮转色 b0..b5；其余继承父色
    const kColor = level === 0 ? (colorOf.get(k.id) ?? '') : color
    edges.push({
      from: wt.id, to: k.id,
      points: [cx, ay, cx, ay + GY_TOP / 2, kcx, ay + GY_TOP / 2, kcx, by],
      color: level === 0 ? kColor : '',
      level: level + 1,
    })
    placeOrg(doc, k, kcx, ky, level + 1, kColor, colorOf, out, edges)
    x += k.subW + GY
    i++
  }
}

function layoutOrg(doc: DocData, rootWt: WT, out: Map<string, LaidNode>, edges: LaidEdge[]) {
  const kids = rootWt.kids
  const colorOf = new Map<string, string>()
  kids.forEach((k, i) => colorOf.set(k.id, 'b' + (i % 6)))
  // 根居中（cx=0），向下展开
  placeOrg(doc, rootWt, 0, 0, 0, '', colorOf, out, edges)
}

/* =============== M7-P4 fishbone（鱼骨图） =============== */

/**
 * fishbone：根=鱼头在最左，脊线水平向右延伸；
 * 一级分支上下交替偏离脊线，分支上的子节点水平排开。
 * 脊线本身不显式绘制——由一级分支边的几何排列暗示
 * （避免 from==to 边被 EdgeView 跳过，零渲染层改动）。
 */
function placeFish(
  doc: DocData,
  wt: WT,
  bx: number,
  by: number,
  dir: 1 | -1,
  level: number,
  color: string,
  out: Map<string, LaidNode>,
  edges: LaidEdge[],
) {
  const n = doc.nodes[wt.id]
  out.set(wt.id, {
    id: wt.id, x: bx, y: by, w: wt.w, h: wt.h,
    side: dir > 0 ? 1 : -1, level, color, collapsed: !!n?.collapsed,
    hasChildren: (n?.children.length ?? 0) > 0,
    hidden: wt.hidden, fontSize: wt.fs, imgH: wt.imgH,
  })
  if (!wt.kids.length) return
  let curX = bx + wt.w
  const parentMidY = by + wt.h / 2
  for (const c of wt.kids) {
    const nx = curX + FISH_STEP
    const childMidY = by + c.h / 2
    const midX = (curX + nx) / 2
    edges.push({
      from: wt.id, to: c.id,
      points: [curX, parentMidY, midX, parentMidY, midX, childMidY, nx, childMidY],
      color: '', level: level + 1,
    })
    placeFish(doc, c, nx, by, dir, level + 1, color, out, edges)
    curX = nx + c.w
  }
}

function layoutFishbone(doc: DocData, rootWt: WT, out: Map<string, LaidNode>, edges: LaidEdge[]) {
  const kids = rootWt.kids
  const colorOf = new Map<string, string>()
  kids.forEach((k, i) => colorOf.set(k.id, 'b' + (i % 6)))
  const SPINE_Y = rootWt.h / 2
  // 根（鱼头）在最左
  out.set(doc.rootId, {
    id: doc.rootId, x: 0, y: 0, w: rootWt.w, h: rootWt.h,
    side: 1, level: 0, color: '', collapsed: false,
    hasChildren: (doc.nodes[doc.rootId]?.children.length ?? 0) > 0,
    hidden: rootWt.hidden, fontSize: rootWt.fs, imgH: rootWt.imgH,
  })
  // 一级分支：上下交替（dir=-1 上 / +1 下），向右展开
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]
    const dir: 1 | -1 = i % 2 === 0 ? -1 : 1
    const branchX = rootWt.w + GX + i * FISH_LEVEL1_GAP
    const branchY = SPINE_Y + dir * (rootWt.h / 2 + GY)
    const color = colorOf.get(k.id) ?? ''
    // root 脊线点 → 分支节点（斜线贝塞尔）
    const spineX = rootWt.w + i * FISH_LEVEL1_GAP
    edges.push({
      from: doc.rootId, to: k.id,
      points: [
        spineX, SPINE_Y,
        spineX + FISH_LEVEL1_GAP / 2, SPINE_Y,
        spineX + FISH_LEVEL1_GAP / 2, branchY + k.h / 2,
        branchX, branchY + k.h / 2,
      ],
      color, level: 1,
    })
    placeFish(doc, k, branchX, branchY, dir, 1, color, out, edges)
  }
}

/* =============== M7-P4 timeline（时间轴） =============== */

/**
 * timeline：水平主轴，节点按 task.start 排序（无则按 DFS 序兜底），上下交错。
 * 同日期的多个节点垂直堆叠；保留真实 parent→child 边（两遍：先落位再连边）。
 */
function layoutTimeline(doc: DocData, rootWt: WT, out: Map<string, LaidNode>, edges: LaidEdge[]) {
  const AXIS_Y = 0
  const rootX = 0
  const rootY = AXIS_Y - rootWt.h / 2
  out.set(doc.rootId, {
    id: doc.rootId, x: rootX, y: rootY, w: rootWt.w, h: rootWt.h,
    side: 1, level: 0, color: '', collapsed: false,
    hasChildren: (doc.nodes[doc.rootId]?.children.length ?? 0) > 0,
    hidden: rootWt.hidden, fontSize: rootWt.fs, imgH: rootWt.imgH,
  })

  // 先序 DFS 收集所有可见非根节点（带 parentId 与 dfsIdx）
  const flat: { wt: WT; parentId: string; dfsIdx: number }[] = []
  let dfsIdx = 0
  const collect = (wt: WT, parentId: string) => {
    for (const c of wt.kids) {
      flat.push({ wt: c, parentId, dfsIdx: dfsIdx++ })
      collect(c, c.id)
    }
  }
  collect(rootWt, doc.rootId)

  // 排序 key：有 task.start 按日期；无则用负序号兜底（保持 DFS 序，排在最前）
  const BIG = 1e15
  const keyOf = (item: { wt: WT; dfsIdx: number }) => {
    const n = doc.nodes[item.wt.id]
    if (n?.task?.start) {
      const t = Date.parse(n.task.start)
      if (!isNaN(t)) return t
    }
    return -(BIG - item.dfsIdx)
  }
  flat.sort((a, b) => keyOf(a) - keyOf(b))

  // 第一遍：落位
  const stack = new Map<string, number>()
  const baseX = rootWt.w + GX
  for (let i = 0; i < flat.length; i++) {
    const { wt } = flat[i]
    const n = doc.nodes[wt.id]
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1
    const dateKey = n?.task?.start ?? '__dfs__' + flat[i].dfsIdx
    const stackCount = stack.get(dateKey) ?? 0
    stack.set(dateKey, stackCount + 1)
    const x = baseX + i * TIMELINE_COL_GAP
    const y = AXIS_Y + side * (TIMELINE_ROW_H * (stackCount + 1)) - wt.h / 2
    out.set(wt.id, {
      id: wt.id, x, y, w: wt.w, h: wt.h,
      side, level: 1, color: '', collapsed: !!n?.collapsed,
      hasChildren: (n?.children.length ?? 0) > 0,
      hidden: wt.hidden, fontSize: wt.fs, imgH: wt.imgH,
    })
  }

  // 第二遍：push edges（此时所有 parent 都已落位）
  for (const { wt, parentId } of flat) {
    const p = out.get(parentId)
    const c = out.get(wt.id)
    if (!p || !c) continue
    const parentMidY = p.y + p.h / 2
    const childMidY = c.y + c.h / 2
    const midX = (p.x + p.w + c.x) / 2
    edges.push({
      from: parentId, to: wt.id,
      points: [p.x + p.w, parentMidY, midX, parentMidY, midX, childMidY, c.x, childMidY],
      color: '', level: 1,
    })
  }
}

/* =============== 入口：策略分发 =============== */

export function computeLayout(doc: DocData): LayoutResult {
  const out = new Map<string, LaidNode>()
  const edges: LaidEdge[] = []
  const rootWt = build(doc, doc.rootId, 0)
  if (!rootWt) return { nodes: out, edges, bounds: { x: 0, y: 0, w: 100, h: 60 } }

  switch (doc.layout) {
    case 'tree':
      layoutTree(doc, rootWt, out, edges)
      break
    case 'org':
      layoutOrg(doc, rootWt, out, edges)
      break
    case 'fishbone':
      layoutFishbone(doc, rootWt, out, edges)
      break
    case 'timeline':
      layoutTimeline(doc, rootWt, out, edges)
      break
    default:
      layoutLogic(doc, rootWt, out, edges)
      break
  }

  return { nodes: out, edges, bounds: boundsOf(out) }
}
