import type {
  AnalysisOptionsV1,
  ArtifactEnvelopeV1,
  ArtifactKind,
  EvidenceGraphV1,
  OutlineArtifactV1,
  ProviderRouteV1,
  UsageV1,
  AnalysisRunV1,
} from '@cat-thinking/analysis-contracts'
import type { ArtifactBudget } from './artifactBudget.js'

export interface ArtifactGenerationInput {
  readonly tenantId: string
  readonly run: AnalysisRunV1
  readonly attempt: number
  readonly runId: string
  readonly docId: string
  readonly kind: ArtifactKind
  readonly options: AnalysisOptionsV1
  readonly budget: ArtifactBudget
  readonly graph: EvidenceGraphV1
  readonly outline?: OutlineArtifactV1
}

export interface ArtifactGenerationOutput {
  readonly artifact: ArtifactEnvelopeV1
  readonly route: ProviderRouteV1
  readonly usage: UsageV1
  /** Successful model responses included in usage: generation, optionally one repair. */
  readonly invocationCount?: 1 | 2
}

export interface ArtifactGenerator {
  generate(input: ArtifactGenerationInput, signal: AbortSignal): Promise<ArtifactGenerationOutput>
}
