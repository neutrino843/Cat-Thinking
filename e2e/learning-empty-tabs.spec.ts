import { expect, test } from '@playwright/test'

/**
 * v2.1 需求2：无课程状态下学习工作台的标签切换。
 * 旧实现中所有功能面板都被 snapshot 门控，未建课程时点击
 * 「学习/知识/练习/备考」始终停留在同一份资料引导空态，看起来像界面卡死。
 * 现在每个标签都有可响应的专属空态，建课后停留当前标签进入对应面板。
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Held fixture' } }) }))
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await page.getByRole('button', { name: '我的课程', exact: true }).click()
  await expect(page.getByRole('region', { name: '课程学习工作台' })).toBeVisible()
})

const TAB_CASES = [
  { tab: '学习', view: 'today', heading: '还没有可学习的课程' },
  { tab: '知识', view: 'knowledge', heading: '知识图谱还是空的' },
  { tab: '练习', view: 'practice', heading: '暂时没有可练习的内容' },
  { tab: '备考', view: 'exam', heading: '备考需要先有课程' },
  { tab: '资料', view: 'materials', heading: '先给资料一个归属' },
]

test('无课程：五个标签逐个切换均渲染对应空态，不再卡在资料界面', async ({ page }) => {
  // 「我的课程」入口以资料为导航目标；重点是之后每个标签都能正常切换
  await expect(page.locator('.learning-empty')).toHaveAttribute('data-empty-view', 'materials')
  for (const item of TAB_CASES) {
    await page.getByRole('button', { name: item.tab, exact: true }).click()
    await expect(page.locator('.learning-empty')).toHaveAttribute('data-empty-view', item.view)
    await expect(page.getByRole('heading', { name: item.heading })).toBeVisible()
    // 被激活标签需要有明确的选中态
    await expect(page.getByRole('button', { name: item.tab, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
})

test('无课程：空态主按钮聚焦建课表单；建课后停留当前标签并进入练习面板', async ({ page }) => {
  await page.getByRole('button', { name: '练习', exact: true }).click()
  await expect(page.locator('.learning-empty')).toHaveAttribute('data-empty-view', 'practice')

  await page.getByRole('button', { name: '立即创建课程', exact: true }).click()
  await expect(page.locator('#new-learning-course')).toBeFocused()

  await page.locator('#new-learning-course').fill('标签练习课')
  await page.getByRole('button', { name: '创建课程', exact: true }).click()

  // 空态消失、课程已选中、仍停留在练习标签且练习面板已挂载
  await expect(page.locator('.learning-empty')).toHaveCount(0)
  await expect(page.getByLabel('当前课程')).toHaveValue(/.+/)
  await expect(page.getByRole('button', { name: '练习', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: '课程题库' })).toBeVisible()
})
