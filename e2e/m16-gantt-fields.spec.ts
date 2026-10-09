import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M16 E2E：甘特任务字段增强（优先级/负责人/备注）+ CSV 导出。
 * 在表格中设置优先级与负责人，在任务编辑器中写备注，导出 CSV 验证字段包含。
 */
test('甘特：设置优先级/负责人/备注，CSV 导出包含对应字段', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 新建空白文档
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('svg g[role=button]').first().waitFor({ timeout: 10000 })

  // 加一个子节点并变为任务
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const ed = page.locator('textarea.node-editor').first()
  await ed.fill('任务A')
  await ed.press('Enter')

  // 切到甘特
  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  await expect(page.locator('#gantt-world')).toBeAttached()

  // 变为任务
  const rowA = page.locator('.gantt-left .gantt-row').nth(1)
  await rowA.locator('.gantt-add').click()

  // 设置优先级为「高」(value=3)
  const prioritySel = rowA.locator('.gantt-priority')
  await prioritySel.selectOption('3')

  // 设置负责人
  const ownerInput = rowA.locator('.gantt-owner')
  await ownerInput.fill('张三')
  await ownerInput.press('Tab')

  // 打开任务编辑器写备注
  await rowA.locator('.gantt-add').click()
  const editor = page.locator('.task-editor')
  await expect(editor).toBeVisible()
  await editor.locator('.te-note').fill('这是一条任务备注')
  await editor.locator('.te-head .tbtn').click()
  await expect(editor).toBeHidden()

  // 导出 CSV：直接取 toGanttCSV 结果验证字段
  const csv = await page.evaluate(async () => {
    const { toGanttCSV } = await import('/src/lib/openFormats.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    return toGanttCSV(useDoc.getState().doc)
  })

  // CSV 表头含新列
  expect(csv).toContain('优先级')
  expect(csv).toContain('负责人')
  expect(csv).toContain('备注')
  // 任务A 行包含：高 / 张三 / 这是一条任务备注
  const lines = csv.replace(/^\ufeff/, '').split('\r\n')
  const taskLine = lines.find((l) => l.includes('任务A'))
  expect(taskLine).toBeDefined()
  expect(taskLine).toContain('高')
  expect(taskLine).toContain('张三')
  expect(taskLine).toContain('这是一条任务备注')
})
