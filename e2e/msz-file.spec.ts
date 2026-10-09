import { test, expect, type Page } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickFileMenu, selectNode } from './helpers'

/**
 * M10（PRD 4.3 P1）：单文件 .msz 模式（File System Access API）。
 * Playwright 无法驱动系统文件选择器，因此注入内存版 mock：
 * showSaveFilePicker/showOpenFilePicker + FileSystemFileHandle/writable，
 * 文件内容保存在页面内 Map。真实浏览器中句柄由平台提供、可结构化克隆持久化。
 */
async function installMockFS(page: Page) {
  await page.addInitScript(() => {
    interface MockHandle {
      kind: 'file'
      name: string
      content: string
      getFile(): Promise<File>
      createWritable(): Promise<unknown>
      queryPermission(): Promise<string>
      requestPermission(): Promise<string>
    }
    const files = new Map<string, MockHandle>()
    let nextOpenName: string | null = null
    let abortSave = false

    const makeHandle = (name: string): MockHandle => {
      const existing = files.get(name)
      const h: MockHandle = {
        kind: 'file',
        name,
        content: existing?.content ?? '',
        async getFile() {
          return new File([h.content], h.name, { type: 'application/json' })
        },
        async createWritable() {
          const parts: string[] = []
          return {
            async write(data: string | Blob) {
              parts.push(typeof data === 'string' ? data : await data.text())
            },
            async close() {
              h.content = parts.join('')
              files.set(name, h)
            },
          }
        },
        async queryPermission() {
          return 'granted'
        },
        async requestPermission() {
          return 'granted'
        },
      }
      return h
    }

    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = async (opts?: {
      suggestedName?: string
    }) => {
      if (abortSave) {
        abortSave = false
        const e = new Error('user cancelled')
        ;(e as Error & { name: string }).name = 'AbortError'
        throw e
      }
      return makeHandle(opts?.suggestedName ?? '未命名.msz')
    }
    ;(window as unknown as Record<string, unknown>).showOpenFilePicker = async () => {
      const name = nextOpenName ?? [...files.keys()].pop()
      nextOpenName = null
      if (!name) {
        const e = new Error('no file')
        ;(e as Error & { name: string }).name = 'AbortError'
        throw e
      }
      return [makeHandle(name)]
    }
    ;(window as unknown as Record<string, unknown>).__mszMock = {
      names: () => [...files.keys()],
      content: (n: string) => files.get(n)?.content ?? null,
      setOpen: (n: string) => {
        nextOpenName = n
      },
      setAbortSave: () => {
        abortSave = true
      },
    }
  })
}

/** 读取/操作页面内 mock 文件系统（evaluate 只传可序列化数据，故按 action 分派） */
async function mockCall(
  page: Page,
  action: 'names',
): Promise<string[]>
async function mockCall(
  page: Page,
  action: 'content',
  name: string,
): Promise<string | null>
async function mockCall(
  page: Page,
  action: 'setOpen' | 'setAbortSave',
  name?: string,
): Promise<void>
async function mockCall(
  page: Page,
  action: 'names' | 'content' | 'setOpen' | 'setAbortSave',
  name?: string,
): Promise<unknown> {
  return page.evaluate(
    ({ action, name }) => {
      const m = (
        window as unknown as {
          __mszMock: {
            names: () => string[]
            content: (n: string) => string | null
            setOpen: (n: string) => void
            setAbortSave: () => void
          }
        }
      ).__mszMock
      if (action === 'names') return m.names()
      if (action === 'content') return m.content(name ?? '')
      if (action === 'setOpen') m.setOpen(name ?? '')
      if (action === 'setAbortSave') m.setAbortSave()
    },
    { action, name },
  )
}

test('另存为 .msz → Ctrl+S 覆写 → 打开 .msz 全流程', async ({ page }) => {
  autoAcceptDialog(page)
  await installMockFS(page)
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input.doc-title').fill('MSZ单文件')
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const editor1 = page.locator('textarea.node-editor').first()
  await editor1.fill('子A')
  await editor1.press('Enter')
  await page.keyboard.press('Enter')
  const editor2 = page.locator('textarea.node-editor').first()
  await editor2.fill('子B')
  await editor2.press('Enter')

  // —— 另存为 .msz ——
  await clickFileMenu(page, /另存为/)
  const toast = page.locator('.file-toast')
  await expect(toast).toContainText('已保存到')
  await expect(toast).toContainText('.msz')
  expect(toast).toBeVisible()

  const names1 = await mockCall(page, 'names')
  expect(names1).toHaveLength(1)
  expect(names1[0]).toMatch(/\.msz$/)
  const content1 = (await mockCall(page, 'content', names1[0])) ?? ''
  expect(content1).not.toBe('')
  const json1 = JSON.parse(content1)
  expect(json1.title).toBe('MSZ单文件')
  expect(json1.version).toBe(3)
  expect(content1).toContain('子A')
  expect(content1).toContain('子B')

  // —— 再加一个子C，Ctrl+S 原地覆写（走内存绑定，不应再弹选择器）——
  await page.keyboard.press('Enter')
  const editor3 = page.locator('textarea.node-editor').first()
  await editor3.fill('子C')
  await editor3.press('Enter')

  await page.keyboard.press('Control+s')
  await expect(page.locator('.file-toast')).toContainText('已保存到')
  const names2 = await mockCall(page, 'names')
  const content2 = await mockCall(page, 'content', names2[0])
  expect(content2).toContain('子C')
  // 仍是同一个文件（没有产生第二个文件）
  expect(names2).toEqual(names1)

  // —— 通过「打开 .msz 文件」重新载入 ——
  await mockCall(page, 'setOpen', names2[0])
  await clickFileMenu(page, /打开/)
  await expect(page.locator('input.doc-title')).toHaveValue('MSZ单文件')
  const canvas = page.locator('svg.canvas-svg')
  await expect(canvas).toContainText('子A')
  await expect(canvas).toContainText('子C')
})

test('保存选择器取消时静默无操作', async ({ page }) => {
  autoAcceptDialog(page)
  await installMockFS(page)
  await resetStore(page)
  await waitForApp(page)

  await mockCall(page, 'setAbortSave')
  await clickFileMenu(page, /另存为/)
  // 无 toast、无文件产生
  await expect(page.locator('.file-toast')).toHaveCount(0)
  expect(await mockCall(page, 'names')).toEqual([])
})

test('不支持 File System Access API 时给出降级提示', async ({ page }) => {
  // Chromium 本身支持；在注入阶段删除两个 picker 模拟 Firefox/Safari
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker
  })
  const dialogMsg = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message())
      d.accept()
    })
  })
  await resetStore(page)
  await waitForApp(page)
  await clickFileMenu(page, /另存为/)
  expect(await dialogMsg).toMatch(/不支持/)
})
