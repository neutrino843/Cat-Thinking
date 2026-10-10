import { createHash } from 'node:crypto'
import {
  ANALYSIS_LIMITS,
  artifactDescriptorSchema,
  artifactEnvelopeSchema,
  canonicalizeJson,
  collectArtifactCitations,
  validateArtifactAgainstManifest,
  type AnalysisRunV1,
  type ArtifactDescriptorV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type CitationV1,
  type EvidenceGraphV1,
  type OutlineArtifactV1,
} from '@cat-thinking/analysis-contracts'

export interface ArtifactValidationIssue {
  readonly code:
    | 'identity_invalid'
    | 'kind_not_requested'
    | 'evidence_missing'
    | 'citation_unverified'
    | 'provenance_unsupported'
    | 'dependency_missing'
    | 'question_count_invalid'
    | 'artifact_too_large'
    | 'contract_invalid'
  readonly path: string
  readonly message: string
}

export class ArtifactValidationError extends Error {
  constructor(readonly issues: readonly ArtifactValidationIssue[]) {
    super(`artifact validation failed with ${issues.length} issue(s)`)
    this.name = 'ArtifactValidationError'
  }
}

interface GroundedEntry {
  readonly path: string
  readonly evidenceIds: readonly string[]
  readonly citations: readonly CitationV1[]
}

const collectOutlineEntries = (
  nodes: OutlineArtifactV1['nodes'],
  prefix = 'payload.nodes',
): GroundedEntry[] => nodes.flatMap((node, index) => {
  const path = `${prefix}.${index}`
  return [
    { path, evidenceIds: node.evidenceIds, citations: node.citations },
    ...collectOutlineEntries(node.children, `${path}.children`),
  ]
})

const collectGroundedEntries = (artifact: ArtifactEnvelopeV1): GroundedEntry[] => {
  switch (artifact.kind) {
    case 'summary':
      return [
        { path: 'payload.overview', ...artifact.payload.overview },
        ...artifact.payload.keyPoints.map((item, index) => ({ path: `payload.keyPoints.${index}`, ...item })),
        ...artifact.payload.confusions.map((item, index) => ({ path: `payload.confusions.${index}`, ...item })),
        ...(artifact.payload.conclusion
          ? [{ path: 'payload.conclusion', ...artifact.payload.conclusion }]
          : []),
      ]
    case 'outline':
      return collectOutlineEntries(artifact.payload.nodes)
    case 'mindmap':
      return [
        ...artifact.payload.nodes.map((node, index) => ({ path: `payload.nodes.${index}`, ...node })),
        ...artifact.payload.relations.map((relation, index) => ({
          path: `payload.relations.${index}`,
          ...relation,
        })),
      ]
    case 'quiz':
      return artifact.payload.questions.map((question, index) => ({
        path: `payload.questions.${index}`,
        ...question,
      }))
    case 'knowledge':
      return artifact.payload.items.map((item, index) => ({ path: `payload.items.${index}`, ...item }))
  }
}

const sameHashes = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const citationKey = (citation: CitationV1): string => canonicalizeJson(citation)

const buildEvidenceCitations = (graph: EvidenceGraphV1): ReadonlyMap<string, ReadonlySet<string>> => {
  const citations = new Map<string, ReadonlySet<string>>()
  for (const claim of graph.claims) citations.set(claim.id, new Set(claim.citations.map(citationKey)))
  for (const term of graph.terms) citations.set(term.id, new Set(term.citations.map(citationKey)))
  for (const objective of graph.learningObjectives) {
    const inherited = new Set<string>()
    for (const evidenceId of objective.evidenceIds) {
      for (const citation of citations.get(evidenceId) ?? []) inherited.add(citation)
    }
    citations.set(objective.id, inherited)
  }
  return citations
}

export interface ValidateArtifactInput {
  readonly artifact: unknown
  readonly expectedKind: ArtifactKind
  readonly run: AnalysisRunV1
  readonly graph: EvidenceGraphV1
  readonly outline?: OutlineArtifactV1
  readonly maxArtifactBytes?: number
}

