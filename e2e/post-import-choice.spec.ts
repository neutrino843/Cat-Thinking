import { expect, test } from '@playwright/test'

const file = (name: string, body: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body, 'utf8') })

const importFromHome = async (page: import('@playwright/test').Page) => {
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles(file('网络基础.txt', '第一章 网络基础\n\n网络连接设备并交换数据。\n\n第二章 协议\n\n协议约定通信规则。'))
  const preview = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  const choice = page.getByRole('dialog', { name: '资料已加入课程，下一步' })
  await expect(choice).toBeVisible()
  return choice
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Held fixture' } }) }))
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

test('三选一层提供思维导图、直接学习、回首页三个入口', async ({ page }) => {
  const choice = await importFromHome(page)
  await expect(choice.getByRole('button', { name: /查看思维导图/ })).toBeVisible()
  await expect(choice.getByRole('button', { name: /直接开始学习/ })).toBeVisible()
  await expect(choice.getByRole('button', { name: /回到学习首页/ })).toBeVisible()
})

test('选择查看思维导图后直接进入导图编辑器', async ({ page }) => {
  const choice = await importFromHome(page)
  await choice.getByRole('button', { name: /查看思维导图/ }).click()
  await expect(choice).toBeHidden()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 网络基础')
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 协议')
})

test('选择直接开始学习后进入中央原文学习区', async ({ page }) => {
  const choice = await importFromHome(page)
  await choice.getByRole('button', { name: /直接开始学习/ }).click()
  await expect(page.getByRole('main', { name: '原文入门学习' })).toBeVisible()
  await expect(page.getByRole('region', { name: '第一道入门题' })).toBeVisible()
})

test('选择回到首页后底部保留导图入口，可打开也可关闭', async ({ page }) => {
  const choice = await importFromHome(page)
  await choice.getByRole('button', { name: /回到学习首页/ }).click()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  const bar = page.getByRole('region', { name: '思维导图入口' })
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('网络基础')

  await bar.getByRole('button', { name: '关闭导图入口' }).click()
  await expect(bar).toBeHidden()
})

test('底部导图入口的打开按钮进入导图编辑器', async ({ page }) => {
  const choice = await importFromHome(page)
  await choice.getByRole('button', { name: /回到学习首页/ }).click()
  await page.getByRole('region', { name: '思维导图入口' }).getByRole('button', { name: '打开思维导图' }).click()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 网络基础')
})

test('多文件串行导入时三选一层只在最后一份确认后出现', async ({ page }) => {
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles([
    file('甲.txt', '第一章 甲\n\n甲的内容。'),
    file('乙.txt', '第二章 乙\n\n乙的内容。'),
  ])
  const preview = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('甲.txt')
  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()

  await expect(preview).toBeVisible()
  await expect(preview).toContainText('乙.txt')
  await expect(page.getByRole('dialog', { name: '资料已加入课程，下一步' })).toHaveCount(0)

  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  const choice = page.getByRole('dialog', { name: '资料已加入课程，下一步' })
  await expect(choice).toBeVisible()
})
