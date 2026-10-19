/* global document, requestAnimationFrame, getComputedStyle */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.join(root, 'reports/competition-2026-10-19/layout')
const evidence = path.join(evidenceRoot, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const materials = path.join(root, 'docs/iterations/2026-10-19-益海嘉里杯初赛方案/参赛材料')
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.browser-test-runtime/competition-browser')
const { chromium, expect } = await import('@playwright/test')
const { createServer } = await import('vite')
await fs.mkdir(evidence, { recursive: true })
const checks = [], errors = []
let server, browser, context, page
const pass = (name, detail = true) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`) }
const result = { kind: 'isolated layout regression; virtual clock advances prompt timers only, not learning outcomes', startedAt: new Date().toISOString(), checks, errors }
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5186, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/') ? route.continue() : route.abort()
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install()
  await page.goto('http://127.0.0.1:5186/src/main.tsx')
  const clean = await fs.readFile(path.join(materials, '统计学自编示范-无作答.mszcourse'), 'utf8')
  const courseId = await page.evaluate(async (text) => {
    const { restoreCoursePackage, previewCoursePackage } = await import('/src/learning/coursePackage.ts')
    return (await restoreCoursePackage(await previewCoursePackage(new Blob([text])))).id
  }, clean)
  await page.goto('http://127.0.0.1:5186/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await page.clock.runFor(121_000)
  await page.getByRole('navigation', { name: '学习主导航' }).getByRole('button', { name: '资料', exact: true }).click()
  await page.getByRole('navigation', { name: '课程功能' }).getByRole('button', { name: '练习', exact: true }).click()
  const question = page.locator('.focused-question')
  const bubble = question.locator('.isis-bubble')
  await expect(bubble).toBeVisible()
  const radio = question.getByRole('radio').first()
  for (const width of [1440, 320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 1000 })
    const geometry = await question.locator('.question-heading').evaluate((el) => {
      const perch = el.querySelector('.question-cat-place'), bubble = el.querySelector('.isis-bubble')
      return { heading: el.getBoundingClientRect().toJSON(), perch: perch.getBoundingClientRect().toJSON(), bubble: bubble.getBoundingClientRect().toJSON(), columns: getComputedStyle(el).gridTemplateColumns }
    })
    assert.ok(geometry.perch.width > (width > 600 ? 96 : 72), `气泡预留位应占可用整行：${width}`)
    assert.ok(geometry.bubble.width > 150)
    assert.ok(geometry.bubble.height < 260, `不能逐字拉成长列：${width}`)
    const targetGeometry = (el) => ({ y: el.getBoundingClientRect().top - el.closest('.focused-question').getBoundingClientRect().top })
    const before = await radio.evaluate(targetGeometry)
    await radio.evaluate((el) => el.focus({ preventScroll: true }))
    await expect(bubble).toBeVisible()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const after = await radio.evaluate(targetGeometry)
    result.focusMeasurements ??= []
    result.focusMeasurements.push({ width, before, after })
    assert.ok(before && after && Math.abs(before.y - after.y) < 1)
    await page.screenshot({ path: path.join(evidence, `bubble-${width}.png`), fullPage: true })
    pass(`${width}px停靠气泡宽度与聚焦几何稳定`, geometry)
  }
  await question.locator('.question-confidence summary').focus()
  await radio.check()
  await expect(radio).toBeChecked()
  pass('默认气泡下真实radio点击成功，未force或隐藏气泡')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await radio.focus()
  await page.getByRole('button', { name: '打开伊希斯新手引导', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '与伊希斯对话', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '与伊希斯对话', exact: true })).toBeHidden()
  await expect(radio).toBeFocused()
  await expect(radio).toBeChecked()
  pass('对话展开及Escape返回原输入并保留选择')
  await page.getByRole('button', { name: '打开伊希斯新手引导', exact: true }).click()
  await page.getByRole('button', { name: '关闭与伊希斯对话', exact: true }).click()
  await expect(radio).toBeFocused()
  await expect(radio).toBeChecked()
  pass('点击收起对话返回原输入并保留选择')
  await page.clock.fastForward(13_000)
  await expect(bubble).toBeHidden()
  await radio.check()
  await expect(radio).toBeChecked()
  await expect(question.getByRole('button', { name: '提交本题', exact: true })).toBeEnabled()
  await question.getByRole('button', { name: '提交本题', exact: true }).click()
  await expect(question.getByText('本次回答与参考答案不一致，建议回查原文。', { exact: true })).toBeVisible()
  const count = await page.evaluate(async (id) => { const { loadCourseSnapshot } = await import('/src/learning/repository.ts'); return (await loadCourseSnapshot(id)).attempts.length }, courseId)
  assert.equal(count, 1)
  pass('12秒提示结束后仍可原生点击提交且只保存一次', { attempts: count })
  await page.evaluate(async () => { const { saveExperience } = await import('/src/learning/experiencePreferences.ts'); saveExperience({ companion: 'quiet' }) })
  await expect(page.locator('.isis-bubble')).toBeHidden()
  pass('quiet模式继续禁止自动气泡')
  assert.deepEqual(errors, [])
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.failure = { message: error.message, stack: error.stack }
  result.focusAtFailure = await page?.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 200) })).catch(() => null)
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await context?.close()
  await browser?.close()
  await server?.close()
  result.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify({ ...result, runEvidence: path.relative(root, evidence) }, null, 2))
  console.log(JSON.stringify({ status: result.status, checks: checks.length }))
}
