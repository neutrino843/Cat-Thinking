import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { resetStore, waitForApp } from '../helpers'
import { ANALYSIS_SYNTHETIC } from '../../services/analysis-service/test/fixtures/browserSyntheticTexts'

const expectedFact = ' Photosynthesis converts light into stored chemical energy.'

const privateHeaders = () => ({ authorization: `Bearer ${process.env.ANALYSIS_GATEWAY_TOKEN ?? ''}` })
const control = (request: APIRequestContext, action: string, data?: unknown) => request.post(`http://127.0.0.1:8790/__synthetic/${action}`, { headers: privateHeaders(), data })
async function importAndOpen(page: Page, text = ANALYSIS_SYNTHETIC.normal as string) {
  await resetStore(page)
  await waitForApp(page)
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '合成学习文档.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  const imported = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await imported.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(imported).toBeHidden()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI 学习分析' })).toContainText('合成测试环境')
}
const panel = (page: Page) => page.getByRole('dialog', { name: 'AI 学习分析' })
async function taskId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    try {
      const getting = database.transaction('analysisTasks').objectStore('analysisTasks').getAll()
      const rows = await new Promise<{ runId?: string }[]>((resolve, reject) => { getting.onsuccess = () => resolve(getting.result); getting.onerror = () => reject(getting.error) })
      return rows[0]?.runId ?? ''
    } finally { database.close() }
  })
}
async function diagnostic(request: APIRequestContext, runId: string) {
  const response = await request.get(`http://127.0.0.1:8790/__synthetic/runs/${runId}`, { headers: privateHeaders() })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
async function reopen(page: Page) { await page.reload(); await waitForApp(page); await page.getByRole('button', { name: 'AI 分析', exact: true }).click() }
test.afterEach(async ({ request, page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const id = await taskId(page).catch(() => '')
    if (id) await testInfo.attach('synthetic-run-snapshot', { body: JSON.stringify(await diagnostic(request, id).catch(() => ({}))), contentType: 'application/json' })
  }
  await control(request, 'gate', { open: true })
})

test('分析面板加载中断时保留文档界面并提供关闭提示', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  const nodes = await page.locator('svg g[role=button]').count()
  await page.route('**/src/components/AnalysisResultsPanel.tsx*', (route) => route.abort())
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI 分析加载失败' })).toContainText('刷新页面重试')
  await page.keyboard.press('Tab'); await page.keyboard.press('Delete'); await page.keyboard.press('Enter')
  expect(await page.locator('svg g[role=button]').count()).toBe(nodes)
  if (await page.getByRole('dialog', { name: 'AI 分析加载失败' }).isVisible()) await page.getByRole('button', { name: '关闭加载提示' }).click()
  await expect(page.getByRole('dialog', { name: 'AI 分析加载失败' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeEnabled()
})

test('完整 fake pipeline 生成两种产物、引用定位、刷新及服务重启不重复调用', async ({ page, request }) => {
  await importAndOpen(page)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).dblclick()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('合成摘要：')
  await expect(panel(page).getByRole('region', { name: '大纲结果' })).toContainText('能量转换')
  await panel(page).getByRole('button', { name: '查看原文引用 1' }).first().click()
  await expect(panel(page).getByRole('region', { name: '原文引用' }).locator('mark')).toHaveText(expectedFact)
  const id = await taskId(page)
  const before = await diagnostic(request, id)
  expect(before.ledger.invocationCount).toBe(3)
  expect(before.ledger.usage.inputTokens).toBe(60)
  const beforeRestart = await (await request.get('http://127.0.0.1:8790/__synthetic/status', { headers: privateHeaders() })).json()
  await control(request, 'restart')
  await expect.poll(async () => { try { return (await (await request.get('http://127.0.0.1:8790/__synthetic/status', { headers: privateHeaders() })).json()).generation } catch { return 0 } }, { timeout: 15000 }).toBeGreaterThan(beforeRestart.generation)
  await reopen(page)
  await expect(panel(page)).toContainText('任务：分析完成')
  expect(await taskId(page)).toBe(id)
  expect((await diagnostic(request, id)).ledger.invocationCount).toBe(3)
  await page.screenshot({ path: 'test-results/analysis-summary-outline.png' })
})

test('生成中刷新与读请求断线恢复保留同一 run', async ({ page, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.slow)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：生成结果')
  await expect.poll(() => taskId(page)).not.toBe('')
  const id = await taskId(page)
  await reopen(page)
  let interrupted = false
  await page.route('**/api/analysis/v1/runs/*/events', async (route) => {
    if (!interrupted) { interrupted = true; await route.abort('failed') } else await route.continue()
  })
  await panel(page).getByRole('button', { name: '恢复查看' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  expect(await taskId(page)).toBe(id)
  expect((await diagnostic(request, id)).ledger.invocationCount).toBe(3)
})

test('上传中刷新仅恢复相同原文分片', async ({ page, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.upload)
  let uploads = 0
  await page.route('**/api/analysis/v1/runs/*/sources/*', async (route) => {
    uploads++
    if (uploads === 2) await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue().catch(() => {})
  })
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect.poll(() => uploads).toBeGreaterThanOrEqual(2)
  const id = await taskId(page)
  await reopen(page)
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 30_000 })
  expect(await taskId(page)).toBe(id)
  expect((await diagnostic(request, id)).run.coverage.input).toBe(1)
})

test('部分成功保留摘要，显式重试大纲使用 CAS', async ({ page, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.partial)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：部分完成', { timeout: 20_000 })
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('合成摘要：')
  const id = await taskId(page)
  await panel(page).getByRole('button', { name: '重试大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  expect((await diagnostic(request, id)).ledger.invocationCount).toBe(4)
})

test('未知计费结果保留 ledger 且刷新后不重放', async ({ page, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.unknown)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('模型调用结果无法确认', { timeout: 20_000 })
  await expect(panel(page)).toContainText('不会自动重新调用')
  await expect(panel(page).getByRole('button', { name: '重试大纲' })).toHaveCount(0)
  const id = await taskId(page)
  const before = await diagnostic(request, id)
  expect(before.ledger.unresolvedCount).toBe(1)
  await reopen(page)
  await expect(panel(page)).toContainText('不会自动重新调用')
  expect((await diagnostic(request, id)).ledger).toEqual(before.ledger)
})

test('取消与删除清除结果和本地关联，原始文档仍保留', async ({ page }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.slow)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：生成结果')
  await panel(page).getByRole('button', { name: '取消任务' }).click()
  await expect(panel(page)).toContainText('任务：已取消')
  await panel(page).getByRole('button', { name: '删除分析内容' }).click()
  await panel(page).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeEnabled()
  expect(await taskId(page)).toBe('')
  await expect(panel(page)).toContainText('合成学习文档.txt')
})

test('门禁关闭禁用新任务，伪造租户和 bearer 无法访问其他租户', async ({ page, request }) => {
  await control(request, 'gate', { open: false })
  await importAndOpen(page)
  await expect(panel(page)).toContainText('新分析暂不可用')
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeDisabled()
  const response = await request.get('/api/analysis/v1/capabilities', { headers: { authorization: 'Bearer forged', 'x-cat-tenant-id': 'other-tenant' } })
  expect(response.status()).toBe(200)
  expect((await response.json()).acceptsRuns).toBe(false)
  expect((await request.get('/api/analysis/v1/capabilities', { headers: { origin: 'http://attacker.test' } })).status()).toBe(403)
  expect((await request.get('/api/analysis/v1/__synthetic/gate')).status()).toBe(404)
})

test('原文修改后隐藏旧结果并阻止错误恢复，键盘和关闭操作可用', async ({ page }) => {
  await importAndOpen(page)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  await page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result) })
    try {
      const transaction = database.transaction('sources', 'readwrite')
      const store = transaction.objectStore('sources')
      const getting = store.getAll()
      getting.onsuccess = () => { const source = getting.result[0]; source.text = 'Modified original'; source.charCount = source.text.length; store.put(source) }
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) })
    } finally { database.close() }
  })
  await panel(page).getByRole('button', { name: '恢复查看' }).click()
  await expect(panel(page)).toContainText('原文已改变')
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
})

