import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Held fixture' } }) }))
  await page.goto('/'); await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

async function seed(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const { createExampleCourse } = await import('/src/learning/exampleCourse.ts')
    const { updateCourse } = await import('/src/learning/repository.ts')
    const example = await createExampleCourse(); const course = await updateCourse({ ...example, example: false, name: '沉浸流程测试课程' })
    return course.id
  })
}

async function startImmersive(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '开始这次学习', exact: true }).click()
  const layer = page.getByRole('dialog', { name: '沉浸式学习' })
  await expect(layer).toBeVisible()
  return page.locator('[data-immersive-learning]')
}

test('开始引导学习直接进入沉浸层：三段式结构、主动全屏与页面沉浸属性', async ({ page }) => {
  await seed(page)
  const layer = await startImmersive(page)
  await expect(layer).toHaveAttribute('data-native-fullscreen', /true|false/)
  await expect(layer.getByText(/第 1 \/ 3 步/)).toBeVisible()
  await expect(layer.locator('progress[aria-label="学习步骤进度"]')).toHaveAttribute('max', '3')
  await expect(layer.getByRole('button', { name: /进入全屏|退出全屏/ })).toBeVisible()
  await expect(layer.getByRole('button', { name: '退出沉浸' })).toBeVisible()
  await expect(layer.getByRole('button', { name: '结束本次学习' })).toBeVisible()
  await expect(layer.getByRole('button', { name: '完成这一步，下一步', exact: true })).toBeVisible()
  await expect(layer.getByRole('button', { name: '跳过这一步', exact: true })).toBeVisible()
  await expect(layer.getByRole('button', { name: '暂停并保存', exact: true })).toBeVisible()
})

test('Esc 退出沉浸回到工作台摘要卡，可再次进入', async ({ page }) => {
  await seed(page)
  const layer = await startImmersive(page)
  await page.keyboard.press('Escape')
  await expect(layer).toBeHidden()
  const summary = page.locator('[data-session-summary]')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('第 1 / 3 步')
  await summary.getByRole('button', { name: '进入沉浸式学习' }).click()
  await expect(layer).toBeVisible()
})

test('暂停后刷新，首页续学直达沉浸层并保持暂停步骤', async ({ page }) => {
  await seed(page)
  const layer = await startImmersive(page)
  await layer.getByRole('button', { name: '跳过这一步', exact: true }).click()
  await layer.getByLabel('不看说明，我能回忆什么').fill('暂停前的回忆')
  await layer.getByRole('button', { name: '暂停并保存', exact: true }).click()
  await expect(layer.getByRole('heading', { name: '已暂停，下次可从首页继续' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '继续学习', exact: true }).click()
  await expect(layer).toBeVisible()
  await expect(layer.getByRole('heading', { name: '已暂停，下次可从首页继续' })).toBeVisible()
  await layer.getByRole('button', { name: '继续本次学习', exact: true }).click()
  await expect(layer.getByLabel('不看说明，我能回忆什么')).toHaveValue('暂停前的回忆')
})

test('完成题目、回忆和解释后保存本轮记录', async ({ page }) => {
  const courseId = await seed(page)
  const layer = await startImmersive(page)
  await layer.getByRole('radio', { name: '隐藏说明，自己尝试回想', exact: true }).check()
  await layer.getByRole('button', { name: '提交本题', exact: true }).click()
  await expect(layer.getByText('本次回答与参考答案一致。', { exact: true })).toBeVisible()
  await layer.getByRole('button', { name: '完成这一步，下一步', exact: true }).click()
  await layer.getByLabel('不看说明，我能回忆什么').fill('我回忆起了要点')
  await layer.getByRole('button', { name: '完成这一步，下一步', exact: true }).click()
  await layer.getByLabel('用自己的话解释这个知识点').fill('用自己的话完整解释一遍。')
  await layer.getByRole('button', { name: '完成这一步，下一步', exact: true }).click()
  await expect(layer.locator('[data-immersive-done]')).toBeVisible()
  await expect(layer.getByRole('heading', { name: '本次学习全部完成' })).toBeVisible()
  const facts = await page.evaluate(async (id: string) => {
    const { loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const snapshot = await loadCourseSnapshot(id)
    const session = snapshot.sessions.find((item) => item.purpose !== 'exam')
    return { status: session?.status, notes: session?.steps.map((step) => step.note), attempts: snapshot.attempts.length }
  }, courseId)
  expect(facts.status).toBe('completed')
  expect(facts.notes).toContain('我回忆起了要点')
  expect(facts.attempts).toBe(1)
})
