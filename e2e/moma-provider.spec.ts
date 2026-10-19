import { test, expect, resetStore, waitForApp } from './helpers'

const limits = { maxInputCharacters: 100000, maxOutputTokens: 4096, maxRunTokens: 200000, maxInvocations: 24 }
const connection = { version: 1, revision: 3, available: true, enabled: true, configured: true, hasApiKey: true,
  providerId: 'mobilecloud', baseUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1/', modelId: 'deepseek-v4-flash-0731',
  protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public', checkState: 'ready', acceptsRuns: true, pricingKnown: false, limits }

for (const width of [320, 375, 414, 768]) {
  test(`MoMA settings and explicit cloud Isis remain usable at ${width}px`, async ({ page }) => {
    const requests: unknown[] = []
    await page.route('**/api/analysis/v1/personal/settings', (route) => route.fulfill({ json: connection }))
    await page.route('**/api/analysis/v1/personal/chat', async (route) => {
      requests.push(route.request().postDataJSON())
      return route.fulfill({ json: { answer: '根据你提供的原文，需要区分比较次数与总耗时。', model: connection.modelId, local: false } })
    })
    await resetStore(page); await waitForApp(page)
    await page.setViewportSize({ width, height: 740 })
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
    const panel = page.locator('.ai-settings-panel')
    await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('mobilecloud')
    await expect(panel.getByLabel('AI 模型', { exact: true })).toHaveValue(connection.modelId)
    await expect(panel.getByLabel('离线模型管理')).toHaveCount(0)
    await expect(panel.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'password')
    await panel.getByRole('button', { name: '保存并连接', exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByRole('button', { name: '保存并连接', exact: true })).toBeInViewport()
    await page.screenshot({ path: `reports/v3-moma-settings-${width}.png` })
    await panel.getByRole('button', { name: '关闭 AI 设置' }).click()
    await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
    await page.getByRole('button', { name: '模型问答', exact: true }).click()
    const chat = page.locator('.isis-local-chat')
    await expect(chat).toContainText('zhenze-huhehaote.cmecloud.cn')
    await expect(chat).toContainText('账号额度')
    expect(requests).toHaveLength(0)
    await page.getByLabel('伊希斯参考原文').fill('一次查询的比较次数不等于系统总耗时。')
    await page.getByLabel('伊希斯问题', { exact: true }).fill('能否认定总耗时更短？')
    await page.getByRole('button', { name: '发送给当前模型' }).click()
    await expect(page.getByLabel('伊希斯模型回答')).toContainText('互联网模型')
    expect(requests).toEqual([{ question: '能否认定总耗时更短？', context: '一次查询的比较次数不等于系统总耗时。', expectedRevision: 3 }])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `reports/v3-moma-isis-${width}.png` })
  })
}

