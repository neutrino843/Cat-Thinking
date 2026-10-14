import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'

const fakeKey = 'public-e2e-key-not-a-credential'
const limits = { maxInputCharacters: 80_000, maxOutputTokens: 4_000, maxRunTokens: 80_000, maxInvocations: 24 }
const initialStatus = {
  version: 1, revision: 0, available: true, enabled: false, configured: false, hasApiKey: false,
  checkState: 'unchecked', acceptsRuns: false, pricingKnown: false, limits,
}
type PublicStatus = typeof initialStatus & {
  providerId?: string; baseUrl?: string; modelId?: string; protocol?: string; structuredOutput?: string; networkMode?: string; messageKey?: string
}

async function settingsFixture(context: BrowserContext) {
  let state: PublicStatus = { ...initialStatus }
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  let failStatus = false
  let unsupportedModels = false
  await context.route('**/api/analysis/v1/personal/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.split('/personal')[1]
    const method = request.method()
    const body = method === 'GET' ? undefined : request.postDataJSON() as Record<string, unknown>
    requests.push({ path, method, body })
    const fulfill = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (failStatus) { await fulfill({ rawUpstreamError: fakeKey }, 503); return }
    if (method === 'GET') { await fulfill(state); return }
    if (path === '/models') {
      await fulfill({ version: 1, models: [{ id: 'text-embedding-public', label: '非文字模型测试' }, { id: 'custom-model-2026', label: '我的自定义模型' }], source: 'provider' })
      return
    }
    if (body?.expectedRevision !== state.revision) { await fulfill({ rawUpstreamError: fakeKey }, 409); return }
    if (path === '/settings' && method === 'PUT') {
      const { providerId, baseUrl, modelId, protocol, structuredOutput, networkMode } = body!
      state = { ...state, revision: state.revision + 1, configured: true, enabled: false,
        hasApiKey: Boolean(body!.apiKey) || state.hasApiKey, acceptsRuns: false, checkState: 'unchecked',
        providerId: String(providerId), baseUrl: String(baseUrl), modelId: String(modelId), protocol: String(protocol),
        structuredOutput: String(structuredOutput), networkMode: String(networkMode) }
    } else if (path === '/check') {
      state = { ...state, revision: state.revision + 1, checkState: unsupportedModels ? 'unchecked' : 'ready',
        ...(unsupportedModels ? { messageKey: 'analysis.personal.models_not_supported' } : {}) }
    } else if (path === '/enable') {
      state = { ...state, revision: state.revision + 1, enabled: true, acceptsRuns: true }
    } else if (path === '/pause') {
      state = { ...state, revision: state.revision + 1, enabled: false, acceptsRuns: false }
    } else if (path === '/settings' && method === 'DELETE') {
      state = { ...initialStatus, revision: state.revision + 1 }
    }
    await fulfill(state)
  })
  return { requests, state: () => state, fail: (value: boolean) => { failStatus = value }, unsupported: () => { unsupportedModels = true } }
}

const panel = (page: Page) => page.getByRole('dialog', { name: '连接你的 AI' })
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  await expect(panel(page).getByLabel('AI 服务', { exact: true })).toBeEnabled()
}