test('只生成摘要并限制范围，删除后可显式发起新的分析', async ({ page, request }) => {
  await importAndOpen(page)
  await panel(page).getByRole('checkbox', { name: '大纲', exact: true }).uncheck()
  await panel(page).getByRole('spinbutton', { name: '合成学习文档.txt 起始字符' }).fill('0')
  await panel(page).getByRole('spinbutton', { name: '合成学习文档.txt 结束字符' }).fill('40')
  await panel(page).getByRole('button', { name: '生成所选内容', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20000 })
  await expect(panel(page).getByRole('region', { name: '大纲结果' })).toHaveCount(0)
  const first = await taskId(page)
  expect((await diagnostic(request, first)).run.request.artifacts).toEqual(['summary'])
  expect((await diagnostic(request, first)).run.request.manifest.sources[0].selectedRange).toEqual({ start: 0, end: 40 })
  await panel(page).getByRole('button', { name: '删除分析内容' }).click()
  await panel(page).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '生成所选内容', exact: true })).toBeEnabled()
  await panel(page).getByRole('button', { name: '生成所选内容', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20000 })
  expect(await taskId(page)).not.toBe(first)
  expect((await diagnostic(request, await taskId(page))).run.request.artifacts).toEqual(['summary'])
})

test('两个标签页的并发点击只创建一个任务，伪造身份不能跨租户取结果', async ({ page, context, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.slow)
  const second = await context.newPage()
  await second.goto('/#mindmap'); await waitForApp(second)
  await second.getByRole('tab', { name: /合成学习文档/ }).click()
  await expect(second.locator('input.doc-title')).toHaveValue('合成学习文档')
  await second.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(second).getByRole('button', { name: '生成摘要与大纲' })).toBeEnabled()
  await Promise.all([panel(page).getByRole('button', { name: '生成摘要与大纲' }).click(), panel(second).getByRole('button', { name: '生成摘要与大纲' }).click()])
  await expect.poll(() => taskId(page)).not.toBe('')
  const id = await taskId(page)
  await panel(second).getByRole('button', { name: '关闭 AI 分析' }).click()
  await second.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(second)).toContainText('任务：分析完成', { timeout: 20000 })
  expect(await taskId(second)).toBe(id)
  expect((await diagnostic(request, id)).ledger.invocationCount).toBe(3)
  const forged = await request.get(`/api/analysis/v1/runs/${id}`, { headers: { authorization: 'Bearer forged', 'x-cat-tenant-id': 'other-tenant' } })
  expect(forged.status()).toBe(200) // Gateway replaces both headers with its trusted identity.
  const foreign = await request.get(`http://127.0.0.1:8790/api/analysis/v1/runs/${id}`, { headers: { ...privateHeaders(), 'x-cat-tenant-id': 'other-tenant' } })
  expect(foreign.status()).toBe(404)
  await second.close()
})

