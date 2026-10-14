import { test, expect, resetStore, waitForApp, type Page } from './helpers'
import type { DocData } from '../src/types'
import type { StoredDoc } from '../src/store/db'

/** Read persisted identities without using internal stores or changing IndexedDB. */
async function tutorialSnapshot(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('maosizhi')
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    try {
      const rows = await new Promise<StoredDoc[]>((resolve, reject) => {
        const request = database.transaction('docs', 'readonly').objectStore('docs').getAll()
        request.onsuccess = () => resolve(request.result as StoredDoc[])
        request.onerror = () => reject(request.error)
      })
      return rows.map((row) => {
        const doc = JSON.parse(row.payload) as DocData
        return { id: row.id, title: row.title, payload: row.payload,
          tutorialText: Object.values(doc.nodes).map((node) => `${node.text}\n${node.note ?? ''}`).join('\n') }
      })
    } finally { database.close() }
  })
}

test('最新版教程通过顶部入口复用，保留用户修改并另建，且不发起 AI 调用', async ({ page }) => {
  const analysisMutations: string[] = []
  // Any accidental analysis mutation is recorded and blocked in this ordinary test.
  await page.route('**/api/analysis/v1/**', async (route) => {
    const request = route.request()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) analysisMutations.push(request.method())
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  })
  await resetStore(page)
  await waitForApp(page)

  const tutorial = page.getByRole('button', { name: '使用教程', exact: true })
  await tutorial.click()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
  await expect(page.locator('.doc-tab')).toHaveCount(1)
  const initial = await tutorialSnapshot(page)
  expect(initial).toHaveLength(1)
  const originalId = initial[0].id
  for (const text of ['API 密钥', '起始和结束字符', '摘要', '大纲', '思维导图', '测验', '知识整理', '费用', '备份', '待复习内容', '自测复习', '本次任务开始后暂不能追加其他种类']) {
    expect(initial[0].tutorialText).toContain(text)
  }

  await tutorial.click()
  await expect(page.locator('.doc-tab')).toHaveCount(1)
  expect((await tutorialSnapshot(page)).map((doc) => doc.id)).toEqual([originalId])

  await page.getByLabel('文档标题').fill('我的手写教程笔记')
  await expect.poll(async () => (await tutorialSnapshot(page)).find((doc) => doc.id === originalId)?.title)
    .toBe('我的手写教程笔记')
  const originalPayload = (await tutorialSnapshot(page)).find((doc) => doc.id === originalId)?.payload
  expect(originalPayload).toBeDefined()

  await tutorial.click()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
  await expect(page.locator('.doc-tab')).toHaveCount(2)
  const separated = await tutorialSnapshot(page)
  expect(separated).toHaveLength(2)
  expect(separated.find((doc) => doc.id === originalId)?.payload).toBe(originalPayload)
  const current = separated.find((doc) => doc.id !== originalId)
  expect(current?.title).toBe('欢迎教程')
  expect(current?.tutorialText).toBe(initial[0].tutorialText)

  await tutorial.click()
  await expect(page.locator('.doc-tab')).toHaveCount(2)
  expect((await tutorialSnapshot(page)).map((doc) => doc.id).sort()).toEqual(separated.map((doc) => doc.id).sort())

  await page.getByRole('tab', { name: '我的手写教程笔记', exact: false }).click()
  await expect(page.getByLabel('文档标题')).toHaveValue('我的手写教程笔记')
  await tutorial.click()
  await expect(page.getByLabel('文档标题')).toHaveValue('欢迎教程')
  expect((await tutorialSnapshot(page)).map((doc) => doc.id).sort()).toEqual(separated.map((doc) => doc.id).sort())
  expect((await tutorialSnapshot(page)).find((doc) => doc.id === originalId)?.payload).toBe(originalPayload)
  expect(analysisMutations).toEqual([])
})
