import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e/personal', fullyParallel: false, workers: 1, retries: 0, timeout: 45_000,
  // Keep the earlier analysis suite's recovery screenshots and JSON evidence.
  outputDir: 'test-results/personal',
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'synthetic-personal-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'node services/analysis-service/.browser-test-runtime/services/analysis-service/test/personalBrowserHarness.js', url: 'http://127.0.0.1:8790/health', reuseExistingServer: false, timeout: 60_000 },
    { command: 'node node_modules/vite/bin/vite.js --port 5175 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5175', reuseExistingServer: false, timeout: 60_000 },
  ],
})
