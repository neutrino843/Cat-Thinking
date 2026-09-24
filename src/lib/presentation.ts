import type { DocData, MindNodeData } from '../types'

/**
 * 演示模式纯逻辑（M5）。
 * 幻灯片规则：第 0 页只有根节点；之后按先序 DFS 每深入一个节点为一页，
 * 已揭示节点保持可见（父先于子出现，分支逐级展开）。
 */
export interface Slide {
  index: number
  total: number
  focusId: string
  /** 截止本页已揭示节点（先序） */
  visible: string[]
}

/** 先序遍历节点 id；演示忽略文档中的 collapsed 状态 */
function preorder(doc: DocData): string[] {
  const order: string[] = []
  // 修 L-4：seen 防环。校验过的文档必无环，但导入/历史脏数据若 children 成环，
  // 递归会直接爆栈（buildSlides 在渲染期调用），此处防御性终止。
  const seen = new Set<string>()
  const walk = (id: string) => {
    const n = doc.nodes[id]
    if (!n || seen.has(id)) return
    seen.add(id)
    order.push(id)
    for (const c of n.children) walk(c)
  }
  walk(doc.rootId)
  return order
}

export function buildSlides(doc: DocData): Slide[] {
  const order = preorder(doc)
  return order.map((id, i) => ({
    index: i,
    total: order.length,
    focusId: id,
    visible: order.slice(0, i + 1),
  }))
}

/**
 * 派生演示用文档：克隆并裁剪到本页可见节点，折叠全部展开。
 * 不修改输入文档（节点对象仅浅拷贝可见集合内的项）。
 */
export function presentDoc(doc: DocData, slideIndex: number): DocData {
  const slides = buildSlides(doc)
  const i = Math.max(0, Math.min(slideIndex, slides.length - 1))
  const slide = slides[i]
  if (!slide) return { ...doc, nodes: {} }
  const vis = new Set(slide.visible)
  const nodes: Record<string, MindNodeData> = {}
  for (const id of slide.visible) {
    const n = doc.nodes[id]
    if (!n) continue
    nodes[id] = { ...n, children: n.children.filter((c) => vis.has(c)), collapsed: false }
  }
  return { ...doc, nodes }
}