test('a short connection test is explicit, binds the saved revision and is disabled for an unsaved provider change', async ({ page }) => {
  const requests: unknown[] = []
  await page.route('**/api/analysis/v1/personal/settings', (route) => route.fulfill({ json: { ...connection, providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/', modelId: 'deepseek-flash' } }))
  await page.route('**/api/analysis/v1/personal/chat', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { answer: '连接测试成功。', model: 'deepseek-flash', local: false } })
  })
  await resetStore(page); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  const panel = page.locator('.ai-settings-panel')
  await expect(panel).toContainText('api.deepseek.com')
  expect(requests).toHaveLength(0)
  await panel.getByRole('button', { name: '测试问答（使用额度）' }).click()
  await expect(panel).toContainText('实际回答：连接测试成功')
  expect(requests).toEqual([{ question: '请只回复：连接测试成功。', context: '', expectedRevision: 3 }])
  await panel.getByRole('button', { name: '改用移动云 MoMA' }).click()
  await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('mobilecloud')
  await expect(panel.getByLabel('API 密钥', { exact: true })).toHaveValue('')
  await expect(panel.getByLabel('AI 模型', { exact: true })).toHaveValue('deepseek-v4-flash-0731')
  await expect(panel.getByRole('button', { name: '测试问答（使用额度）' })).toBeDisabled()
  expect(requests).toHaveLength(1)
})

test('MoMA direct link recognizes an already saved normalized connection without requiring another save', async ({ page }) => {
  const mutations: string[] = []
  await page.route('**/api/analysis/v1/personal/**', route => {
    if (route.request().method() !== 'GET') mutations.push(route.request().url())
    return route.fulfill({ json: connection })
  })
  await resetStore(page); await waitForApp(page)
  await page.goto('/?connect=mobilecloud#home')
  const panel = page.getByRole('dialog', { name: '连接移动云 DeepSeek' })
  await expect(panel.getByRole('button', { name: '测试问答（使用额度）' })).toBeEnabled()
  await expect(panel).not.toContainText('表单有未保存的修改')
  await expect(panel.getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(mutations).toEqual([])
})

test('MoMA direct link opens a prefilled form without saving credentials, changing the old connection or generating', async ({ page }) => {
  const mutations: string[] = []
  await page.route('**/api/analysis/v1/personal/**', (route) => {
    if (route.request().method() !== 'GET') mutations.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: { ...connection, providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/', modelId: 'deepseek-flash' } })
  })
  await resetStore(page); await waitForApp(page)
  const title = await page.getByLabel('文档标题').inputValue()
  await page.goto('/?connect=mobilecloud#home')
  const panel = page.getByRole('dialog', { name: '连接移动云 DeepSeek' })
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('mobilecloud')
  await expect(panel.getByLabel('AI 模型', { exact: true })).toHaveValue('deepseek-v4-flash-0731')
  await expect(panel.getByLabel('API 密钥', { exact: true })).toBeFocused()
  await expect(panel.getByLabel('API 密钥', { exact: true })).toHaveValue('')
  await expect(panel.getByRole('button', { name: '测试问答（使用额度）' })).toBeDisabled()
  await panel.getByLabel('API 密钥', { exact: true }).fill('synthetic-moma-draft-not-a-real-key')
  await panel.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('mobilecloud')
  await expect(panel.getByLabel('API 密钥', { exact: true })).toHaveValue('synthetic-moma-draft-not-a-real-key')
  expect(mutations).toEqual([])
  await panel.getByRole('button', { name: '关闭 AI 设置' }).click()
  await expect(page).not.toHaveURL(/connect=/)
  await page.goto('/#mindmap')
  await expect(page.getByLabel('文档标题')).toHaveValue(title)
})

test('MoMA direct link stays on MoMA when the first status read fails and the user reconnects', async ({ page }) => {
  let fail = true
  const mutations: string[] = []
  await page.route('**/api/analysis/v1/personal/**', (route) => {
    if (route.request().method() !== 'GET') mutations.push(new URL(route.request().url()).pathname)
    return route.fulfill(fail ? { status: 503, json: { error: 'synthetic-unavailable' } } : { json: { ...connection, providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/', modelId: 'deepseek-flash' } })
  })
  await resetStore(page); await waitForApp(page)
  await page.goto('/?connect=mobilecloud#home')
  const panel = page.getByRole('dialog', { name: '连接移动云 DeepSeek' })
  await expect(panel.getByRole('alert')).toBeVisible()
  fail = false
  await panel.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(panel.getByLabel('API 密钥', { exact: true })).toBeEnabled()
  await expect(panel.getByLabel('AI 服务', { exact: true })).toHaveValue('mobilecloud')
  await expect(panel.getByLabel('AI 模型', { exact: true })).toHaveValue('deepseek-v4-flash-0731')
  await panel.getByLabel('AI 服务', { exact: true }).selectOption('qwen')
  await expect(page.getByRole('dialog', { name: '连接你的 AI' })).toBeVisible()
  expect(mutations).toEqual([])
})
