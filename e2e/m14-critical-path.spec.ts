import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M14 E2E：甘特关键路径高亮。
 * 构造 A→B 依赖链，验证关键路径条着色，以及开关切换。
 */

test('甘特关键路径：依赖链上的任务条高亮为关键路径色，开关可切换', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 新建空白文档
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  // 等待导图根节点渲染（上一个用例可能停在甘特视图，重置后首次渲染略慢）
  await page.locator('svg g[role=button]').first().waitFor({ timeout: 10000 })

  // 加两个子节点 A、B
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  let ed = page.locator('textarea.node-editor').first()
  await ed.fill('A')
  await ed.press('Enter')

  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  ed = page.locator('textarea.node-editor').first()
  await ed.fill('B')
  await ed.press('Enter')

  // 切到甘特
  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  await expect(page.locator('#gantt-world')).toBeAttached()

  // 把 A、B 变为任务
  const rowA = page.locator('.gantt-left .gantt-row').nth(1)
  const rowB = page.locator('.gantt-left .gantt-row').nth(2)
  await rowA.locator('.gantt-add').click() // 变为任务
  await rowB.locator('.gantt-add').click()

  // 给 B 加 A 作为前置依赖：打开 B 的任务编辑器
  await rowB.locator('.gantt-add').click() // 📅 打开编辑器
  const editor = page.locator('.task-editor')
  await expect(editor).toBeVisible()
  // 选择 A 作为前置
  await editor.locator('select').selectOption({ label: 'A' })
  // 关闭编辑器
  await editor.locator('.te-head .tbtn').click()
  await expect(editor).toBeHidden()

  // 关键路径开关存在且默认开启
  const toggle = page.locator('.gantt-critical-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveClass(/on/)
  await expect(toggle).toContainText('关键路径')

  // 取 A、B 任务条的填充色（SVG rect fill）
  const getBarFills = async () =>
    page.evaluate(() => {
      // 任务条是 svg 内的 rect，取有 fill 且非透明的条（背景 rect 是 paper 色）
      const rects = Array.from(document.querySelectorAll('#gantt-world rect'))
      return rects
        .filter((r) => {
          const f = r.getAttribute('fill') || ''
          return f && f !== 'none' && f !== 'transparent'
        })
        .map((r) => r.getAttribute('fill'))
    })

  // 开启时：A、B 构成关键路径，条填充色应为关键路径色（深红 #B03A2E，主题中为大写）
  const fillsOn = await getBarFills()
  const isCritical = (f: string | null) => !!f && f.toLowerCase() === '#b03a2e'
  const criticalCount = fillsOn.filter(isCritical).length
  expect(criticalCount).toBeGreaterThanOrEqual(2)

  // 关闭开关：条色变回分支色
  await toggle.click()
  await expect(toggle).not.toHaveClass(/on/)
  const fillsOff = await getBarFills()
  const criticalCountOff = fillsOff.filter(isCritical).length
  expect(criticalCountOff).toBe(0)

  // 再次开启恢复
  await toggle.click()
  await expect(toggle).toHaveClass(/on/)
})
