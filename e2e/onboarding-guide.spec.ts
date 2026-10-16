import { expect, test, type Page } from '@playwright/test'

const text = '第一章 植物的能量\n\n光合作用把光能转化为化学能，并释放氧气。\n\n植物需要适合的光照条件。'
const guide = (page: Page) => page
async function start(page: Page) {
  await page.getByRole('button', { name: /开始使用 · 伊希斯/ }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}').step)).toBe('import')
}
async function preview(page: Page) {
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles({ name: '我的植物资料.txt', mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') })
  await expect(page.getByRole('dialog', { name: '从文档生成可编辑导图' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}').step)).toBe('preview')
}
async function read(page: Page) {
  await preview(page)
  await page.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  await expect(guide(page).getByRole('region', { name: '第一道入门题' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '资料已加入课程，下一步' })).toHaveCount(0)
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', message: 'Isolated onboarding test' } }) }))
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

test('first-time user imports their own source and submits a real literal exercise without model requests', async ({ page }) => {
  const posts: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()) })
  await start(page)
  await expect(page.getByLabel('导入课程资料', { exact: true })).not.toHaveAttribute('multiple', '')
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('button', { name: '定位操作', exact: true }).click()
  await expect(page.locator('[data-guide="import"]')).toBeFocused()
  await read(page)
  await expect(guide(page).getByRole('region', { name: '第一道入门题' })).toContainText('（____）把光能转化')
  await guide(page).getByLabel('填入空缺的原词').fill('光合作用')
  await guide(page).getByRole('button', { name: '提交第一题', exact: true }).click()
  await expect(guide(page).getByRole('region', { name: '第一题结果' })).toContainText('和原文一致')
  await guide(page).getByRole('button', { name: '去课程继续学习' }).click()
  await expect(page.getByRole('region', { name: '准备继续学习' })).toBeVisible()
  await expect(page.getByRole('button', { name: '先读原文，写自己的理解' })).toBeVisible()
  const saved = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    return { sources: (await db.sources.toArray()).map((s) => s.text), progress: JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}') }
  })
  expect(saved.sources).toContain(text); expect(saved.progress.status).toBe('completed'); expect(saved.progress.outcome).toBe('match')
  expect(posts).toEqual([])
  await page.screenshot({ path: '../reports/isis-guide-desktop.png', fullPage: true })
})

test('draft answer and paused step survive reload; viewing the original is recorded as help', async ({ page }) => {
  await start(page); await read(page)
  await guide(page).getByLabel('填入空缺的原词').fill('光合')
  await page.getByRole('main', { name: '原文入门学习' }).getByRole('button', { name: '暂停并保存', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('dialog', { name: '与伊希斯对话' }).getByRole('button', { name: '更多对话' }).click()
  await page.getByRole('dialog', { name: '与伊希斯对话' }).getByRole('button', { name: '继续引导', exact: true }).click()
  await expect(guide(page).getByLabel('填入空缺的原词')).toHaveValue('光合')
  await guide(page).getByRole('button', { name: '需要帮助，查看相关段落' }).click(); await guide(page).getByRole('button', { name: '进入独立阅读' }).click()
  await expect(page.getByRole('dialog', { name: '独立阅读' }).locator('[data-reader-text]')).toContainText('光合作用')
  await page.keyboard.press('Escape')
  await guide(page).getByRole('button', { name: '提交第一题', exact: true }).click()
  await expect(guide(page).getByRole('region', { name: '第一题结果' })).toContainText('借助原文完成')
  await expect(guide(page).getByRole('region', { name: '第一题结果' })).toContainText('第一道题已完成')
})

test('cancelled or failed imports keep the guide at import and can be retried', async ({ page }) => {
  await start(page); await preview(page)
  await page.getByRole('dialog', { name: '从文档生成可编辑导图' }).getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}').step)).toBe('import')
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('broken') })
  await expect(page.getByRole('alert').filter({ hasText: 'PDF 文件签名无效' })).toBeVisible()
  await read(page)
})

test('scripted chat and help export identify the blocked step without leaking document or chat text', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('button', { name: '更多对话' }).click()
  await guide(page).getByRole('button', { name: '找不到入口', exact: true }).click()
  await guide(page).getByLabel('对伊希斯说', { exact: true }).fill('PRIVATE_CHAT 请给我解释量子力学')
  await guide(page).getByRole('button', { name: '发送', exact: true }).click()
  await expect(guide(page).getByLabel('与伊希斯的对话')).toContainText('还不能像 AI 一样理解任意问题')
  await guide(page).getByRole('button', { name: '更多对话' }).click(); await guide(page).getByRole('button', { name: '会收费吗', exact: true }).click()
  await expect(guide(page).getByLabel('与伊希斯的对话')).toContainText('不调用模型')
  await guide(page).getByRole('button', { name: '更多对话' }).click(); await guide(page).getByRole('button', { name: '引导复盘', exact: true }).click()
  const downloading = page.waitForEvent('download')
  await guide(page).getByRole('button', { name: '导出复盘记录' }).click()
  const download = await downloading
  const stream = await download.createReadStream()
  let exported = ''
  if (stream) for await (const chunk of stream) exported += chunk.toString('utf8')
  expect(exported).toContain('找不到入口'); expect(exported).toContain('导入资料'); expect(exported).not.toContain('PRIVATE_CHAT'); expect(exported).not.toContain(text)
})

for (const width of [320, 375]) test(`guide leaves import confirmation usable and fits ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 })
  await start(page); await read(page)
  expect(await page.locator('[data-isis-guide]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })).toBe(true)
  await guide(page).getByLabel('填入空缺的原词').fill('光合作用')
  await guide(page).getByRole('button', { name: '提交第一题', exact: true }).click()
  await expect(guide(page).getByRole('region', { name: '第一题结果' })).toBeVisible()
  await page.screenshot({ path: `../reports/isis-guide-${width}.png`, fullPage: true })
})

test('source deletion blocks grading instead of submitting against stale content', async ({ page }) => {
  await start(page); await read(page)
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const p = JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}')
    await db.sources.delete(p.binding.sourceId)
  })
  await expect(guide(page).getByRole('alert')).toContainText('资料已被删除或修改')
  await expect(guide(page).getByRole('button', { name: '提交第一题', exact: true })).toHaveCount(0)
})

test('the companion follows navigation without treating a page switch as a completed action', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '思维导图与甘特图', exact: true }).click()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}').step)).toBe('import')
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('button', { name: '定位操作', exact: true }).click()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}').step)).toBe('import')
})

test('pausing before import releases ordinary batch import without adopting those documents', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '打开伊希斯新手引导' }).click()
  await page.getByRole('dialog', { name: '与伊希斯对话' }).getByRole('button', { name: '更多对话' }).click(); await page.getByRole('dialog', { name: '与伊希斯对话' }).getByRole('button', { name: '暂停引导', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('导入课程资料', { exact: true })).toHaveAttribute('multiple', '')
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles([
    { name: '甲.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    { name: '乙.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
  ])
  const preview = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  await expect(preview).toContainText('乙.txt')
  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '资料已加入课程，下一步' })).toBeVisible()
  const p = await page.evaluate(() => JSON.parse(localStorage.getItem('msz.isis-guide.v1') ?? '{}'))
  expect(p.status).toBe('paused'); expect(p.step).toBe('import'); expect(p.binding).toBeNull()
})
