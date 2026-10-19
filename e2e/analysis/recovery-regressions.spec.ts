import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { resetStore, waitForApp } from '../helpers'
import { ANALYSIS_SYNTHETIC } from '../../services/analysis-service/test/fixtures/browserSyntheticTexts'

const panel = (page: Page) => page.getByRole('dialog', { name: 'AI 学习分析' })
const control = (request: APIRequestContext, open: boolean) => request.post('http://127.0.0.1:8790/__synthetic/gate', {
  headers: { authorization: `Bearer ${process.env.ANALYSIS_GATEWAY_TOKEN ?? ''}` }, data: { open },
})
async function importAndOpen(page: Page) {
  await resetStore(page); await waitForApp(page)
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '公开合成.txt', mimeType: 'text/plain', buffer: Buffer.from(ANALYSIS_SYNTHETIC.normal) })
  await page.getByRole('dialog', { name: '从文档生成可编辑导图' }).getByRole('button', { name: '创建可编辑导图' }).click()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('合成测试环境')
}
async function binding(page: Page): Promise<{ docId: string; runId?: string; request: { requestKey: string } } | undefined> {
  return page.evaluate(async () => {
    const open = indexedDB.open('maosizhi')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    try {
      const read = db.transaction('analysisTasks').objectStore('analysisTasks').getAll()
      return await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result[0]); read.onerror = () => reject(read.error) })
    } finally { db.close() }
  })
}
async function changeSource(page: Page, remove = false) {
  await page.evaluate(async ({ text, remove }) => {
    const open = indexedDB.open('maosizhi')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    try {
      const transaction = db.transaction('sources', 'readwrite'); const store = transaction.objectStore('sources')
      const read = store.getAll()
      read.onsuccess = () => { const source = read.result[0]; if (remove) store.delete(source.id); else { source.text = text; source.charCount = text.length; store.put(source) } }
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) })
    } finally { db.close() }
  }, { text: ANALYSIS_SYNTHETIC.slow, remove })
}
test.afterEach(async ({ request }) => { await control(request, true) })

test('进度流提前结束时自动查询完成状态，刷新与恢复不增加调用', async ({ page, request }) => {
  await importAndOpen(page)
  await page.route('**/api/analysis/v1/runs/*/events', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream', body: ': disconnected stream\n\n',
  }))
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('合成摘要：')
  await expect(panel(page).getByRole('region', { name: '大纲结果' })).toContainText('能量转换')
  await expect(panel(page).locator('.analysis-error')).toHaveCount(0)
  const task = await binding(page)
  const readUsage = async () => (await (await request.get(`/api/analysis/v1/runs/${task?.runId}/usage`)).json()).invocationCount
  expect(await readUsage()).toBe(3)
  await panel(page).getByRole('button', { name: '恢复查看' }).click()
  await page.reload(); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成')
  expect(await readUsage()).toBe(3)
})


