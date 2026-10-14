import type { TargetValidationBudget } from './targetValidationStore.js'

/** Explicit verification caps can only narrow the unchanged deployment policy. */
export const protectedVerificationBudget = (input: { readonly tokens?: string; readonly costMicros?: string }): TargetValidationBudget => {
  const parse = (value: string | undefined, maximum: number): number => {
    if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error('protected_verification_budget_invalid')
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number > maximum) throw new Error('protected_verification_budget_invalid')
    return number
  }
  return { maxEstimatedTokens: parse(input.tokens, 200_000), maxEstimatedCostMicros: parse(input.costMicros, 1_000_000), timeoutMs: 120_000 }
}
