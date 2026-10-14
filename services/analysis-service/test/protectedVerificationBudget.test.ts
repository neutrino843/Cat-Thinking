import { describe, expect, it } from 'vitest'
import { protectedVerificationBudget } from '../src/release/protectedVerificationBudget.js'
describe('explicit verification budget parsing', () => {
  it('preserves smaller explicit user limits', () => {
    expect(protectedVerificationBudget({ tokens: '10000', costMicros: '5000' })).toEqual({ maxEstimatedTokens: 10000, maxEstimatedCostMicros: 5000, timeoutMs: 120000 })
  })
  it('refuses absent, ambiguous, zero or enlarged verification budgets', () => {
    for (const value of [undefined, '', '0', '-1', '1.5', ' 100', '1e3', '0001', 'NaN', '9007199254740992']) {
      expect(() => protectedVerificationBudget({ tokens: value, costMicros: '10000' })).toThrow('budget_invalid')
      expect(() => protectedVerificationBudget({ tokens: '10000', costMicros: value })).toThrow('budget_invalid')
    }
    expect(() => protectedVerificationBudget({ tokens: '200001', costMicros: '10000' })).toThrow('budget_invalid')
    expect(() => protectedVerificationBudget({ tokens: '10000', costMicros: '1000001' })).toThrow('budget_invalid')
  })
})
