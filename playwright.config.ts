import { defineConfig, devices } from '@playwright/test'

/**
 * M6 §3.4 Playwright E2E 基建。
 * - 仅 chromium（轻量、覆盖核心链路即可，不追求跨浏览器矩阵）
 * - 独立 5174 端口与日常 dev server 5173 隔离，reuseExistingServer:false 保证起干净实例
 * - retries 0：失败即真问题（计划 §四 风险对策明令禁用重试魔法）
 * - 每条 spec 自己 beforeEach 清空 localStorage + 删 IndexedDB，互不污染
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // 共享 IndexedDB 名 'maosizhi'，串行更稳
  forbidExpectError: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    port: 5174,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
