import type { AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { ARTIFACT_KINDS } from '@cat-thinking/analysis-contracts'
import { artifactPromptVersion, REPAIR_PROMPT_VERSION } from './artifactPrompts.js'
import { ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION, ARTIFACT_SOURCE_REFERENCE_VERSIONS } from '../domain/artifactPolicyVersions.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, EVIDENCE_MAP_PROMPT_VERSION,
  EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION } from './evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION } from './evidenceRepairPrompt.js'

export type ArtifactProtocol = 'legacy' | 'source-reference'
const legacyArtifactVersions = new Set(ARTIFACT_KINDS.map(artifactPromptVersion))
const referenceArtifactVersions = new Set<string>(Object.values(ARTIFACT_SOURCE_REFERENCE_VERSIONS))
const legacyEvidenceVersions = new Set([EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION])
const evidenceRepairVersions = new Set([EVIDENCE_REPAIR_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION])

/** Persisted prompt versions, not current configuration or model output, choose the protocol. */
export function persistedArtifactProtocol(run: AnalysisRunV1, forUnstarted: ArtifactProtocol = 'source-reference'): ArtifactProtocol | undefined {
  const families = new Set<ArtifactProtocol>()
  const hasEvidenceMain = run.providerRoutes.some(({ promptVersion }) => legacyEvidenceVersions.has(promptVersion)
    || promptVersion === EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)
  if (run.providerRoutes.length > 0 && !hasEvidenceMain) return undefined
  for (const route of run.providerRoutes) {
    const version = route.promptVersion
    if (legacyEvidenceVersions.has(version) || legacyArtifactVersions.has(version) || version === REPAIR_PROMPT_VERSION) families.add('legacy')
    else if (version === EVIDENCE_ARTIFACT_REF_PROMPT_VERSION || referenceArtifactVersions.has(version) || version === ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION) families.add('source-reference')
    else if (!evidenceRepairVersions.has(version)) return undefined
  }
  if (families.size > 1) return undefined
  // An orphan Evidence repair cannot establish which extraction/pipeline version was used.
  if (families.size === 0) return run.providerRoutes.length === 0 ? forUnstarted : undefined
  return [...families][0]
}
