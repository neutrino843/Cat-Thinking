/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['services/analysis-service/test/postgresJobStore.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage-postgres',
      include: ['services/analysis-service/src/infrastructure/postgres/**'],
    },
  },
})