async function browserHasKey(page: Page) {
  return page.evaluate(async (key) => {
    if (JSON.stringify(localStorage).includes(key) || JSON.stringify(sessionStorage).includes(key)) return true
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('maosizhi')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const names = Array.from(database.objectStoreNames)
      if (!names.length) return false
      const transaction = database.transaction(names, 'readonly')
      const values = await Promise.all(names.map((name) => new Promise<unknown[]>((resolve, reject) => {
        const request = transaction.objectStore(name).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
      return JSON.stringify(values).includes(key)
    } finally { database.close() }
  }, fakeKey)
}

test('普通用户连接、手填模型、刷新恢复都不把密钥写入浏览器或自动分析', async ({ page, context }) => {
  const fixture = await settingsFixture(context)
  const analysisMutations: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/analysis/v1/runs') && request.method() !== 'GET') analysisMutations.push(request.method())
  })
  await page.goto('/#mindmap')
  const title = await page.getByLabel('文档标题').inputValue()
  await openSettings(page)
  await expect(panel(page).getByRole('button', { name: 'GPT-6.1 Sol', exact: true })).toBeVisible()
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await panel(page).getByLabel('AI 模型', { exact: true }).fill('my-manual-model')
  await panel(page).getByRole('button', { name: '保存并连接', exact: true }).click()
  await expect(panel(page)).toContainText('已连接，可以开始分析')
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(fixture.requests.filter((request) => request.method !== 'GET').map((request) => [request.path, request.body?.expectedRevision])).toEqual([
    ['/settings', 0], ['/check', 1], ['/enable', 2],
  ])
  expect(fixture.state().modelId).toBe('my-manual-model')
  expect(await browserHasKey(page)).toBe(false)
  await panel(page).getByRole('button', { name: '回到文档', exact: true }).click()
  await expect(page.getByLabel('文档标题')).toHaveValue(title)
  await page.reload(); await openSettings(page)
  await expect(panel(page).getByLabel('AI 模型', { exact: true })).toHaveValue('my-manual-model')
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(await browserHasKey(page)).toBe(false)
  expect(analysisMutations).toEqual([])
})

test('自定义完整 API 地址可先读取模型再保存，读取不产生生成任务', async ({ page, context }) => {
  const fixture = await settingsFixture(context)
  await page.goto('/#mindmap'); await openSettings(page)
  await panel(page).getByLabel('AI 服务', { exact: true }).selectOption('custom')
  await panel(page).getByLabel('API 服务地址').fill('https://example.com/v1/chat/completions')
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await expect(panel(page).getByLabel('AI 模型', { exact: true })).toHaveValue('')
  await panel(page).getByRole('button', { name: '读取可用模型' }).click()
  await expect(panel(page)).toContainText('已读取账号模型列表')
  await expect(panel(page).getByRole('button', { name: '非文字模型测试' })).toHaveCount(0)
  expect(fixture.requests.find((request) => request.path === '/models')?.body).not.toHaveProperty('modelId')
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveValue(fakeKey)
  await expect(panel(page).getByLabel('AI 模型', { exact: true })).toHaveValue('')
  await panel(page).getByRole('button', { name: '我的自定义模型', exact: true }).click()
  await expect(panel(page).getByLabel('AI 模型', { exact: true })).toHaveValue('custom-model-2026')
  expect(await browserHasKey(page)).toBe(false)
  await panel(page).getByRole('button', { name: '只保存，暂不分析' }).click()
  await expect(panel(page)).toContainText('连接已保存，分析保持暂停')
  expect(fixture.state().baseUrl).toBe('https://example.com/v1/chat/completions')
  expect(fixture.state().enabled).toBe(false)
  expect(fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual(['/models', '/settings'])
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(await browserHasKey(page)).toBe(false)
  // Pasting the full Responses endpoint chooses its format without re-entering a same-service key.
  await panel(page).getByLabel('API 服务地址').fill('https://example.com/v1/responses')
  await panel(page).getByRole('button', { name: '保存并连接', exact: true }).click()
  await expect(panel(page)).toContainText('已连接，可以开始分析')
  const lastSave = fixture.requests.filter((request) => request.method === 'PUT').at(-1)!
  expect(lastSave.body?.protocol).toBe('responses')
  expect(lastSave.body).not.toHaveProperty('apiKey')
})

test('暂停和忘记密钥使用当前配置版本，文档保持原样', async ({ page, context }) => {
  const fixture = await settingsFixture(context)
  await page.goto('/#mindmap')
  const title = await page.getByLabel('文档标题').inputValue()
  await openSettings(page)
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await panel(page).getByRole('button', { name: '保存并连接', exact: true }).click()
  await expect(panel(page)).toContainText('已连接，可以开始分析')
  await panel(page).getByRole('button', { name: '暂停新分析' }).click()
  await expect(panel(page)).toContainText('已暂停新的分析')
  expect(fixture.state().acceptsRuns).toBe(false)
  await panel(page).getByRole('button', { name: '删除连接与密钥' }).click()
  await expect(panel(page).getByRole('group', { name: '确认删除 AI 连接' })).toBeVisible()
  await panel(page).getByRole('button', { name: '确认删除连接' }).click()
  await expect(panel(page)).toContainText('本机连接配置和密钥已删除')
  expect(fixture.state().hasApiKey).toBe(false)
  expect(fixture.state().configured).toBe(false)
  await panel(page).getByRole('button', { name: '关闭 AI 设置' }).click()
  await expect(page.getByLabel('文档标题')).toHaveValue(title)
})

test('两处配置冲突不会覆盖更新或自动重新发起连接', async ({ page, context }) => {
  const fixture = await settingsFixture(context)
  const second = await context.newPage()
  await page.goto('/#mindmap'); await second.goto('/')
  await openSettings(page); await openSettings(second)
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await panel(page).getByRole('button', { name: '只保存，暂不分析' }).click()
  await expect(panel(page)).toContainText('连接已保存，分析保持暂停')
  await panel(second).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await panel(second).getByLabel('AI 模型', { exact: true }).fill('should-not-overwrite')
  await panel(second).getByRole('button', { name: '保存并连接', exact: true }).click()
  await expect(panel(second).getByRole('alert')).toContainText('连接配置已在另一处更新')
  expect(fixture.state().modelId).not.toBe('should-not-overwrite')
  expect(fixture.requests.filter((request) => request.path === '/check' || request.path === '/enable')).toEqual([])
  await panel(second).getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(panel(second).getByLabel('AI 模型', { exact: true })).toHaveValue(fixture.state().modelId!)
  await second.close()
})

test('未启动服务给出可执行说明，不展示服务端错误中的密钥', async ({ page, context }) => {
  const fixture = await settingsFixture(context); fixture.fail(true)
  await page.goto('/#mindmap')
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  await expect(panel(page).getByRole('alert')).toContainText('启动猫思之')
  await expect(panel(page)).not.toContainText(fakeKey)
  await expect(panel(page).getByRole('button', { name: '保存并连接', exact: true })).toBeDisabled()
  fixture.fail(false)
  await panel(page).getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(panel(page).getByLabel('AI 服务', { exact: true })).toBeEnabled()
})

test('不提供模型列表的服务需要用户明确选择手填模型连接', async ({ page, context }) => {
  const fixture = await settingsFixture(context); fixture.unsupported()
  await page.goto('/#mindmap'); await openSettings(page)
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  await panel(page).getByLabel('AI 模型', { exact: true }).fill('public-manual-model')
  await panel(page).getByRole('button', { name: '保存并连接', exact: true }).click()
  await expect(panel(page)).toContainText('这个服务未提供模型列表')
  expect(fixture.requests.some((request) => request.path === '/enable')).toBe(false)
  await panel(page).getByRole('button', { name: '使用手填模型连接' }).click()
  await expect(panel(page)).toContainText('手填模型已连接')
  expect(fixture.requests.filter((request) => request.path === '/enable')).toHaveLength(1)
  expect(fixture.state().modelId).toBe('public-manual-model')
})

test('统一管理模式只展示状态，不能编辑密钥或绕过发布限制', async ({ page, context }) => {
  await context.route('**/api/analysis/v1/personal/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...initialStatus, available: false }) }))
  await page.goto('/#mindmap')
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  await expect(panel(page)).toContainText('由管理员管理连接')
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: '保存并连接', exact: true })).toHaveCount(0)
})

