import { describe, expect, it } from 'vitest'
import { abandonRunRequestSchema, lookupRunByRequestKeyQuerySchema, runUsageSchema } from '../src/runRecovery.js'

describe('additive recovery contracts', () => {
  it('limits intent queries and abandonment to immutable metadata', () => {
    const requestKey = 'a'.repeat(64)
    expect(lookupRunByRequestKeyQuerySchema.safeParse({ requestKey }).success).toBe(true)
    expect(abandonRunRequestSchema.safeParse({ version: 1, requestKey }).success).toBe(true)
    for (const input of [{ requestKey: 'short' }, { requestKey, tenantId: 'forged' }, { requestKey, text: 'raw content' }]) {
      expect(lookupRunByRequestKeyQuerySchema.safeParse(input).success).toBe(false)
    }
    expect(abandonRunRequestSchema.safeParse({ version: 1, requestKey, providerKey: 'never persist' }).success).toBe(false)
  })

  it('keeps known totals separate from unresolved completeness and rejects raw output', () => {
    const usage = { version: 1, runId: 'run-1', usage: { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 5, currency: 'USD' },
      invocationCount: 1, unresolvedCount: 1, estimatedInputTokens: 10, reservedOutputTokens: 50, completeness: 'unresolved' }
    expect(runUsageSchema.safeParse(usage).success).toBe(true)
    for (const invalid of [{ ...usage, completeness: 'complete' }, { ...usage, unresolvedCount: 2 }, { ...usage, rawOutput: '{}' }]) {
      expect(runUsageSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
