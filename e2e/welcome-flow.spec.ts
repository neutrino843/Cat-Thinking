import { expect, test, resetStore } from './helpers'

/**
 * v2.1 需求1：欢迎教程引导流程统一到学习首页。
 * - 首启出现欢迎引导卡片，「开始使用」写入已见标记，刷新后不再出现；
 * - 首页「使用教程」入口只准备教程文档，用户始终留在学习首页，
 *   轻提示中的「查看教程导图」才进入编辑器（上下文策略：editor 入口仍直接打开导图）；
 * - 复用/另建契约（getOrCreateLatestTutorial）不因落地首页而破坏。
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Held fixture' } }) }))
  await resetStore(page)
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

test('首启出现欢迎卡片，开始使用后关闭且刷新不再出现', async ({ page }) => {
  const card = page.locator('[data-welcome-card]')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: /开始使用 · 伊希斯/ })).toBeVisible()

  await card.getByRole('button', { name: /开始使用 · 伊希斯/ }).click()
  await expect(card).toHaveCount(0)
  const flag = await page.evaluate(() => localStorage.getItem('msz.welcome.dismissed.v1'))
  expect(flag).toBe('1')

  await page.reload()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await expect(page.locator('[data-welcome-card]')).toHaveCount(0)
})

test('欢迎卡片「查看完整使用教程」主动进入编辑器打开教程导图', async ({ page }) => {
  await page.getByRole('button', { name: '使用教程', exact: true }).click()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
  await expect(page).toHaveURL(/#mindmap$/)
})

test('首页「使用教程」留在学习首页，教程已入库，轻提示可进入教程导图', async ({ page }) => {
  await expect(page.locator('header.toolbar')).toHaveCount(0)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('dialog', { name: '更多功能', exact: true }).getByRole('button', { name: '使用教程', exact: true }).click()

  // 不被弹去编辑器
  await expect(page).toHaveURL(/#home$/)
  await expect(page.locator('[data-study-home]')).toBeVisible()
  await expect(page.locator('header.toolbar')).toHaveCount(0)

  const hint = page.locator('[data-tutorial-hint]')
  await expect(hint).toBeVisible()
  await hint.getByRole('button', { name: '查看教程导图', exact: true }).click()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
})

test('手改教程后从首页再次进入：另建最新教程，复用契约不破坏', async ({ page }) => {
  // 第一次：从首页准备教程并进入编辑器做手写批注
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('dialog', { name: '更多功能', exact: true }).getByRole('button', { name: '使用教程', exact: true }).click()
  await page.locator('[data-tutorial-hint]').getByRole('button', { name: '查看教程导图', exact: true }).click()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
  await page.getByLabel('文档标题').fill('我的教程批注')
  // 自动保存为全局 700ms 防抖：切文档前先等手写标题落盘，避免 pending 被新文档顶掉
  await expect.poll(async () => {
    const rows = await page.evaluate(async () => (await import('/src/store/db.ts')).db.docs.toArray())
    return rows.some((row) => row.title === '我的教程批注')
  }, { timeout: 5000 }).toBe(true)

  // 回到学习首页，再次点「使用教程」：被改过的教程保留，另建一篇最新教程
  await page.getByRole('button', { name: '学习首页', exact: true }).click()
  await expect(page.locator('[data-study-home]')).toBeVisible()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('dialog', { name: '更多功能', exact: true }).getByRole('button', { name: '使用教程', exact: true }).click()
  await expect(page.locator('[data-study-home]')).toBeVisible()

  await expect.poll(async () => {
    const rows = await page.evaluate(async () => (await import('/src/store/db.ts')).db.docs.toArray())
    return rows.map((row) => row.title).sort().join('|')
  }, { timeout: 5000 }).toBe('我的教程批注|欢迎教程')
})
