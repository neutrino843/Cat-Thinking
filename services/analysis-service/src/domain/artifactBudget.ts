import {
  ANALYSIS_LIMITS,
  type AnalysisOptionsV1,
  type ArtifactKind,
} from '@cat-thinking/analysis-contracts'

export interface ArtifactBudget {
  readonly maxOutputTokens: number
  readonly maxArtifactBytes: number
}

export class ArtifactBudgetExceededError extends Error {
  constructor(
    readonly actualOutputTokens: number,
    readonly maximumOutputTokens: number,
  ) {
    super(`artifact output token budget exceeded: ${actualOutputTokens} > ${maximumOutputTokens}`)
    this.name = 'ArtifactBudgetExceededError'
  }
}

const fixedTokenBudgets: Readonly<Record<AnalysisOptionsV1['qualityProfile'], Readonly<Record<
  Exclude<ArtifactKind, 'quiz'>,
  number
>>>> = {
  economy: { summary: 600, outline: 900, mindmap: 1_200, knowledge: 700 },
  standard: { summary: 1_200, outline: 1_800, mindmap: 2_400, knowledge: 1_400 },
  'high-quality': { summary: 2_400, outline: 3_200, mindmap: 4_500, knowledge: 2_600 },
}

const byteBudgets: Readonly<Record<AnalysisOptionsV1['qualityProfile'], number>> = {
  economy: 256_000,
  standard: 750_000,
  'high-quality': ANALYSIS_LIMITS.maxArtifactBytes,
}

const quizTokensPerQuestion: Readonly<Record<AnalysisOptionsV1['qualityProfile'], number>> = {
  economy: 120,
  standard: 180,
  'high-quality': 260,
}

export const planArtifactBudget = (
  kind: ArtifactKind,
  options: AnalysisOptionsV1,
): ArtifactBudget => ({
  maxOutputTokens: kind === 'quiz'
    ? Math.max(500, options.quizQuestionCount * quizTokensPerQuestion[options.qualityProfile])
    : fixedTokenBudgets[options.qualityProfile][kind],
  maxArtifactBytes: byteBudgets[options.qualityProfile],
})
