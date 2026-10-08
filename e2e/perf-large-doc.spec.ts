import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu } from './helpers'
import type { Page } from '@playwright/test'

/**
 * M8-P2-5：大文档（1050 节点）性能与导出完整性 E2E。
 *
 * 覆盖指标：
 * - G-4：画布平移/缩放期间 rAF 帧率 ≥ 40fps（CI 宽松门线，本地 ≥ 45fps）
 * - R1 红线：视口裁剪开启时，SVG 导出仍含全部 1050 节点
 * - 裁剪生效：画布 DOM 中 g[role=button] 数量随视口裁剪显著 < 1050
 * - 甘特行虚拟化：滚动后可见行数显著 < 1050
 * - 零 console error
 */

/** 生成 1050 节点文档（根 + 35 一级 × 29 二级 = 1 + 35 + 1015 = 1051） */
function buildLargeDoc() {
  const now = Date.now()
  const nodes: Record<string, any> = {}
  const rootId = 'root'
  nodes[rootId] = { id: rootId, parent: null, children: [], text: '性能测试根' }
  let total = 1
  for (let i = 0; i < 35 && total < 1050; i++) {
    const cid = `c${i}`
    nodes[cid] = { id: cid, parent: rootId, children: [], text: `分支${i}` }
    nodes[rootId].children.push(cid)
    total++
    for (let j = 0; j < 29 && total < 1050; j++) {
      const gid = `c${i}_g${j}`
      nodes[gid] = { id: gid, parent: cid, children: [], text: `叶${i}-${j}` }
      nodes[cid].children.push(gid)
      total++
    }
  }
  return {
    version: 2 as const,
    id: 'perf-large',
    title: '性能测试-1050节点',
    rootId,
    layout: 'logic' as const,
    nodes,
    createdAt: now,
    updatedAt: now,
  }
}

/** rAF 帧率采样器：在 durationMs 内统计帧数，返回 fps */
async function sampleFps(page: Page, durationMs = 1000): Promise<number> {
  return page.evaluate((d) => {
    return new Promise<number>((resolve) => {
      const start = performance.now()
      let count = 0
      const tick = () => {
        count++
        if (performance.now() - start < d) {
          requestAnimationFrame(tick)
        } else {
          resolve((count / d) * 1000)
        }
      }
      requestAnimationFrame(tick)
    })
  }, durationMs)
}

test('1050 节点：画布裁剪生效 + 平移帧率 ≥ 40fps + 导出含全部节点', async ({ page }) => {
  // 捕获 console error
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await resetStore(page)
  await waitForApp(page)
  // 用 app 自身的 saveDoc 写入大文档（走 Dexie 正确 schema），然后直接 loadDoc 进 store
  // （不走 page.goto 重载——避免 App init 单飞锁/竞态导致未加载大文档）
  const doc = buildLargeDoc()
  await page.evaluate(async (payload) => {
    const { saveDoc, loadDoc } = await import('/src/store/db.ts')
    await saveDoc(payload)
    localStorage.setItem('msz.lastDoc', payload.id)
    const loaded = await loadDoc(payload.id)
    const { useDoc } = await import('/src/store/docStore.ts')
    if (loaded) useDoc.getState().loadDoc(loaded)
  }, doc)
  await page.waitForTimeout(400)

  // 断言 1：画布 DOM 节点数显著 < 1050（裁剪生效）
  const domNodeCount = await page.evaluate(() => {
    return document.querySelectorAll('svg g[id="world"] g[role="button"]').length
  })
  // 视口仅含局部，裁剪后 DOM 节点数应远小于 1050；上限 600 给足宽松
  expect(domNodeCount).toBeGreaterThan(0)
  expect(domNodeCount).toBeLessThan(600)

  // 断言 2：平移期间帧率 ≥ 40fps（G-4，CI 宽松门线）
  const sampler = sampleFps(page, 1200)
  await page.mouse.move(400, 300)
  await page.mouse.down({ button: 'middle' })
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(400 + i * 30, 300 + i * 5, { steps: 2 })
    await page.waitForTimeout(40)
  }
  await page.mouse.up({ button: 'middle' })
  const fps = await sampler
  expect(fps).toBeGreaterThanOrEqual(40)

  // 断言 3：R1 红线——视口裁剪开启时导出 SVG 仍含全部 1050 节点
  // exporters 内部 flushSync 设 exportFullRender=true → 全量渲染 → 序列化 → 恢复
  autoAcceptDialog(page)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /SVG/),
  ])
  expect(download.suggestedFilename()).toMatch(/\.svg$/)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  const svg = Buffer.concat(chunks).toString('utf-8')
  // 计数 role="button" 出现次数——导出全量渲染时应含全部 1050 节点
  const roleButtonCount = (svg.match(/role="button"/g) || []).length
  expect(roleButtonCount).toBeGreaterThanOrEqual(1050)

  // 零 console error
  expect(errors).toEqual([])
})

test('1050 节点：甘特行虚拟化生效 + 滚动可见行 < 1050', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  const doc = buildLargeDoc()
  await page.evaluate(async (payload) => {
    const { saveDoc, loadDoc } = await import('/src/store/db.ts')
    await saveDoc(payload)
    localStorage.setItem('msz.lastDoc', payload.id)
    // 为约 1/7 节点加 task，让甘特有任务条
    const loaded = await loadDoc(payload.id)
    if (loaded) {
      let i = 0
      for (const id of Object.keys(loaded.nodes)) {
        if (i % 7 === 1) {
          loaded.nodes[id].task = {
            start: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
            end: `2026-10-${String(1 + (i % 28) + 5).padStart(2, '0')}`,
            progress: 0,
          }
        }
        i++
      }
      await saveDoc(loaded)
      // 直接 loadDoc 进 store（避免 page.goto 重载导致 App init 竞态）
      const reloaded = await loadDoc(payload.id)
      const { useDoc } = await import('/src/store/docStore.ts')
      if (reloaded) useDoc.getState().loadDoc(reloaded)
    }
  }, doc)
  await page.waitForTimeout(400)

  // 切到甘特视图
  await page.locator('.view-switch [role="tab"]:has-text("甘特")').click()
  await page.waitForTimeout(500)

  // 甘特左侧行名数（可见行）应远小于 1050
  const visibleRowCount = await page.evaluate(() => {
    return document.querySelectorAll('.gantt-left .gantt-row').length
  })
  expect(visibleRowCount).toBeGreaterThan(0)
  expect(visibleRowCount).toBeLessThan(100)

  // 滚动到底部后仍只渲染可视行
  await page.evaluate(() => {
    const el = document.querySelector('.gantt-right') as HTMLDivElement
    if (el) el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(400)
  const visibleRowCountAfter = await page.evaluate(() => {
    return document.querySelectorAll('.gantt-left .gantt-row').length
  })
  expect(visibleRowCountAfter).toBeGreaterThan(0)
  expect(visibleRowCountAfter).toBeLessThan(100)
})
