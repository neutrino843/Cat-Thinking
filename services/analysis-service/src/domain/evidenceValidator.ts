import {
  evidenceCardSchema,
  type EvidenceCardV1,
  type EvidenceChunkV1,
  type SourceCitationV1,
  type SourceSnapshotV1,
} from '@cat-thinking/analysis-contracts'

export interface EvidenceValidationIssue {
  readonly code:
    | 'identity_mismatch'
    | 'citation_range_invalid'
    | 'citation_page_invalid'
    | 'citation_quote_invalid'
    | 'reference_missing'
  readonly path: string
  readonly message: string
}
export class EvidenceValidationError extends Error {
  constructor(readonly issues: readonly EvidenceValidationIssue[]) {
    super(`evidence validation failed with ${issues.length} issue(s)`)
    this.name = 'EvidenceValidationError'
  }
}

const citationsOf = (card: EvidenceCardV1): readonly SourceCitationV1[] => [
  ...card.claims.flatMap((claim) => claim.citations),
  ...card.terms.flatMap((term) => term.citations),
]

export const inspectEvidenceCard = (input: {
  readonly card: EvidenceCardV1
  readonly chunk: EvidenceChunkV1
  readonly snapshot: SourceSnapshotV1
  readonly sourceText: string
}): EvidenceValidationIssue[] => {
  const card = evidenceCardSchema.parse(input.card)
  const { chunk, snapshot, sourceText } = input
  const issues: EvidenceValidationIssue[] = []
  if (
    card.chunkId !== chunk.chunkId
    || card.chunkHash !== chunk.chunkHash
    || card.sourceId !== chunk.sourceId
    || snapshot.sourceId !== chunk.sourceId
  ) {
    issues.push({ code: 'identity_mismatch', path: 'card', message: 'card identity differs from chunk/source' })
  }
  if (card.titlePath.join('\u0000') !== chunk.titlePath.join('\u0000')) {
    issues.push({ code: 'identity_mismatch', path: 'card.titlePath', message: 'card titlePath differs from chunk' })
  }
  for (const [index, citation] of citationsOf(card).entries()) {
    const path = `citations.${index}`
    if (
      citation.sourceId !== chunk.sourceId
      || citation.start < chunk.start
      || citation.end > chunk.end
      || citation.end > sourceText.length
    ) {
      issues.push({ code: 'citation_range_invalid', path, message: 'citation lies outside the current chunk' })
      continue
    }
    if (citation.quote !== undefined && sourceText.slice(citation.start, citation.end) !== citation.quote) {
      issues.push({ code: 'citation_quote_invalid', path: `${path}.quote`, message: 'citation quote differs from source' })
    }
    if (citation.page !== undefined) {
      const matchesPage = (snapshot.locators ?? []).some((locator) =>
        locator.page === citation.page
        && locator.start < citation.end
        && locator.end > citation.start,
      )
      if (!matchesPage) {
        issues.push({ code: 'citation_page_invalid', path: `${path}.page`, message: 'citation page lacks source mapping' })
      }
    }
  }
  const termIds = new Set(card.terms.map((term) => term.id))
  const evidenceIds = new Set([...card.claims, ...card.terms].map((item) => item.id))
  for (const [index, claim] of card.claims.entries()) {
    for (const conceptId of claim.conceptIds) {
      if (!termIds.has(conceptId)) {
        issues.push({
          code: 'reference_missing',
          path: `claims.${index}.conceptIds`,
          message: `claim references unknown concept ${conceptId}`,
        })
      }
    }
  }
  for (const [index, objective] of card.learningObjectives.entries()) {
    for (const evidenceId of objective.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push({
          code: 'reference_missing',
          path: `learningObjectives.${index}.evidenceIds`,
          message: `objective references unknown evidence ${evidenceId}`,
        })
      }
    }
  }
  return issues
}

export const validateEvidenceCard = (input: Parameters<typeof inspectEvidenceCard>[0]): EvidenceCardV1 => {
  const card = evidenceCardSchema.parse(input.card)
  const issues = inspectEvidenceCard({ ...input, card })
  if (issues.length > 0) throw new EvidenceValidationError(issues)
  return card
}
