export const POSTGRES_REQUIRED_SUITES = Object.freeze([
  'postgresJobStore.integration.test.ts',
  'targetValidation.postgres.integration.test.ts',
  'personalProvider.postgres.integration.test.ts',
  'dispatcherCompatibility.postgres.integration.test.ts',
])
export const POSTGRES_MINIMUM_TESTS = 45

export const assertPostgresTestEvidence = (report) => {
  const suites = report.testResults
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0
    || report.numPassedTests < POSTGRES_MINIMUM_TESTS || !Array.isArray(suites)
    || !POSTGRES_REQUIRED_SUITES.every((required) => suites.some((suite) => String(suite.name).replaceAll('\\', '/').endsWith(`/${required}`)
      && suite.assertionResults?.length && suite.assertionResults.every((test) => test.status === 'passed')))
    || !suites.every((suite) => suite.assertionResults?.length && suite.assertionResults.every((test) => test.status === 'passed'))) {
    throw new Error('required_PostgreSQL_tests_failed_or_skipped')
  }
}
