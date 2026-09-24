import type { DocData, MindNodeData } from '../types'

let seq = 0
const nid = (p?: string) => `n${seq++}`

export interface TreeDef {
  text?: string
  note?: string
  href?: string
  task?: MindNodeData['task']
  collapsed?: boolean
  children?: TreeDef[]
}

/** 用嵌套结构快速构造测试文档 */
export function buildFixture(rootDef: TreeDef = {}, layout: DocData['layout'] = 'logic'): DocData {
  seq = 0
  const nodes: Record<string, MindNodeData> = {}
  const mk = (def: TreeDef, parent: string | null): string => {
    const id = nid()
    nodes[id] = {
      id,
      parent,
      children: [],
      text: def.text ?? id,
      ...(def.note ? { note: def.note } : {}),
      ...(def.href ? { href: def.href } : {}),
      ...(def.task ? { task: JSON.parse(JSON.stringify(def.task)) } : {}),
      ...(def.collapsed ? { collapsed: true } : {}),
    }
    for (const c of def.children ?? []) {
      nodes[id].children.push(mk(c, id))
    }
    return id
  }
  const rootId = mk(rootDef, null)
  const now = 1758400000000
  return { version: 1, id: 'doc-test', title: '测试文档', rootId, layout, nodes, createdAt: now, updatedAt: now }
}

/** 常用结构：root → a → a1；root → b */
export function simpleFixture(layout: DocData['layout'] = 'logic'): DocData {
  return buildFixture(
    {
      text: 'root',
      children: [
        { text: 'a', children: [{ text: 'a1' }] },
        { text: 'b' },
      ],
    },
    layout,
  )
}
