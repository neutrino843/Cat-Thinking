import { ANALYSIS_LIMITS } from './constants'
import type { ArtifactEnvelopeV1, MindMapArtifactV1, OutlineArtifactV1, OutlineNodeV1 } from './artifacts'
import type { CitationV1 } from './citations'
import type { SourceManifestV1 } from './sources'

export interface ContractValidationIssue {
  code: 'source_missing' | 'range_invalid' | 'page_invalid' | 'graph_invalid' | 'limit_exceeded'
  path: string
  message: string
}

const collectOutlineCitations = (nodes: readonly OutlineNodeV1[]): CitationV1[] =>
  nodes.flatMap((node) => [...node.citations, ...collectOutlineCitations(node.children)])

export const collectArtifactCitations = (artifact: ArtifactEnvelopeV1): CitationV1[] => {
  switch (artifact.kind) {
    case 'summary':
      return [
        ...artifact.payload.overview.citations,
        ...artifact.payload.keyPoints.flatMap((item) => item.citations),
        ...artifact.payload.confusions.flatMap((item) => item.citations),
        ...(artifact.payload.conclusion?.citations ?? []),
      ]
    case 'outline':
      return collectOutlineCitations(artifact.payload.nodes)
    case 'mindmap':
      return [
        ...artifact.payload.nodes.flatMap((node) => node.citations),
        ...artifact.payload.relations.flatMap((relation) => relation.citations),
      ]
    case 'quiz':
      return artifact.payload.questions.flatMap((question) => question.citations)
    case 'knowledge':
      return artifact.payload.items.flatMap((item) => item.citations)
  }
}

export const validateMindMapGraph = (artifact: MindMapArtifactV1): ContractValidationIssue[] => {
  const issues: ContractValidationIssue[] = []
  const nodes = new Map(artifact.nodes.map((node) => [node.id, node]))
  const roots = artifact.nodes.filter((node) => node.parentId === null)

  if (roots.length !== 1) {
    issues.push({
      code: 'graph_invalid',
      path: 'payload.nodes',
      message: `mind map requires exactly one root; received ${roots.length}`,
    })
  }

  for (const node of artifact.nodes) {
    if (node.parentId !== null && !nodes.has(node.parentId)) {
      issues.push({
        code: 'graph_invalid',
        path: `payload.nodes.${node.id}.parentId`,
        message: `parent ${node.parentId} does not exist`,
      })
    }
  }

  for (const relation of artifact.relations) {
    if (!nodes.has(relation.from) || !nodes.has(relation.to)) {
      issues.push({
        code: 'graph_invalid',
        path: `payload.relations.${relation.id}`,
        message: 'relation endpoint does not exist',
      })
    }
  }

  for (const node of artifact.nodes) {
    const visited = new Set<string>()
    let current: typeof node | undefined = node
    let depth = 0
    while (current && current.parentId !== null) {
      if (visited.has(current.id)) {
        issues.push({
          code: 'graph_invalid',
          path: `payload.nodes.${node.id}`,
          message: 'parent cycle detected',
        })
        break
      }
      visited.add(current.id)
      current = nodes.get(current.parentId)
      depth += 1
      if (depth > 32) {
        issues.push({
          code: 'limit_exceeded',
          path: `payload.nodes.${node.id}`,
          message: 'mind map depth exceeds 32',
        })
        break
      }
      if (!current) break
    }
  }

  return issues
}

export const validateOutlineGraph = (artifact: OutlineArtifactV1): ContractValidationIssue[] => {
  const issues: ContractValidationIssue[] = []
  const ids = new Set<string>()
  const stack = artifact.nodes.map((node) => ({ node, depth: 1 }))
  let count = 0
  let depthReported = false
  let countReported = false

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) break
    count += 1
    if (ids.has(entry.node.id)) {
      issues.push({
        code: 'graph_invalid',
        path: `payload.nodes.${entry.node.id}`,
        message: 'outline node ids must be unique',
      })
    }
    ids.add(entry.node.id)

    if (!depthReported && entry.depth > 32) {
      issues.push({
        code: 'limit_exceeded',
        path: `payload.nodes.${entry.node.id}`,
        message: 'outline depth exceeds 32',
      })
      depthReported = true
    }
    if (!countReported && count > ANALYSIS_LIMITS.maxOutlineNodes) {
      issues.push({
        code: 'limit_exceeded',
        path: 'payload.nodes',
        message: `outline node count exceeds ${ANALYSIS_LIMITS.maxOutlineNodes}`,
      })
      countReported = true
    }

    for (const child of entry.node.children) {
      stack.push({ node: child, depth: entry.depth + 1 })
    }
  }

  return issues
}

export const validateArtifactAgainstManifest = (
  artifact: ArtifactEnvelopeV1,
  manifest: SourceManifestV1,
): ContractValidationIssue[] => {
  const issues: ContractValidationIssue[] = []
  const sources = new Map(manifest.sources.map((source) => [source.sourceId, source]))

  for (const [index, citation] of collectArtifactCitations(artifact).entries()) {
    if (citation.provenance !== 'source') continue
    const source = sources.get(citation.sourceId)
    if (!source) {
      issues.push({
        code: 'source_missing',
        path: `citations.${index}.sourceId`,
        message: `source ${citation.sourceId} is not in the run manifest`,
      })
      continue
    }
    const selectedStart = source.selectedRange?.start ?? 0
    const selectedEnd = source.selectedRange?.end ?? source.charCount
    if (citation.start < selectedStart || citation.end > selectedEnd) {
      issues.push({
        code: 'range_invalid',
        path: `citations.${index}`,
        message: 'citation lies outside the selected source range',
      })
    }
    if (citation.page !== undefined && (source.pageCount === undefined || citation.page > source.pageCount)) {
      issues.push({
        code: 'page_invalid',
        path: `citations.${index}.page`,
        message: 'citation page exceeds the source page count',
      })
    }
  }

  if (artifact.kind === 'mindmap') {
    issues.push(...validateMindMapGraph(artifact.payload))
  }
  if (artifact.kind === 'outline') {
    issues.push(...validateOutlineGraph(artifact.payload))
  }

  return issues
}
