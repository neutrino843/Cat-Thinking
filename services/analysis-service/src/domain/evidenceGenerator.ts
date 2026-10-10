import type {
  AnalysisRunV1,
  EvidenceCardV1,
  EvidenceChunkV1,
} from '@cat-thinking/analysis-contracts'

export interface EvidenceGeneratorRoute {
  readonly providerId: string
  readonly modelId: string
  readonly profileVersion: string
  readonly promptVersion: string
}
export interface EvidenceMapInput {
  readonly runId: string
  readonly docId: string
  readonly locale: string
  readonly qualityProfile: AnalysisRunV1['request']['options']['qualityProfile']
  readonly chunk: EvidenceChunkV1
  readonly text: string
}

export interface EvidenceMapOutput {
  readonly card: EvidenceCardV1
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface EvidenceGenerator {
  readonly route: EvidenceGeneratorRoute
  map(input: EvidenceMapInput, signal: AbortSignal): Promise<EvidenceMapOutput>
}