export const validateGeneratedArtifact = (input: ValidateArtifactInput): ArtifactEnvelopeV1 => {
  const decoded = artifactEnvelopeSchema.safeParse(input.artifact)
  if (!decoded.success) {
    throw new ArtifactValidationError(decoded.error.issues.map((issue) => ({
      code: 'contract_invalid',
      path: issue.path.join('.'),
      message: issue.message,
    })))
  }
  const artifact = decoded.data
  const issues: ArtifactValidationIssue[] = []
  if (artifact.kind !== input.expectedKind) {
    issues.push({ code: 'identity_invalid', path: 'kind', message: 'artifact kind differs from the scheduled node' })
  }
  if (
    artifact.runId !== input.run.id
    || artifact.docId !== input.run.docId
    || !sameHashes(artifact.sourceContentHashes, input.graph.sourceContentHashes)
  ) {
    issues.push({ code: 'identity_invalid', path: '', message: 'artifact identity differs from run evidence' })
  }
  if (!input.run.request.artifacts.includes(artifact.kind)) {
    issues.push({ code: 'kind_not_requested', path: 'kind', message: 'artifact kind was not requested' })
  }
  if (artifact.kind === 'mindmap' && input.outline === undefined) {
    issues.push({ code: 'dependency_missing', path: 'kind', message: 'mind map requires a completed outline' })
  }
  if (artifact.kind === 'quiz' && artifact.payload.questions.length !== input.run.request.options.quizQuestionCount) {
    issues.push({
      code: 'question_count_invalid',
      path: 'payload.questions',
      message: 'quiz question count differs from the request',
    })
  }
  for (const issue of validateArtifactAgainstManifest(artifact, input.run.request.manifest)) {
    issues.push({ code: 'contract_invalid', path: issue.path, message: issue.message })
  }

  const evidenceCitations = buildEvidenceCitations(input.graph)
  for (const entry of collectGroundedEntries(artifact)) {
    const allowed = new Set<string>()
    for (const evidenceId of entry.evidenceIds) {
      const citations = evidenceCitations.get(evidenceId)
      if (!citations) {
        issues.push({
          code: 'evidence_missing',
          path: `${entry.path}.evidenceIds`,
          message: `evidence ${evidenceId} is not in the current graph`,
        })
        continue
      }
      for (const citation of citations) allowed.add(citation)
    }
    for (const citation of entry.citations) {
      if (citation.provenance === 'external') {
        issues.push({
          code: 'provenance_unsupported',
          path: `${entry.path}.citations`,
          message: 'external citations require the retrieval stage',
        })
        continue
      }
      if (citation.provenance === 'inference') {
        if (artifact.kind !== 'knowledge') {
          issues.push({
            code: 'provenance_unsupported',
            path: `${entry.path}.citations`,
            message: 'inference citations are only supported for knowledge expansion',
          })
        }
        continue
      }
      const key = citationKey(citation)
      if (!allowed.has(key)) {
        issues.push({
          code: 'citation_unverified',
          path: `${entry.path}.citations`,
          message: 'source citation is not backed by the referenced evidence',
        })
      }
    }
  }

  const serialized = canonicalizeJson(artifact)
  const byteCount = Buffer.byteLength(serialized, 'utf8')
  const maxArtifactBytes = Math.min(input.maxArtifactBytes ?? ANALYSIS_LIMITS.maxArtifactBytes, ANALYSIS_LIMITS.maxArtifactBytes)
  if (byteCount > maxArtifactBytes) {
    issues.push({
      code: 'artifact_too_large',
      path: '',
      message: `artifact exceeds ${maxArtifactBytes} UTF-8 bytes`,
    })
  }
  if (issues.length > 0) throw new ArtifactValidationError(issues)
  return artifact
}

export const createArtifactDescriptor = (artifact: ArtifactEnvelopeV1): ArtifactDescriptorV1 => {
  const serialized = canonicalizeJson(artifact)
  return artifactDescriptorSchema.parse({
    version: artifact.version,
    schemaVersion: artifact.schemaVersion,
    id: artifact.id,
    runId: artifact.runId,
    kind: artifact.kind,
    artifactHash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    byteCount: Buffer.byteLength(serialized, 'utf8'),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  })
}

export const validateArtifactDescriptor = (
  artifact: ArtifactEnvelopeV1,
  descriptor: ArtifactDescriptorV1,
): void => {
  const expected = createArtifactDescriptor(artifact)
  if (canonicalizeJson(expected) !== canonicalizeJson(descriptor)) {
    throw new ArtifactValidationError([{
      code: 'identity_invalid',
      path: 'descriptor',
      message: 'artifact descriptor does not match its payload',
    }])
  }
}

export const collectGeneratedArtifactCitations = collectArtifactCitations
