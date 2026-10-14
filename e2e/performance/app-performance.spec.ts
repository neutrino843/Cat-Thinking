import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'

const publicText = '第一章 公开合成性能文档\n\n合成内容仅用于浏览器首屏、按需加载与刷新恢复的可重复测量。\n\n第二章 本地恢复\n\n刷新后文档身份和来源保持一致，不会创建任何付费分析请求。'
const panel = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'AI 学习分析' })

test('production 首屏、AI 按需打开与文档刷新恢复保留身份且没有分析 POST', async ({ page, browser }, testInfo) => {
  const errors: string[] = []
  const mutations: string[] = []
  const requestedScripts: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.resourceType() === 'script') requestedScripts.push(new URL(request.url()).pathname)
  })
  // Preview has no Provider/gateway. The only API response is a local, public, held fixture.
  await page.route('**/api/analysis/v1/**', async (route) => {
    if (route.request().method() !== 'GET') mutations.push(route.request().method())
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { version: 1, code: 'service_unavailable', category: 'availability', messageKey: 'temporary', retryable: false } }) })
  })
  const resourceSnapshot = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('.js'))
    .map((entry) => ({ file: new URL(entry.name).pathname, decodedBodyBytes: (entry as PerformanceResourceTiming).decodedBodySize, transferBytes: (entry as PerformanceResourceTiming).transferSize })))
  const timings: Record<string, number> = {}
  let start = performance.now()
  await page.goto('/')
  await expect(page.locator('.loading')).toBeHidden()
  await expect(page.locator('header.toolbar')).toBeVisible()
  timings.firstScreenMs = Math.round(performance.now() - start)
  expect(requestedScripts.some((path) => /\/AnalysisResultsPanel-[^/]+\.js$/.test(path))).toBe(false)
  const initialResources = await resourceSnapshot()

  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '公开合成性能.txt', mimeType: 'text/plain', buffer: Buffer.from(publicText) })
  const imported = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await imported.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 公开合成性能文档')
  // openDoc writes the tab list synchronously; LAST_KEY is written by debounced autosave.
  const docId = await page.evaluate(() => (JSON.parse(localStorage.getItem('msz.openTabs') ?? '[]') as string[]).at(-1))
  expect(docId).toBeTruthy()
  start = performance.now()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('公开合成性能.txt')
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeDisabled()
  timings.aiFirstOpenMs = Math.round(performance.now() - start)
  expect(requestedScripts.some((path) => /\/AnalysisResultsPanel-[^/]+\.js$/.test(path))).toBe(true)
  const firstAIResources = await resourceSnapshot()
  await panel(page).getByRole('button', { name: '关闭 AI 分析' }).click()

  start = performance.now()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('公开合成性能.txt')
  timings.aiReopenMs = Math.round(performance.now() - start)
  await panel(page).getByRole('button', { name: '关闭 AI 分析' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('msz.lastDoc'))).toBe(docId)

  start = performance.now()
  await page.reload()
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 公开合成性能文档')
  timings.reloadDocumentReadyMs = Math.round(performance.now() - start)
  expect(await page.evaluate(() => localStorage.getItem('msz.lastDoc'))).toBe(docId)
  start = performance.now()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('公开合成性能.txt')
  timings.reloadAIReadyMs = Math.round(performance.now() - start)

  const restoredResources = await resourceSnapshot()
  await testInfo.attach('production-performance', { body: JSON.stringify({ version: 1, runtime: 'chromium-production-preview', browserVersion: browser.version(), repeatIndex: testInfo.repeatEachIndex, units: 'milliseconds', timings, resources: { initial: initialResources, afterFirstAI: firstAIResources, afterReloadAI: restoredResources }, analysisMutations: mutations.length }, null, 2), contentType: 'application/json' })
  // These are generous responsiveness limits, not a benchmark or a production percentile guarantee.
  for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(10_000)
  expect(errors).toEqual([])
  expect(mutations).toEqual([])
})
