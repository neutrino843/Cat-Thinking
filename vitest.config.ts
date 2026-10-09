/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: [
      'src/**/*.test.ts',
      'packages/analysis-contracts/test/**/*.test.ts',
      'evals/analysis/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'src/lib/**',
        'src/analysis/**',
        'src/store/docStore.ts',
        'packages/analysis-contracts/src/**',
      ],
      exclude: ['src/lib/measure.ts'],
    },
  },
})
