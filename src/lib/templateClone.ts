import type { DocData, MindNodeData } from '../types'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * 从模板文档克隆出一篇全新文档（M5 自定义模板 / 模板复用）：
 * - 文档 id 与全部节点 id 重新生成；
 * - parent / children / task.deps[].from 同步重映射，依赖不悬空；
 * - 折叠状态重置为展开；createdAt/updatedAt 刷新。
 * 输入文档不被修改。
 */
export function cloneFromTemplate(src: DocData): DocData {
  const idMap = new Map<string, string>()
  for (const oldId of Object.keys(src.nodes)) idMap.set(oldId, uid())

  const nodes: Record<string, MindNodeData> = {}
  for (const [oldId, n] of Object.entries(src.nodes)) {
    const id = idMap.get(oldId)!
    nodes[id] = {
      ...n,
      id,
      parent: n.parent ? (idMap.get(n.parent) ?? null) : null,
      children: n.children.map((c) => idMap.get(c)).filter((x): x is string => !!x),
      collapsed: false,
      ...(n.task
        ? {
            task: {
              ...n.task,
              deps: n.task.deps
                ?.map((d) => (idMap.has(d.from) ? { from: idMap.get(d.from)!, type: d.type } : null))
                .filter((d): d is { from: string; type: 'FS' | 'SS' | 'FF' | 'SF' } => !!d),
            },
          }
        : {}),
    }
  }

  const now = Date.now()
  return {
    ...src,
    id: uid(),
    rootId: idMap.get(src.rootId) ?? src.rootId,
    nodes,
    createdAt: now,
    updatedAt: now,
  }
}
