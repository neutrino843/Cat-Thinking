import type { DocData } from '../types'

export function canMoveImportNode(doc: DocData, nodeId: string, parentId: string): boolean {
  if (nodeId === doc.rootId || !doc.nodes[nodeId] || !doc.nodes[parentId]) return false
  const visited = new Set<string>()
  let cursor: string | null = parentId
  while (cursor) {
    if (cursor === nodeId || visited.has(cursor)) return false
    visited.add(cursor); cursor = doc.nodes[cursor]?.parent ?? null
  }
  return true
}

/** Preview edits keep IDs and source ranges; they never touch the persisted map. */
export function moveImportNode(doc: DocData, nodeId: string, parentId: string): DocData {
  if (!canMoveImportNode(doc, nodeId, parentId)) return doc
  const node = doc.nodes[nodeId]
  if (!node.parent || node.parent === parentId) return doc
  const nodes = { ...doc.nodes,
    [node.parent]: { ...doc.nodes[node.parent], children: doc.nodes[node.parent].children.filter((id) => id !== nodeId) },
    [parentId]: { ...doc.nodes[parentId], children: [...doc.nodes[parentId].children, nodeId] },
    [nodeId]: { ...node, parent: parentId } }
  return { ...doc, nodes }
}
