import type { AnalysisServiceConfig } from '../config.js'
import type { ProviderCostEstimateInput } from './providerInvocationCoordinator.js'

export const configuredCostEstimator = (config: AnalysisServiceConfig['provider']) => {
  if (config.mode === 'disabled' || config.inputMicrosPerMillionTokens <= 0 || config.outputMicrosPerMillionTokens <= 0) return undefined
  return (input: ProviderCostEstimateInput): number => {
    const numerator = BigInt(input.estimatedInputTokens) * BigInt(config.inputMicrosPerMillionTokens)
      + BigInt(input.reservedOutputTokens) * BigInt(config.outputMicrosPerMillionTokens)
    const cost = Number((numerator + 999_999n) / 1_000_000n)
    if (!Number.isSafeInteger(cost) || cost < 0) throw new RangeError('provider estimate exceeds safe integer range')
    return cost
  }
}
