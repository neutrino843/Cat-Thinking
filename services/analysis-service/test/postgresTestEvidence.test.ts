import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
const { assertPostgresTestEvidence, POSTGRES_REQUIRED_SUITES, POSTGRES_MINIMUM_TESTS } = await import(pathToFileURL(resolve('scripts/postgres-test-evidence.mjs')).href)
const fixture = () => ({ success: true, numFailedTests: 0, numPendingTests: 0, numPassedTests: POSTGRES_MINIMUM_TESTS,
  testResults: POSTGRES_REQUIRED_SUITES.map((name: string) => ({ name: `D:\\synthetic\\${name}`, assertionResults: [{ status: 'passed' }] })) })
describe('required PostgreSQL release evidence', () => {
  it('requires every recovery suite, including encrypted personal provider settings', () => {
    expect(() => assertPostgresTestEvidence(fixture())).not.toThrow()
    const missing = fixture()
    missing.testResults.pop()
    expect(() => assertPostgresTestEvidence(missing)).toThrow('required_PostgreSQL_tests_failed_or_skipped')
  })
  it.each(['pending', 'skipped', 'failed'])('rejects %s evidence even with a large passing count', (status) => {
    const report = fixture()
    report.numPassedTests = 1000
    report.testResults[2].assertionResults[0].status = status
    expect(() => assertPostgresTestEvidence(report)).toThrow()
  })
})
