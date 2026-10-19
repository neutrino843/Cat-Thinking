import { test, expect, resetStore, waitForApp } from './helpers'

for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1366, height: 768 }, { width: 683, height: 384 }]) {
  test(`V3 task confirmation and all columns remain reachable ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await resetStore(page); await waitForApp(page)
    await page.getByRole('button', { name: '新建文档' }).click()
    await page.locator('.tpl-row').first().locator('button').first().click()
    await page.locator('svg g[role=button]').first().waitFor()
    await page.evaluate(async () => {
      const { useDoc } = await import('/src/store/docStore.ts')
      const root = useDoc.getState().doc.rootId
      const a = useDoc.getState().addChild(root); useDoc.getState().setNode(a, { text: '复习第三章并完成练习' })
      const b = useDoc.getState().addChild(root); useDoc.getState().setNode(b, { text: '牛顿第一定律' })
    })
    await page.setViewportSize(viewport)
    if (await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '切换文档库侧栏' }).click()
    await page.getByRole('tab', { name: '甘特', exact: true }).click()
    await expect(page.getByLabel('甘特图显示范围')).toHaveValue('tasks')
    await expect(page.locator('.gantt-row')).toHaveCount(0)
    await page.getByRole('button', { name: '从导图推测任务' }).click()
    const candidates = page.getByRole('region', { name: '确认推测任务' })
    await expect(candidates).toContainText('复习第三章并完成练习')
    await expect(candidates).not.toContainText('牛顿第一定律')
    await candidates.getByRole('checkbox').check()
    await page.getByRole('button', { name: '确认所选任务' }).click()
    const row = page.locator('.gantt-row').filter({ hasText: '复习第三章并完成练习' })
    await expect(row).toContainText('待安排')
    await expect(page.locator('.gantt-row').filter({ hasText: '牛顿第一定律' })).toHaveCount(0)
    await row.getByLabel('复习第三章并完成练习 负责人').fill('张三')
    await expect(row.getByLabel('复习第三章并完成练习 负责人')).toHaveValue('张三')
    const scroll = await page.locator('.gantt-left').evaluate((element) => ({ x: element.scrollLeft, overflow: getComputedStyle(element).overflowX }))
    expect(scroll.overflow).toBe('auto'); expect(scroll.x).toBeGreaterThan(0)
    await row.locator('.gantt-add').click()
    const editor = page.getByRole('dialog', { name: '编辑任务' })
    await editor.getByRole('button', { name: '移除任务信息（节点保留）' }).scrollIntoViewIfNeeded()
    const box = await editor.boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    await page.screenshot({ path: `reports/v3-gantt-${viewport.width}x${viewport.height}.png` })
    await editor.getByRole('button', { name: '关闭任务编辑' }).click()
    await expect(editor).toBeHidden()
  })
}

test('V3 local model setup previews folders and disk space, then explicitly chooses a local model', async ({ page }) => {
  const settings = { version: 1, revision: 0, available: true, enabled: false, configured: false, hasApiKey: false, checkState: 'unchecked', acceptsRuns: false, pricingKnown: false,
    limits: { maxInputCharacters: 100000, maxOutputTokens: 4096, maxRunTokens: 200000, maxInvocations: 24 } }
  let selected = 'C:\\Models'
  const writes: string[] = []
  await page.route('**/api/analysis/v1/personal/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/settings')) return route.fulfill({ json: settings })
    if (path.endsWith('/local-models/storage')) {
      const input = (route.request().postDataJSON() ?? {}) as { directory?: string; save?: boolean }
      if (input.save && input.directory) { selected = input.directory; writes.push(selected) }
      return route.fulfill({ json: { directory: input.directory ?? selected, configured: selected, browsing: input.directory ?? selected,
        parent: 'D:\\', folders: [{ name: '学习模型', path: 'D:\\学习模型' }], drives: ['C:\\', 'D:\\'], freeBytes: 100 * 1024 ** 3, canChange: true, externalEngine: false } })
    }
    return route.fulfill({ json: { running: false, models: ['qwen3:4b'], download: { state: 'idle', completed: 0, total: 0 } } })
  })
  await resetStore(page); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  const panel = page.locator('.ai-settings-panel')
  await panel.getByLabel('AI 服务', { exact: true }).selectOption('ollama')
  await expect(panel.getByLabel('离线模型管理')).toBeVisible()
  await panel.getByRole('button', { name: 'D:\\', exact: true }).click()
  await panel.getByRole('button', { name: '学习模型', exact: true }).click()
  await expect(panel.getByLabel('模型文件夹')).toHaveValue('D:\\学习模型')
  await expect(panel).toContainText('100.0 GB')
  await panel.getByRole('button', { name: '使用这个模型文件夹' }).click()
  expect(writes).toEqual(['D:\\学习模型'])
  await panel.getByRole('button', { name: '使用 qwen3:4b' }).click()
  await expect(panel.getByLabel('AI 模型', { exact: true })).toHaveValue('qwen3:4b')
  await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('ollama')
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: '保存并连接', exact: true }).scrollIntoViewIfNeeded()
  await expect(panel.getByRole('button', { name: '保存并连接', exact: true })).toBeInViewport()
  await page.screenshot({ path: 'reports/v3-model-setup-390.png' })
})

test('V3 local Isis sends only explicit input, retains it on failure, and shows a local answer', async ({ page }) => {
  let succeed = false
  const requests: unknown[] = []
  await page.route('**/api/analysis/v1/personal/settings', (route) => route.fulfill({ json: { version: 1, revision: 3, available: true, enabled: true, configured: true, hasApiKey: false, providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', modelId: 'synthetic-local-model', protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'local-loopback', checkState: 'ready', acceptsRuns: true, pricingKnown: false, limits: { maxInputCharacters: 100000, maxOutputTokens: 4096, maxRunTokens: 200000, maxInvocations: 24 } } }))
  await page.route('**/api/analysis/v1/personal/chat', async (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill(succeed ? { json: { answer: '根据你提供的原文，先核对定义再做练习。', model: 'synthetic-local-model', local: true } } : { status: 503, json: { error: 'unavailable' } })
  })
  await resetStore(page); await waitForApp(page)
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('button', { name: '模型问答', exact: true }).click()
  expect(requests).toHaveLength(0)
  await page.getByLabel('伊希斯参考原文').fill('这是公开合成的参考原文。')
  await page.getByLabel('本机伊希斯问题').fill('如何理解这个定义？')
  await page.getByRole('button', { name: '发送给本机模型' }).click()
  await expect(page.locator('.isis-local-chat [role=alert]')).toContainText('不会自动切换其他服务')
  await expect(page.getByLabel('本机伊希斯问题')).toHaveValue('如何理解这个定义？')
  expect(requests).toEqual([{ question: '如何理解这个定义？', context: '这是公开合成的参考原文。', expectedRevision: 3 }])
  succeed = true
  await page.getByRole('button', { name: '发送给本机模型' }).click()
  await expect(page.getByLabel('伊希斯本机回答')).toContainText('synthetic-local-model')
  await expect(page.getByLabel('伊希斯本机回答')).toContainText('核对定义')
})
