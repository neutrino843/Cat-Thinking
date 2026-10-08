/**
 * M11（PRD 4.1.7 P1）：节点过滤——按标签 / 任务状态 / 里程碑过滤，「仅显示命中分支」。
 * 纯函数层：
 * - nodeMatches 判断单节点是否命中过滤条件（多条件为 AND）；
 * - computeFilter 求「应显示集合」（命中节点 + 其全部祖先链，根始终保留）
 *   与「需临时展开集合」（命中路径上原本折叠的节点，仅视图层展开，不改文档）；
 * - applyFilter 产出裁剪派生文档供布局使用，绝不可写回 store。
 */
import type { DocData, MindNodeData } from '../types'

/**
 * 任务状态过滤维度。
 * ''      不过滤
 * todo    未开始：无任务信息或进度为 0
 * doing   进行中：0 < progress < 1
 * done    已完成：progress ≥ 1
 * milestone 里程碑：task.milestone === true
 */
export type StatusFilter = '' | 'todo' | 'doing' | 'done' | 'milestone'

export interface NodeFilter {
  /** 按标签文本精确匹配；'' 表示不限 */
  tag: string
  status: StatusFilter
}

export const emptyFilter: NodeFilter = { tag: '', status: '' }

export function isFilterActive(f: NodeFilter): boolean {
  return !!(f.tag || f.status)
}

/** 单节点状态判定（供过滤与 UI 标记复用） */
export function nodeStatus(n: MindNodeData): Exclude<StatusFilter, ''> {
  const t = n.task
  if (t?.milestone) return 'milestone'
  const p = t?.progress ?? 0
  if (p >= 1) return 'done'
  if (p > 0) return 'doing'
  return 'todo'
}

export function nodeMatches(n: MindNodeData, f: NodeFilter): boolean {
  if (f.tag && !(n.tags ?? []).some((t) => t.text === f.tag)) return false
  if (f.status && nodeStatus(n) !== f.status) return false
  return true
}

export interface FilterResult {
  /** 应显示的节点 id（命中节点 + 祖先链，始终含根） */
  shown: Set<string>
  /** 命中路径上需要在视图层临时展开的折叠节点 id */
  expand: Set<string>
}

export function computeFilter(doc: DocData, f: NodeFilter): FilterResult {
  const shown = new Set<string>()
  const expand = new Set<string>()
  const rootId = doc.rootId
  shown.add(rootId)
  if (!isFilterActive(f)) return { shown, expand }

  for (const n of Object.values(doc.nodes)) {
    if (!nodeMatches(n, f)) continue
    let cur: MindNodeData | undefined = n
    while (cur) {
      shown.add(cur.id)
      if (cur.collapsed && cur.id !== rootId) expand.add(cur.id)
      cur = cur.parent ? doc.nodes[cur.parent] : undefined
    }
  }
  return { shown, expand }
}

/**
 * 应用过滤得到派生文档（布局/渲染只读使用）。
 * 未激活时返回 null（调用方直接使用原文档）；
 * 关系线/概要/边界框同步裁剪到可见成员，悬挂引用自然消除。
 */
export function applyFilter(doc: DocData, f: NodeFilter): DocData | null {
  if (!isFilterActive(f)) return null
  const { shown, expand } = computeFilter(doc, f)

  const nodes: Record<string, MindNodeData> = {}
  for (const id of shown) {
    const n = doc.nodes[id]
    if (!n) continue
    nodes[id] = {
      ...n,
      children: n.children.filter((c) => shown.has(c)),
      ...(expand.has(id) ? { collapsed: false } : {}),
    }
  }

  return {
    ...doc,
    nodes,
    relations: doc.relations?.filter((r) => shown.has(r.from) && shown.has(r.to)),
    summaries: doc.summaries
      ?.map((s) => ({ ...s, members: s.members.filter((m) => shown.has(m)) }))
      .filter((s) => s.members.length > 0),
    boundaryBoxes: doc.boundaryBoxes
      ?.map((b) => ({ ...b, members: b.members.filter((m) => shown.has(m)) }))
      .filter((b) => b.members.length > 0),
  }
}

/** 收集文档中出现过的全部标签文本（去重、保持首次出现顺序），供过滤下拉使用 */
export function collectTagTexts(doc: DocData): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of Object.values(doc.nodes)) {
    for (const t of n.tags ?? []) {
      if (!seen.has(t.text)) {
        seen.add(t.text)
        out.push(t.text)
      }
    }
  }
  return out
}
