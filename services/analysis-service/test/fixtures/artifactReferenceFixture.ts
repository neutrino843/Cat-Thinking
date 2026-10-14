import type { ArtifactKind, CitationV1, OutlineArtifactV1, OutlineNodeV1 } from '@cat-thinking/analysis-contracts'
import type { ModelRequest } from '../../src/providers/modelProvider.js'

/** Test-only wire types. The fake copies IDs supplied by a prompt, never reconstructs production citations. */
export type FixtureCitation = CitationV1 | { refId: string } | { provenance: 'inference'; label?: string }
export type FixtureOutlineNode = Omit<OutlineNodeV1, 'citations' | 'children'> & {
  citations: FixtureCitation[]
  children: FixtureOutlineNode[]
}
export type FixtureOutline = Omit<OutlineArtifactV1, 'nodes'> & { nodes: FixtureOutlineNode[] }

export const usesArtifactReferenceDraft = (request: Pick<ModelRequest, 'output'>, kind: ArtifactKind) =>
  request.output.name === `artifact_${kind}_source_refs_v1`

export function encodeFixtureArtifactOutput(request: Pick<ModelRequest, 'output'>, kind: ArtifactKind, payload: unknown): string {
  return JSON.stringify(usesArtifactReferenceDraft(request, kind)
    ? { draftVersion: 'artifact-source-refs-v1', payload }
    : payload)
}

export function fixtureInferenceCitation(request: Pick<ModelRequest, 'output'>, kind: ArtifactKind, label: string): FixtureCitation {
  return usesArtifactReferenceDraft(request, kind)
    ? { provenance: 'inference', label }
    : { version: 1, provenance: 'inference', label }
}
