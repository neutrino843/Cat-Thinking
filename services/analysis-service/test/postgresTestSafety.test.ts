import { describe, expect, it } from 'vitest'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'

describe('destructive PostgreSQL test isolation', () => {
  it('accepts only the two dedicated recovery databases', () => {
    for (const name of ['cat_analysis_test', 'cat_analysis_smoke']) {
      expect(() => assertDedicatedPostgresTestDatabase(`postgresql://synthetic@localhost/${name}`)).not.toThrow()
    }
  })
  it('rejects development/production databases and malformed URLs without exposing credentials', () => {
    for (const value of ['postgresql://user:secret@localhost/cat_analysis_local', 'postgresql://user:secret@localhost/production', 'https://localhost/cat_analysis_test', 'not a URL', 'postgresql://localhost/cat_analysis_%74est']) {
      expect(() => assertDedicatedPostgresTestDatabase(value)).toThrow('dedicated')
      try { assertDedicatedPostgresTestDatabase(value) } catch (error) { expect((error as Error).message).not.toContain('secret') }
    }
  })
})
