import { test, expect, type Page } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M11（PRD 4.1.7 P1）：按标签过滤「仅显示命中分支」。
 * 标签维度：命中节点 + 祖先链可见，无关分支隐藏；清除后恢复。
 * （状态维度的判定与裁剪由 src/lib/filter.test.ts 单测覆盖。）
 */

/** 微拖拽选中文本匹配的节点（只选中、不进入编辑） */
async function selectByText(page: Page, text: string) {
  const loc = page.locator('svg g[role=button]', { hasText: text })
  const box = await loc.boundingBox()
  if (!box) throw new Error(`找不到节点 ${text}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 6, y + 6, { steps: 3 })
  await page.mouse.up()
}

test('标签过滤：只显示命中分支，清除恢复', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('input.doc-title').fill('过滤测试')

  // 建甲方
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const ed1 = page.locator('textarea.node-editor').first()
  await ed1.fill('甲方')
  await ed1.press('Enter')

  // 此时选中甲方（单选）→ NodePanel 加标签「客户」
  await page.locator('.msz-np-tag-add input').fill('客户')
  await page.locator('.msz-np-tag-add').getByRole('button', { name: '添加' }).click()
  // 过滤下拉立刻出现该标签选项（collectTagTexts 实时派生）
  await expect(page.locator('.filter-bar select').first().locator('option', { hasText: '客户' })).toHaveCount(1)

  // 回到画布：甲方的兄弟乙方
  await selectByText(page, '甲方')
  await page.keyboard.press('Enter')
  const ed2 = page.locator('textarea.node-editor').first()
  await ed2.fill('乙方')
  await ed2.press('Enter')

  // 过滤前两个分支都在
  await expect(page.locator('svg g[role=button]', { hasText: '乙方' })).toHaveCount(1)

  // 应用标签过滤
  await page.locator('.filter-bar select').first().selectOption({ label: '客户' })
  await expect(page.locator('.filter-bar')).toHaveClass(/active/)
  await expect(page.locator('svg g[role=button]', { hasText: '甲方' })).toHaveCount(1)
  await expect(page.locator('svg g[role=button]', { hasText: '乙方' })).toHaveCount(0)
  // 根（祖先链）保留；命中非根节点计数 = 1
  await expect(page.locator('.filter-count')).toContainText('1 个节点')

  // 标签下拉里应能选回「全部标签」
  await page.locator('.filter-bar select').first().selectOption({ label: '全部标签' })
  await expect(page.locator('.filter-bar')).not.toHaveClass(/active/)
  await expect(page.locator('svg g[role=button]', { hasText: '乙方' })).toHaveCount(1)
  await expect(page.locator('svg g[role=button]', { hasText: '甲方' })).toHaveCount(1)
})

test('过滤状态下切文档自动重置过滤', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 用状态维度激活过滤（不依赖模板数据）：只看里程碑
  await page.locator('.filter-bar select').nth(1).selectOption({ label: '里程碑' })
  await expect(page.locator('.filter-bar')).toHaveClass(/active/)

  // 新建文档即切换：过滤必须重置
  await page.getByRole('button', { name: '新建文档' }).click()
  await expect(page.locator('.tpl-menu')).toBeVisible()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await expect(page.locator('.filter-bar')).not.toHaveClass(/active/)
  expect(await page.locator('.filter-bar select').nth(1).inputValue()).toBe('')
})
