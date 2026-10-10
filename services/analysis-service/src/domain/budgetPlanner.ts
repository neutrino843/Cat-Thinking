import type { QualityProfile } from '@cat-thinking/analysis-contracts'
import type { EvidenceChunkV1 } from '@cat-thinking/analysis-contracts'

export interface EvidenceBudgetLimits {
  readonly maxChunks: number
  readonly maxInputTokens: number
  readonly maxEstimatedTokens: number
  readonly maxEstimatedCostMicros: number
  readonly fastPathInputTokens: number
  readonly mergeFanIn: number
}
export interface EvidenceProfileBudget {
  readonly mapOutputTokens: number
  readonly mergeOutputTokens: number
  readonly concurrency: number
  readonly inputCostMicrosPerMillionTokens: number
  readonly outputCostMicrosPerMillionTokens: number
}

export interface EvidenceBudgetPolicy {
  readonly version: string
  readonly limits: EvidenceBudgetLimits
  readonly profiles: Readonly<Record<QualityProfile, EvidenceProfileBudget>>
}

export interface EvidenceBudgetPlan {
  readonly version: string
  readonly qualityProfile: QualityProfile
  readonly path: 'fast' | 'hierarchical'
  readonly chunks: number
  readonly mapCalls: number
  readonly mergeLevels: number
  readonly inputTokens: number
  readonly mapOutputTokens: number
  readonly mergeInputTokens: number
  readonly mergeOutputTokens: number
  readonly estimatedTotalTokens: number
  readonly estimatedCostMicros: number
  readonly concurrency: number
}

export class EvidenceBudgetExceededError extends Error {
  constructor(
    readonly dimension: 'chunks' | 'input_tokens' | 'total_tokens' | 'cost',
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(`evidence budget exceeded for ${dimension}: ${actual} > ${maximum}`)
    this.name = 'EvidenceBudgetExceededError'
  }
}

export const defaultEvidenceBudgetPolicy: EvidenceBudgetPolicy = Object.freeze({
  version: 'evidence-budget-v1',
  limits: Object.freeze({
    maxChunks: 2_000,
    maxInputTokens: 1_500_000,
    maxEstimatedTokens: 4_000_000,
    maxEstimatedCostMicros: 50_000_000,
    fastPathInputTokens: 12_000,
    mergeFanIn: 16,
  }),
  profiles: Object.freeze({
    economy: Object.freeze({
      mapOutputTokens: 500,
      mergeOutputTokens: 1_000,
      concurrency: 8,
      inputCostMicrosPerMillionTokens: 100_000,
      outputCostMicrosPerMillionTokens: 400_000,
    }),
    standard: Object.freeze({
      mapOutputTokens: 900,
      mergeOutputTokens: 1_800,
      concurrency: 6,
      inputCostMicrosPerMillionTokens: 500_000,
      outputCostMicrosPerMillionTokens: 1_500_000,
    }),
    'high-quality': Object.freeze({
      mapOutputTokens: 1_400,
      mergeOutputTokens: 2_800,
      concurrency: 4,
      inputCostMicrosPerMillionTokens: 2_000_000,
      outputCostMicrosPerMillionTokens: 8_000_000,
    }),
  }),
})

const checkedPositiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

export const planEvidenceBudget = (
  chunks: readonly EvidenceChunkV1[],
  qualityProfile: QualityProfile,
  policy: EvidenceBudgetPolicy = defaultEvidenceBudgetPolicy,
): EvidenceBudgetPlan => {
  const limits = policy.limits
  const profile = policy.profiles[qualityProfile]
  checkedPositiveInteger(limits.mergeFanIn, 'mergeFanIn')
  if (chunks.length > limits.maxChunks) {
    throw new EvidenceBudgetExceededError('chunks', chunks.length, limits.maxChunks)
  }
  const inputTokens = chunks.reduce((total, chunk) => total + chunk.estimatedTokens, 0)
  if (inputTokens > limits.maxInputTokens) {
    throw new EvidenceBudgetExceededError('input_tokens', inputTokens, limits.maxInputTokens)
  }
  const path = chunks.length === 1 && inputTokens <= limits.fastPathInputTokens ? 'fast' : 'hierarchical'
  const mapOutputTokens = chunks.length * profile.mapOutputTokens
  let mergeLevels = 0
  let mergeGroups = chunks.length
  let mergeInputTokens = 0
  let mergeOutputTokens = 0
  while (mergeGroups > 1) {
    mergeInputTokens += mergeGroups * profile.mapOutputTokens
    mergeGroups = Math.ceil(mergeGroups / limits.mergeFanIn)
    mergeOutputTokens += mergeGroups * profile.mergeOutputTokens
    mergeLevels += 1
  }
  const estimatedTotalTokens = inputTokens + mapOutputTokens + mergeInputTokens + mergeOutputTokens
  if (estimatedTotalTokens > limits.maxEstimatedTokens) {
    throw new EvidenceBudgetExceededError('total_tokens', estimatedTotalTokens, limits.maxEstimatedTokens)
  }
  const estimatedCostMicros = Math.ceil(
    (inputTokens + mergeInputTokens) * profile.inputCostMicrosPerMillionTokens / 1_000_000
    + (mapOutputTokens + mergeOutputTokens) * profile.outputCostMicrosPerMillionTokens / 1_000_000,
  )
  if (estimatedCostMicros > limits.maxEstimatedCostMicros) {
    throw new EvidenceBudgetExceededError('cost', estimatedCostMicros, limits.maxEstimatedCostMicros)
  }
  return Object.freeze({
    version: policy.version,
    qualityProfile,
    path,
    chunks: chunks.length,
    mapCalls: chunks.length,
    mergeLevels,
    inputTokens,
    mapOutputTokens,
    mergeInputTokens,
    mergeOutputTokens,
    estimatedTotalTokens,
    estimatedCostMicros,
    concurrency: profile.concurrency,
  })
}
