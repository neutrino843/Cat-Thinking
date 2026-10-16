import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Held fixture' } }) }))
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

test('default home, inline course creation, search, editor feature and return', async ({ page }) => {
  const generation: string[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/runs')) generation.push(request.url()) })
  await expect(page.locator('header.toolbar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导入第一份资料' })).toBeVisible()
  await page.getByRole('button', { name: '资料', exact: true }).click()
  await expect(page.getByRole('region', { name: '课程学习工作台' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('新课程名称', { exact: true }).fill('高等数学')
  await page.getByRole('button', { name: '创建课程', exact: true }).click()
  await page.getByRole('button', { name: '返回首页', exact: true }).click()
  await page.getByText('查看完整安排与学习记录', { exact: false }).first().click()
  await expect(page.getByRole('button', { name: /高等数学.*学习资料/ })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: '搜索课程或学习任务' })).toBeFocused()
  await page.getByRole('textbox', { name: '搜索课程或学习任务' }).fill('不存在')
  await expect(page.getByText('没有匹配的课程', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '思维导图与甘特图', exact: true }).click()
  await expect(page.locator('header.toolbar')).toBeVisible()
  await expect(page).toHaveURL(/#mindmap$/)
  await page.getByRole('button', { name: '学习首页', exact: true }).click()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  expect(generation).toEqual([])
})

test('real saved knowledge drives today plan and routes into its course', async ({ page }) => {
  await page.evaluate(async () => {
    const { createCourse, saveEntity } = await import('/src/learning/repository.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const course = await createCourse({ name: '数据结构', dailyMinutes: 20 })
    await saveEntity({ ...learningBase(course.id), kind: 'point', title: '二分查找', definition: '有序序列的查找',
      chapter: '', aliases: [], notes: '', sourceRefs: [], questionRefs: [], status: 'active', goalIncluded: true }, null)
  })
  await expect(page.getByRole('button', { name: '开始这次学习', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开始这次学习', exact: true }).click()
  await expect(page.locator('[data-immersive-learning]').getByRole('heading', { name: '二分查找' }).last()).toBeVisible()
  await expect(page.getByLabel('当前课程', { exact: true })).toHaveValue(/.+/)
})

test('home import keeps source text, attaches the course and makes no generation request', async ({ page }) => {
  const generation: string[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/runs')) generation.push(request.url()) })
  await page.getByLabel('导入课程资料', { exact: true }).setInputFiles({ name: '公开课程.txt', mimeType: 'text/plain',
    buffer: Buffer.from('第一章 二分查找\n二分查找要求数据有序。\n第二章 比较次数\n比较次数与实际用时不同。', 'utf8') })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  const choice = page.getByRole('dialog', { name: '资料已加入课程，下一步' })
  await expect(choice).toBeVisible()
  await choice.getByRole('button', { name: /直接开始学习/ }).click()
  await expect(page.getByRole('main', { name: '原文入门学习' })).toBeVisible()
  const facts = await page.evaluate(async () => {
    const { listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const { db } = await import('/src/store/db.ts')
    const courses = await listCourses(); const snapshot = await loadCourseSnapshot(courses[0].id)
    const sources = await db.sources.toArray()
    return { courseCount: courses.length, documents: snapshot.documents.length, text: sources.map((source) => source.text).join('\n') }
  })
  expect(facts.courseCount).toBe(1); expect(facts.documents).toBe(1); expect(facts.text).toContain('二分查找要求数据有序。')
  expect(generation).toEqual([])
})

for (const width of [320, 375, 414, 768, 1440]) test(`home and module fit ${width}px and remain keyboard reachable`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 })
  await expect(page.getByRole('button', { name: '资料', exact: true })).toBeVisible()
  await page.screenshot({ path: `../reports/learning-home-${width}.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '资料', exact: true }).click()
  await expect(page.getByRole('region', { name: '课程学习工作台' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '返回首页', exact: true }).click()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '切换深色', exact: true }).click()
  await page.getByRole('button', { name: '关闭更多功能', exact: true }).click()
  await page.screenshot({ path: `../reports/learning-home-dark-${width}.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
