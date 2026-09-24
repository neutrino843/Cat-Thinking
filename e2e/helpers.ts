import { test as base, expect, type Page } from '@playwright/test'

/**
 * E2E 公共工具：清空 localStorage + 删除 IndexedDB 'maosizhi'，再打开干净首页。
 * 关键坑：
 * 1. App 打开 Dexie 连接期间 deleteDatabase 会被 blocked（页面内无法关闭模块内实例）；
 * 2. 若先 goto('/') 再导航走，App 的 async 初始化可能与导航产生竞态（listDocs 失败
 *    被 catch 成 [] 后仍继续 saveDoc，导致多建文档）。
 * 解法：直接 goto 同源但不启动 App 的静态模块 URL（/src/main.tsx，浏览器以文本显示、
 * 不开 IDB），在此页面清 localStorage + 删库（无连接、无竞态），再 goto('/')。
 */
export async function resetStore(page: Page) {
  await page.goto('/src/main.tsx')
  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('maosizhi')
        req.onsuccess = () => resolve()
        req.onerror = () => reject(new Error('deleteDatabase onerror'))
        req.onblocked = () => reject(new Error('deleteDatabase blocked'))
      }),
  )
  await page.goto('/')
}

/** 等待 App 首屏 ready（loading 占位消失） */
export async function waitForApp(page: Page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 15_000 })
  await expect(page.locator('header.toolbar')).toBeVisible()
}

/** 自动接受 confirm/alert，记录最近一条消息以便断言 */
export function autoAcceptDialog(page: Page) {
  page.on('dialog', (d) => d.accept())
}

/**
 * 选中画布上第 index 个节点但不进入编辑。
 * 背景：Canvas onNodeDown 在 pointerup（未移动）时会自动 beginEditAt（单击即编辑）。
 * 用真实鼠标做一次「微拖拽」：down 在节点中心 → 移动到空白点（>4px、hover=null）
 * → up，使 onUp 走 moved 分支且不触发 reparent，仅保留 selection。
 */
export async function selectNode(page: Page, index = 0) {
  const loc = page.locator('svg g[role=button]').nth(index)
  const box = await loc.boundingBox()
  if (!box) throw new Error(`画布上找不到第 ${index} 个节点`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  // 扫描一个与起点距离>20px、且在所有节点 bbox 之外的空白点
  const target = await page.evaluate(
    ({ x, y }) => {
      const rects = Array.from(document.querySelectorAll('svg g[role=button]')).map((n) =>
        n.getBoundingClientRect(),
      )
      const inAnyNode = (cx: number, cy: number) =>
        rects.some(
          (b) => cx >= b.left - 2 && cx <= b.right + 2 && cy >= b.top - 2 && cy <= b.bottom + 2,
        )
      for (let cy = 20; cy < window.innerHeight - 20; cy += 24) {
        for (let cx = 20; cx < window.innerWidth - 20; cx += 24) {
          if (Math.hypot(cx - x, cy - y) > 20 && !inAnyNode(cx, cy)) return { x: cx, y: cy }
        }
      }
      return null
    },
    { x, y },
  )
  if (!target) throw new Error('找不到空白点用于 selectNode')

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 6 })
  await page.mouse.up()
}

/** 在导出菜单里点指定按钮 */
export async function clickExportMenu(page: Page, label: RegExp) {
  await page.locator('details.tmenu summary.tbtn').click()
  const item = page.locator('details.tmenu .tmenu-pop button', { hasText: label })
  await expect(item).toBeVisible()
  await item.click()
}

export const test = base.extend({})
export { expect }