test('设置面板约束键盘焦点，Escape 返回当前文档并清除尚未保存的密钥', async ({ page, context }) => {
  await settingsFixture(context)
  await page.goto('/#mindmap'); await openSettings(page)
  const title = await page.getByLabel('文档标题').inputValue()
  await panel(page).getByLabel('API 密钥', { exact: true }).fill(fakeKey)
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog.ai-settings-panel')))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(page.getByLabel('文档标题')).toHaveValue(title)
  await expect(page.getByRole('button', { name: 'AI 设置', exact: true })).toBeFocused()
  await openSettings(page)
  await expect(panel(page).getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(await browserHasKey(page)).toBe(false)
})

test('从分析面板打开连接设置后返回当前文档，并恢复常驻工具栏焦点', async ({ page, context }) => {
  await settingsFixture(context)
  await context.route('**/api/analysis/v1/capabilities', (route) => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: 'public synthetic unavailable fixture' }) }))
  await page.goto('/#mindmap')
  const title = await page.getByLabel('文档标题').inputValue()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  const analysis = page.getByRole('dialog', { name: 'AI 学习分析' })
  await analysis.getByRole('button', { name: '连接 AI', exact: true }).click()
  await expect(panel(page).getByLabel('AI 服务', { exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(analysis).toBeHidden()
  await expect(page.getByRole('button', { name: 'AI 设置', exact: true })).toBeFocused()
  await expect(page.getByLabel('文档标题')).toHaveValue(title)
})

test('旧过滤控件、文档标签与设置输入在两种主题中采用同一键盘焦点色', async ({ page, context }, testInfo) => {
  await settingsFixture(context)
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 设置', exact: true })).toBeVisible()
  const checkFocus = async (control: Locator) => {
    await control.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(control).toBeFocused()
    const focus = await control.evaluate((element) => {
      const reference = document.createElement('span')
      reference.style.color = 'var(--color-focus)'
      document.body.append(reference)
      const expectedColor = getComputedStyle(reference).color
      reference.remove()
      const style = getComputedStyle(element)
      return { expectedColor, color: style.outlineColor, style: style.outlineStyle,
        width: style.outlineWidth, focusVisible: element.matches(':focus-visible') }
    })
    expect(focus.focusVisible).toBe(true)
    expect(focus.color).toBe(focus.expectedColor)
    expect(focus.style).toBe('solid')
    expect(focus.width).toBe('3px')
  }
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换到深色模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await checkFocus(page.getByLabel('按标签过滤', { exact: true }))
    if (theme === 'dark') await testInfo.attach('workbench-dark-focused-filter', { body: await page.screenshot(), contentType: 'image/png' })
    await checkFocus(page.locator('.doc-tab.active'))
    await openSettings(page)
    await checkFocus(panel(page).getByLabel('API 密钥', { exact: true }))
    if (theme === 'dark') await testInfo.attach('settings-dark-focused-input', { body: await page.screenshot(), contentType: 'image/png' })
    await panel(page).getByRole('button', { name: '关闭 AI 设置', exact: true }).click()
  }
})

