import {
  ANALYSIS_LIMITS,
  type AnalysisOptionsV1,
  type ArtifactKind,
} from '@cat-thinking/analysis-contracts'

export interface ArtifactBudget {
  readonly maxOutputTokens: number
  readonly maxArtifactBytes: number
}

/**
 * 同一份产物最多允许的模型调用次数：首次生成 + 一次结构修复。
 * 预算按「每次调用」计量，因此一次产物的合法累计输出上限为
 * maxOutputTokens × ARTIFACT_MAX_ATTEMPTS。
 */
export const ARTIFACT_MAX_ATTEMPTS = 2

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

/**
 * 一次产物写入前的累计输出上限：maxOutputTokens 是「每次调用」的预算，
 * 首次生成与一次结构修复各自独立计量，因此累计上限为该额度乘以允许的调用次数。
 */
export const maxArtifactTotalOutputTokens = (budget: ArtifactBudget, invocationCount = 1): number => {
  if (!Number.isInteger(invocationCount) || invocationCount < 1 || invocationCount > ARTIFACT_MAX_ATTEMPTS) {
    throw new RangeError('artifact invocation count must be 1 or 2')
  }
  return budget.maxOutputTokens * invocationCount
}
