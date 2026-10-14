import { defineConfig, devices } from '@playwright/test'

/** Runs against a completed production build, never a changing Vite/HMR graph. */
export default defineConfig({
  testDir: './e2e/performance', fullyParallel: false, workers: 1, retries: 0, timeout: 45_000,
  outputDir: 'test-results/performance',
  reporter: [['list'], ['json', { outputFile: 'test-results/performance/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5176', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'production-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --port 5176 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5176', reuseExistingServer: false, timeout: 60_000 },
})