test('新野兽工作台与设置在四种窄屏宽度没有页面横向溢出', async ({ page, context }, testInfo) => {
  await settingsFixture(context)
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#mindmap')
    const fileMenu = page.locator('details.tmenu', { hasText: '文件 ▾' })
    await fileMenu.locator('summary').click()
    const openFile = fileMenu.getByRole('button', { name: '打开 .msz 文件…', exact: true })
    await openFile.scrollIntoViewIfNeeded()
    expect(await openFile.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === button || button.contains(hit)
    })).toBe(true)
    await fileMenu.locator('summary').click()
    await expect.poll(() => fileMenu.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false)
    const exportMenu = page.locator('details.tmenu', { hasText: '导出 ▾' })
    await exportMenu.locator('summary').click()
    const downloadPending = page.waitForEvent('download')
    await exportMenu.getByRole('button', { name: 'JSON（完整数据）', exact: true }).click()
    const download = await downloadPending
    expect(download.suggestedFilename()).toMatch(/\.json$/u)
    expect(await download.failure()).toBeNull()
    await expect.poll(() => exportMenu.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false)
    await openSettings(page)
    await expect(panel(page).getByLabel('AI 服务', { exact: true })).toBeVisible()
    const dimensions = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.ai-settings-panel')!
      const rect = dialog.getBoundingClientRect()
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right,
        childrenFit: Array.from(dialog.querySelectorAll('input,select,button')).every((element) => {
          const child = element.getBoundingClientRect()
          return child.width === 0 || child.left >= rect.left && child.right <= rect.right
        }) }
    })
    expect(dimensions.pageWidth).toBeLessThanOrEqual(width)
    expect(dimensions.left).toBeGreaterThanOrEqual(0)
    expect(dimensions.right).toBeLessThanOrEqual(width)
    expect(dimensions.childrenFit).toBe(true)
    await testInfo.attach(`settings-${width}px`, { body: await page.screenshot(), contentType: 'image/png' })
    await panel(page).getByRole('button', { name: '关闭 AI 设置' }).click()
  }
})