test('加载中的原生模态保持键盘隔离，关闭后迟到模块不会重新打开', async ({ page }) => {
  await resetStore(page); await waitForApp(page)
  const nodes = await page.locator('svg g[role=button]').count()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/src/components/AnalysisResultsPanel.tsx*', async (route) => { await pending; await route.continue().catch(() => {}) })
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  const loading = page.getByRole('dialog', { name: 'AI 分析加载中' })
  await expect(loading).toBeVisible()
  await page.keyboard.press('Tab'); await page.keyboard.press('Delete'); await page.keyboard.press('Enter')
  expect(await page.locator('svg g[role=button]').count()).toBe(nodes)
  await page.keyboard.press('Escape'); await expect(loading).toBeHidden(); release()
  await expect(panel(page)).toBeHidden()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click(); await expect(panel(page)).toBeVisible()
})
test('终态摘要 GET 暂时失败不阻止大纲，自动只读恢复不增加账本调用', async ({ page, request }) => {
  await importAndOpen(page)
  let failures = 0
  await page.route('**/api/analysis/v1/runs/*/artifacts/summary', (route) => failures++ < 2
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { version: 1, code: 'service_unavailable', category: 'availability', messageKey: 'temporary', retryable: true } }) })
    : route.continue())
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page).getByRole('region', { name: '大纲结果' })).toContainText('能量转换', { timeout: 20_000 })
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('合成摘要：', { timeout: 10_000 })
  expect(failures).toBe(3)
  const task = await binding(page)
  const usage = await (await request.get(`/api/analysis/v1/runs/${task?.runId}/usage`)).json()
  expect(usage.invocationCount).toBe(3)
})
test('另一个标签删除终态关联后立即清除结果与已打开的引用', async ({ page, context }) => {
  await importAndOpen(page)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  await panel(page).getByRole('button', { name: '查看原文引用 1' }).first().click()
  await expect(panel(page).getByRole('region', { name: '原文引用' })).toBeVisible()
  const task = await binding(page)
  const second = await context.newPage(); await second.goto('/#mindmap'); await waitForApp(second)
  await second.evaluate(async (docId) => {
    const repository = await import('/src/analysis/taskPersistence.ts')
    await repository.analysisTaskRepository.remove(docId)
  }, task!.docId)
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toHaveCount(0)
  await expect(panel(page).getByRole('region', { name: '原文引用' })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeEnabled()
  await second.close()
})
for (const remove of [false, true]) test(`创建响应丢失且原文${remove ? '删除' : '变化'}后，held 仍可只读找回并删除`, async ({ page, request }) => {
  await importAndOpen(page)
  let acceptedRunId = ''
  await page.route('**/api/analysis/v1/runs', async (route) => {
    const response = await route.fetch(); const created = await response.json(); acceptedRunId = created.run.id
    await route.abort('failed')
  })
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('创建结果尚未确认')
  expect((await binding(page))?.runId).toBeUndefined()
  await changeSource(page, remove); await control(request, false)
  // held 状态（创建未确认、无 runId）主按钮为显式续传确认；点击后仅只读找回并绑定已接受的 run
  await panel(page).getByRole('button', { name: '继续提交并生成（使用模型额度）' }).click()
  await expect.poll(async () => (await binding(page))?.runId).toBe(acceptedRunId)
  await expect(panel(page)).toContainText('原文已改变')
  expect((await (await request.get(`/api/analysis/v1/runs/${acceptedRunId}/usage`)).json()).invocationCount).toBe(0)
  await panel(page).getByRole('button', { name: '删除分析内容' }).click()
  await panel(page).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => binding(page)).toBeUndefined()
})
test('用量读取被限流(429)时呈现中性提示，恢复后成功状态与用量正常送达', async ({ page }) => {
  await importAndOpen(page)
  let limitedReads = 0
  await page.route('**/api/analysis/v1/runs/*/usage', (route) => limitedReads++ < 2
    ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { version: 1, code: 'rate_limited', category: 'rate-limit', messageKey: 'analysis.rate_limit.exceeded', retryable: true } }) })
    : route.continue())
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('状态同步稍慢', { timeout: 20_000 })
  await expect(panel(page)).not.toContainText('操作被服务拒绝')
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 25_000 })
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('合成摘要：')
  await expect(panel(page)).toContainText('已知使用量', { timeout: 15_000 })
  await expect(panel(page)).not.toContainText('状态同步稍慢')
  expect(limitedReads).toBeGreaterThanOrEqual(2)
})
test('持久放弃未确认创建后拒绝同 key 的迟到 POST，允许新的明确创建', async ({ page, request }) => {
  await importAndOpen(page)
  let original: unknown
  await page.route('**/api/analysis/v1/runs', (route) => { original = route.request().postDataJSON(); return route.abort('failed') })
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('创建结果尚未确认')
  const task = await binding(page); expect(task?.runId).toBeUndefined()
  await control(request, false)
  await panel(page).getByRole('button', { name: '删除分析内容' }).click()
  await expect(panel(page)).toContainText('阻止迟到请求')
  await panel(page).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => binding(page)).toBeUndefined()
  await control(request, true)
  await expect.poll(async () => (await (await request.get('/api/analysis/v1/capabilities')).json()).acceptsRuns).toBe(true)
  expect((await request.post('/api/analysis/v1/runs', { data: original })).status()).toBe(409)
  const lookup = await (await request.get(`/api/analysis/v1/runs/by-request-key?requestKey=${task?.request.requestKey}`)).json()
  expect(lookup.status).toBe('abandoned')
  await page.unroute('**/api/analysis/v1/runs')
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  expect((await binding(page))?.request.requestKey).not.toBe(task?.request.requestKey)
})
