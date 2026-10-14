/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['services/analysis-service/test/postgresJobStore.integration.test.ts', 'services/analysis-service/test/targetValidation.postgres.integration.test.ts',
      'services/analysis-service/test/personalProvider.postgres.integration.test.ts', 'services/analysis-service/test/dispatcherCompatibility.postgres.integration.test.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage-postgres',
      include: ['services/analysis-service/src/infrastructure/postgres/**'],
    },
  },
})
