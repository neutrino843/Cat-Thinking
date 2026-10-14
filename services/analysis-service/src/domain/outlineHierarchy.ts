import {
  validateMindMapGraph,
  validateOutlineGraph,
  type MindMapArtifactV1,
  type OutlineArtifactV1,
  type OutlineNodeV1,
} from '@cat-thinking/analysis-contracts'

export const MINDMAP_OUTLINE_HIERARCHY_VERSION = 'mindmap-outline-hierarchy-v2'
export const OUTLINE_KNOWLEDGE_HIERARCHY_VERSION = 'outline-grounded-hierarchy-v2'

export interface OutlineHierarchyEntry {
  readonly node: OutlineNodeV1
  readonly parentId: string | null
  readonly depth: number
}

export const collectOutlineHierarchy = (outline: OutlineArtifactV1): OutlineHierarchyEntry[] => {
  const entries: OutlineHierarchyEntry[] = []
  const stack = [...outline.nodes].reverse().map((node) => ({ node, parentId: null as string | null, depth: 1 }))
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) break
    entries.push(entry)
    for (const node of [...entry.node.children].reverse()) {
      stack.push({ node, parentId: entry.node.id, depth: entry.depth + 1 })
    }
  }
  return entries
}

/** IDs carry identity; a matching or similar title does not prove that two concepts are the same. */
const matchOutlineNodes = (
  entries: readonly OutlineHierarchyEntry[],
  artifact: MindMapArtifactV1,
): Map<string, string> => {
  const candidates = artifact.nodes.filter((node) => node.parentId !== null)
  const byId = new Set(candidates.map((node) => node.id))
  const matched = new Map<string, string>()
  for (const { node } of entries) if (byId.has(node.id)) {
    matched.set(node.id, node.id)
  }
  return matched
}

/** Reparent only an already valid graph with a complete, unambiguous Outline mapping.
 * All model nodes, notes, evidence, citations and cross relations remain available for validation.
 * This cannot make an invalid citation or an unknown relation endpoint disappear.
 */
export const inheritOutlineHierarchy = (
  artifact: MindMapArtifactV1,
  outline: OutlineArtifactV1,
): MindMapArtifactV1 => {
  if (validateMindMapGraph(artifact).length > 0 || validateOutlineGraph(outline).length > 0) return artifact
  const entries = collectOutlineHierarchy(outline)
  const matched = matchOutlineNodes(entries, artifact)
  if (matched.size !== entries.length) return artifact
  const root = artifact.nodes.find((node) => node.parentId === null)
  if (!root) return artifact
  const parents = new Map<string, string>()
  for (const { node, parentId } of entries) {
    const mapNodeId = matched.get(node.id)
    const mapParentId = parentId === null ? root.id : matched.get(parentId)
    if (mapNodeId === undefined || mapParentId === undefined) return artifact
    parents.set(mapNodeId, mapParentId)
  }
  return { ...artifact, nodes: artifact.nodes.map((node) => {
    const parentId = parents.get(node.id)
    return parentId === undefined ? node : { ...node, parentId }
  }) }
}

export interface OutlineHierarchyIssue { readonly path: string; readonly message: string }

/** Preserve every completed Outline concept and its parent, even for short material.
 * Shallow source-supported outlines remain valid; no synthetic minimum depth is imposed.
 */
export const validateMindMapOutlineHierarchy = (
  artifact: MindMapArtifactV1,
  outline: OutlineArtifactV1,
): OutlineHierarchyIssue[] => {
  const entries = collectOutlineHierarchy(outline)
  const matched = matchOutlineNodes(entries, artifact)
  const root = artifact.nodes.find((node) => node.parentId === null)
  const byId = new Map(artifact.nodes.map((node) => [node.id, node]))
  const issues: OutlineHierarchyIssue[] = []
  for (const { node, parentId } of entries) {
    const mapNodeId = matched.get(node.id)
    if (mapNodeId === undefined) {
      issues.push({ path: 'payload.nodes', message: `mind map is missing Outline node ${node.id}; preserve its exact ID` })
      continue
    }
    const expectedParent = parentId === null ? root?.id : matched.get(parentId)
    if (expectedParent === undefined || byId.get(mapNodeId)?.parentId !== expectedParent) {
      issues.push({ path: `payload.nodes.${mapNodeId}.parentId`, message: `mind map must preserve the completed Outline parent for ${node.id}` })
    }
    if (byId.get(mapNodeId)?.text !== node.title) {
      issues.push({ path: `payload.nodes.${mapNodeId}.text`, message: `mind map must preserve the completed Outline title for ${node.id}` })
    }
  }
  return issues
}
