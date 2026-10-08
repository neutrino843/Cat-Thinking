import { test, expect, type Page } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M11（PRD 4.4 P1）：多选批量操作。
 * 真实 Ctrl + 微拖拽增选（避免单击已选节点进入文本编辑），
 * 验证批量改色、批量加标签，以及两步撤销整体回退。
 */
async function ctrlAddNode(page: Page, text: string) {
  const loc = page.locator('svg g[role=button]', { hasText: text })
  const box = await loc.boundingBox()
  if (!box) throw new Error(`找不到节点 ${text}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.keyboard.down('Control')
  await page.mouse.down()
  // 移动 >4px 走 moved 分支：只增选、不进编辑
  await page.mouse.move(x + 6, y + 6, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.up('Control')
}

async function clickEmpty(page: Page) {
  const p = await page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll('svg g[role=button]')).map((n) =>
      n.getBoundingClientRect(),
    )
    // 从工具栏下方开始扫描，避免误点工具栏按钮（如 Ctrl+K 打开命令面板）
    for (let cy = 100; cy < window.innerHeight - 24; cy += 20) {
      for (let cx = window.innerWidth - 40; cx > window.innerWidth / 2; cx -= 20) {
        if (!rects.some((b) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)) {
          return { x: cx, y: cy }
        }
      }
    }
    return null
  })
  if (!p) throw new Error('找不到空白点')
  await page.mouse.click(p.x, p.y)
}

test('多选批量改色 + 批量加标签，整体可撤销', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 新建空白文档并改名
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('input.doc-title').fill('批量测试')

  // root → 甲（子）→ 乙（兄弟），节奏同 msz-file 用例
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const ed1 = page.locator('textarea.node-editor').first()
  await ed1.fill('甲方')
  await ed1.press('Enter')
  await page.keyboard.press('Enter')
  const ed2 = page.locator('textarea.node-editor').first()
  await ed2.fill('乙方')
  await ed2.press('Enter')

  await clickEmpty(page)
  await ctrlAddNode(page, '甲方')
  await ctrlAddNode(page, '乙方')

  // 批量面板出现
  await expect(page.locator('.msz-node-panel')).toContainText('批量操作')
  await expect(page.locator('.msz-node-panel')).toContainText('已选 2 个节点')

  // 批量改色：第 4 个分支色（b3）
  await page.locator('.msz-np-color-btn.branch').nth(3).click()
  await expect(page.locator('svg g[data-color="b3"]')).toHaveCount(2)
  expect(
    await page.locator('svg g[data-color="b3"]', { hasText: '甲方' }).count(),
  ).toBe(1)
  expect(
    await page.locator('svg g[data-color="b3"]', { hasText: '乙方' }).count(),
  ).toBe(1)

  // 批量加标签（标签在画布上渲染为蓝色小圆点 #1e88e5，文本不出现在 SVG）
  await page.locator('.msz-np-tag-add input').fill('重点客户')
  await page.getByRole('button', { name: '全部添加' }).click()
  await expect(page.locator('svg.canvas-svg g[data-color="b3"] circle[fill="#1e88e5"]')).toHaveCount(2)

  // 两步撤销：先标签、后配色
  await clickEmpty(page)
  await page.keyboard.press('Control+z')
  await expect(page.locator('svg.canvas-svg g[data-color="b3"] circle[fill="#1e88e5"]')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.locator('svg g[data-color="b3"]')).toHaveCount(0)

  // 节点仍在，只是颜色/标签回退
  await expect(page.locator('svg.canvas-svg')).toContainText('甲方')
  await expect(page.locator('svg.canvas-svg')).toContainText('乙方')
})
