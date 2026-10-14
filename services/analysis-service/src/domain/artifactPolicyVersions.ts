import type { ArtifactKind } from '@cat-thinking/analysis-contracts'
import { MINDMAP_OUTLINE_HIERARCHY_VERSION, OUTLINE_KNOWLEDGE_HIERARCHY_VERSION } from './outlineHierarchy.js'

export const ARTIFACT_REFERENCE_DRAFT_VERSION = 'artifact-source-refs-v1'
export const ARTIFACT_SOURCE_REFERENCE_VERSIONS = Object.freeze({
  summary: 'summary-grounded-refs-v2',
  outline: 'outline-grounded-hierarchy-refs-v3',
  mindmap: 'mindmap-outline-hierarchy-refs-v3',
  quiz: 'quiz-grounded-refs-v2',
  knowledge: 'knowledge-grounded-refs-v3',
} as const satisfies Record<ArtifactKind, string>)
export const ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION = 'artifact-ref-repair-v3'

export const isMindMapHierarchyPromptVersion = (version: string): boolean =>
  version === MINDMAP_OUTLINE_HIERARCHY_VERSION || version === ARTIFACT_SOURCE_REFERENCE_VERSIONS.mindmap
export const isOutlineGroundingPromptVersion = (version: string): boolean =>
  version === OUTLINE_KNOWLEDGE_HIERARCHY_VERSION || version === ARTIFACT_SOURCE_REFERENCE_VERSIONS.outline
export const isNodeGroundingPromptVersion = (version: string): boolean =>
  isMindMapHierarchyPromptVersion(version) || isOutlineGroundingPromptVersion(version)