test('切换文档后不显示前一篇的结果，离线状态禁用创建', async ({ page }) => {
  await importAndOpen(page)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20000 })
  await panel(page).getByRole('button', { name: '关闭 AI 分析' }).click()
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '另一个合成文档.txt', mimeType: 'text/plain', buffer: Buffer.from(ANALYSIS_SYNTHETIC.normal) })
  await page.getByRole('dialog', { name: '从文档生成可编辑导图' }).getByRole('button', { name: '创建可编辑导图' }).click()
  await page.route('**/api/analysis/v1/capabilities', (route) => route.abort('failed'))
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('新分析暂不可用')
  await expect(panel(page)).toContainText('另一个合成文档.txt')
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeDisabled()
  await page.unroute('**/api/analysis/v1/capabilities')
  await panel(page).getByRole('button', { name: '重新检查服务' }).click()
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲' })).toBeEnabled()
})

test('IndexedDB v7 文档、来源和历史兼容升级到 v11，任务只保存元数据', async ({ page }) => {
  await importAndOpen(page)
  await panel(page).getByRole('button', { name: '关闭 AI 分析' }).click()
  const existing = await page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result) })
    const read = (table: string) => new Promise<any[]>((resolve) => { const query = database.transaction(table).objectStore(table).getAll(); query.onsuccess = () => resolve(query.result) })
    try { return { docs: await read('docs'), sources: await read('sources'), history: await read('docVersions') } }
    finally { database.close() }
  })
  await page.goto('/src/main.tsx')
  await page.evaluate(async (saved) => {
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase('maosizhi'); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error) })
    const opening = indexedDB.open('maosizhi', 70) // Dexie v7 uses native version 70.
    opening.onupgradeneeded = () => {
      for (const [name, keyPath, indexes] of [
        ['docs', 'id', ['updatedAt']], ['templates', 'id', ['createdAt']], ['trash', 'id', ['deletedAt']],
        ['blobs', 'id', ['docId', 'nodeId']], ['fileHandles', 'docId', []], ['docVersions', 'id', ['docId', 'createdAt']], ['sources', 'id', ['docId', 'importedAt']],
      ] as [string, string, string[]][]) {
        const store = opening.result.createObjectStore(name, { keyPath })
        for (const index of indexes) store.createIndex(index, index)
      }
    }
    const database = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result) })
    try {
      const transaction = database.transaction(['docs', 'sources', 'docVersions'], 'readwrite')
      saved.docs.forEach((doc) => transaction.objectStore('docs').put(doc))
      saved.sources.forEach((source) => transaction.objectStore('sources').put(source))
      saved.history.forEach((version) => transaction.objectStore('docVersions').put(version))
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) })
    } finally { database.close() }
  }, existing)
  await page.goto('/#mindmap'); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('合成学习文档.txt')
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20000 })
  const recovered = await page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result) })
    const read = (table: string) => new Promise<any[]>((resolve) => { const query = database.transaction(table).objectStore(table).getAll(); query.onsuccess = () => resolve(query.result) })
    try { return { version: database.version, docs: await read('docs'), sources: await read('sources'), history: await read('docVersions'), tasks: await read('analysisTasks') } }
    finally { database.close() }
  })
  expect(recovered.version).toBe(110)
  expect(recovered.docs).toEqual(existing.docs)
  expect(recovered.sources).toEqual(existing.sources)
  // Opening a document can append a legitimate version snapshot. Existing
  // history must survive the migration, without forbidding normal new history.
  expect(recovered.history).toEqual(expect.arrayContaining(existing.history))
  const serialized = JSON.stringify(recovered.tasks)
  expect(serialized).not.toContain('authorization')
  expect(serialized).not.toContain('payload')
  expect(serialized).not.toContain(ANALYSIS_SYNTHETIC.normal)
})
