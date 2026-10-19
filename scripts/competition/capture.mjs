/* global document */
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { courseData, authoredText, prepareAuthoredCourse } from './course.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'docs/iterations/2026-10-19-益海嘉里杯初赛方案/参赛材料')
const evidenceRoot = path.join(root, 'reports/competition-2026-10-19')
const evidence = path.join(evidenceRoot, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.browser-test-runtime/competition-browser')
const { chromium, expect } = await import('@playwright/test')
const { createServer } = await import('vite')
const record = !process.argv.includes('--quick')
await fs.mkdir(path.join(output, '截图'), { recursive: true })
await fs.mkdir(path.join(evidence, 'videos'), { recursive: true })
await fs.writeFile(path.join(output, courseData.filename), authoredText())
const result = { startedAt: new Date().toISOString(), kind: 'automated real-browser walkthrough, not human user research', course: courseData.name, disclosure: courseData.disclosure, apiPosts: [], externalRequests: [], pageErrors: [], checks: [], screenshots: [], networkMode: 'local loopback allowed; external requests blocked; no AI backend', browser: null }
let browser, context, page, server
const hold = (ms = 2400) => record ? page.waitForTimeout(ms) : Promise.resolve()
const check = (name, data = true) => { result.checks.push({ name, passed: true, data }); console.log(`PASS ${name}`) }
async function open(targetPage, { courseId, view, questionKey }) {
  await targetPage.getByRole('navigation', { name: '学习主导航' }).getByRole('button', { name: '资料', exact: true }).click()
  const workspace = targetPage.getByRole('region', { name: '课程学习工作台' })
  await expect(workspace).toBeVisible()
  const coursePicker = targetPage.getByLabel('当前课程', { exact: true })
  await expect(coursePicker.locator(`option[value="${courseId}"]`)).toHaveCount(1)
  if (await coursePicker.inputValue() !== courseId) await coursePicker.selectOption(courseId)
  const nav = workspace.getByRole('navigation', { name: '课程功能' })
  if (view === 'practice') {
    await nav.getByRole('button', { name: '练习', exact: true }).click()
    await expect(workspace.getByRole('heading', { name: '课程题库', exact: true })).toBeVisible()
    if (questionKey) {
      await workspace.getByText('更换题目或学习方式', { exact: true }).click()
      await workspace.getByLabel('选择练习', { exact: true }).selectOption(questionKey)
      await workspace.getByText('更换题目或学习方式', { exact: true }).click()
    }
  } else {
    if (await nav.locator('details.learning-course-menu').getAttribute('open') === null) await nav.getByText('课程操作', { exact: true }).click()
    await nav.getByRole('button', { name: view === 'records' ? '记录' : '备份', exact: true }).click()
    await expect(workspace.getByRole('heading', { name: view === 'records' ? '学习记录' : '资料与进度一起备份', exact: true })).toBeVisible()
  }
}
async function screenshot(name, targetPage = page) {
  const nameWithExtension = `${name}.png`
  await targetPage.screenshot({ path: path.join(output, '截图', nameWithExtension), fullPage: true })
  result.screenshots.push(`截图/${nameWithExtension}`)
}
async function guard(targetContext) {
  await targetContext.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { result.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient') }
    if (url.pathname.startsWith('/api/')) {
      if (request.method() === 'POST') result.apiPosts.push(url.pathname)
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: '本次演示未启动 AI 后台。' } }) })
    }
    return route.continue()
  })
}
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5184, strictPort: true } })
  await server.listen()
  const baseURL = 'http://127.0.0.1:5184'
  browser = await chromium.launch({ headless: true })
  result.browser = browser.version()
  context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', ...(record ? { recordVideo: { dir: path.join(evidence, 'videos'), size: { width: 1440, height: 1000 } } } : {}) })
  await guard(context)
  page = await context.newPage()
  page.on('pageerror', (error) => result.pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await screenshot('01-首页')
  await hold(2000)
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles(path.join(output, courseData.filename))
  const importDialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(importDialog).toContainText(courseData.filename)
  await expect(importDialog).toContainText('相关与因果')
  await screenshot('02-导入预览')
  await hold(3500)
  await importDialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(importDialog).toBeHidden()
  const prepared = await page.evaluate(prepareAuthoredCourse, courseData)
  result.prepared = prepared
  assert.equal(prepared.questionCount, 6)
  check('实际TXT导入与六题归档校验', { questions: prepared.questionCount, sourceHash: prepared.sourceHash, archiveHash: prepared.archiveHash })
  const cleanCourse = await page.evaluate(async ({ courseId }) => {
    const { exportCoursePackage } = await import('/src/learning/coursePackage.ts')
    return (await exportCoursePackage(courseId)).text()
  }, prepared)
  await fs.writeFile(path.join(output, '统计学自编示范-无作答.mszcourse'), cleanCourse)
  await page.reload()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await open(page, { ...prepared, view: 'practice' })
  await expect(page.getByRole('radio', { name: courseData.sections[0].questions[0].options[0], exact: true })).toBeVisible()
  await screenshot('03-正式题')
  await page.locator('.focused-question fieldset').screenshot({ path: path.join(output, '截图/03-选项特写.png') })
  await hold(5000)
  await page.getByRole('radio', { name: courseData.sections[0].questions[0].options[0], exact: true }).check()
  await hold(1500)
  await page.getByRole('button', { name: '提交本题', exact: true }).click()
  await expect(page.getByText('本次回答与参考答案不一致，建议回查原文。', { exact: true })).toBeVisible()
  await screenshot('04-答错反馈')
  check('客观题错误回答与反馈一致')
  await hold(3500)
  await page.getByRole('button', { name: '需要帮助，查看相关段落', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '相关段落' })).toContainText(courseData.sections[0].text)
  await screenshot('05-归档原文依据')
  await hold(4500)
  await page.getByRole('button', { name: '进入独立阅读', exact: true }).click()
  const reader = page.getByRole('dialog', { name: '独立阅读' })
  await expect(reader).toContainText(courseData.sections[2].text)
  await screenshot('06-独立阅读')
  await hold(4500)
  await reader.getByRole('button', { name: '返回刚才的学习' }).click()
  await expect(page.getByText('本次回答与参考答案不一致，建议回查原文。', { exact: true })).toBeVisible()
  check('归档引用和独立阅读返回不丢原回答')
  await page.getByRole('button', { name: '回原文补学这道题', exact: true }).click()
  const journey = page.getByRole('dialog', { name: '原文补学', exact: true })
  await expect(journey.getByRole('button', { name: '继续下一步' })).toBeEnabled()
  await hold(3000)
  await journey.getByRole('button', { name: '继续下一步' }).click()
  const note = '我把一起变化误当成了因果。气温可能同时影响两者，还需要考虑共同因素和研究设计。'
  await journey.getByLabel('我需要修正的地方', { exact: true }).fill(note)
  await expect(journey.getByRole('button', { name: '继续下一步' })).toBeEnabled()
  await screenshot('07-个人修正')
  await journey.locator('article').screenshot({ path: path.join(output, '截图/07-修正特写.png') })
  await hold(5000)
  await journey.getByRole('button', { name: '继续下一步' }).click()
  await journey.getByRole('radio', { name: courseData.sections[0].questions[0].options[1], exact: true }).check()
  await hold(2000)
  await journey.getByRole('button', { name: '提交本题', exact: true }).click()
  await expect(journey.getByText('本次回答与参考答案一致。', { exact: true })).toBeVisible()
  const tomorrow = await page.evaluate(async () => { const { learningDate, addLearningDays } = await import('/src/learning/reviewScheduler.ts'); return addLearningDays(learningDate(Date.now()), 1) })
  await journey.getByLabel('下次日期（可不选）', { exact: true }).fill(tomorrow)
  await screenshot('08-补学重试与日期')
  await hold(4000)
  await journey.getByRole('button', { name: '完成本轮并保存安排', exact: true }).click()
  await expect(journey.getByText(`下次复习：${tomorrow}`)).toBeVisible()
  await screenshot('09-已保存复习安排')
  await hold(3500)
  await journey.getByRole('button', { name: '返回课程继续学习', exact: true }).click()
  const saved = await page.evaluate(async ({ courseId }) => {
    const { loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const s = await loadCourseSnapshot(courseId)
    return { attempts: s.attempts.map((a) => ({ id: a.id, answer: a.answer, assistance: a.assistance, question: a.question })), journeys: s.journeys, schedules: s.schedules, example: s.course.example }
  }, prepared)
  assert.deepEqual(saved.attempts.map((a) => a.answer), [0, 1])
  assert.equal(saved.attempts[1].assistance.sourceViewed, true)
  assert.equal(saved.journeys[0].note, note)
  assert.equal(saved.journeys[0].retryAttemptId, saved.attempts[1].id)
  assert.equal(saved.schedules[0].dueDate, tomorrow)
  assert.equal(saved.example, true)
  check('原回答保留、修正与重试关联、辅助事实及手动日期保存', saved)
  await open(page, { courseId: prepared.courseId, view: 'records' })
  await expect(page.getByText('回答：0', { exact: true })).toBeVisible()
  await screenshot('10-真实操作记录')
  await hold(4500)
  await page.reload()
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
  await open(page, { courseId: prepared.courseId, view: 'records' })
  await expect(page.getByText(note, { exact: true })).toBeVisible()
  check('刷新后修正与回答仍可读取')
  await open(page, { courseId: prepared.courseId, view: 'backup' })
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出课程资料包', exact: true }).click()
  const download = await downloadEvent
  const progressPath = path.join(output, '统计学自编示范-自动演示记录.mszcourse')
  await download.saveAs(progressPath)
  await screenshot('11-课程包导出')
  await hold(2000)
  check('通过界面导出包含自动演示记录的课程包')
  // A separate context has no user profile or prior database; it never clears the user's browser.
  const restoredContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' })
  await guard(restoredContext)
  const restoredPage = await restoredContext.newPage()
  restoredPage.on('pageerror', (error) => result.pageErrors.push(error.message))
  await restoredPage.goto('/')
  await restoredPage.getByRole('navigation', { name: '学习主导航' }).getByRole('button', { name: '资料', exact: true }).click()
  await restoredPage.getByLabel('新课程名称', { exact: true }).fill('仅用于打开恢复入口的空课程')
  await restoredPage.getByRole('button', { name: '创建课程', exact: true }).click()
  await expect(restoredPage.getByLabel('当前课程')).toContainText('仅用于打开恢复入口的空课程')
  await restoredPage.getByText('课程操作', { exact: true }).click()
  await restoredPage.getByRole('button', { name: '备份', exact: true }).click()
  await restoredPage.getByLabel('选择课程包', { exact: true }).setInputFiles(progressPath)
  await restoredPage.getByRole('button', { name: '检查课程包', exact: true }).click()
  await expect(restoredPage.getByRole('heading', { name: '恢复预览', exact: true })).toBeVisible()
  await screenshot('12-空白浏览器恢复预览', restoredPage)
  await restoredPage.getByRole('button', { name: '确认恢复为新课程', exact: true }).click()
  const recovered = await restoredPage.evaluate(async () => {
    const { listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const c = (await listCourses()).find((item) => item.name.includes('自编示范'))
    if (!c) throw new Error('恢复课程未找到')
    const s = await loadCourseSnapshot(c.id)
    return { courseId: c.id, sourceText: s.archives[0].sources[0].text, answers: s.attempts.map((a) => a.answer), note: s.journeys[0].note, dueDate: s.schedules[0].dueDate, originalQuestionIds: s.attempts.map((a) => a.question.questionId), example: c.example }
  })
  assert.notEqual(recovered.courseId, prepared.courseId)
  assert.deepEqual(recovered.answers, [0, 1])
  assert.equal(recovered.note, note)
  assert.equal(recovered.dueDate, tomorrow)
  assert.equal(recovered.example, true)
  assert.ok(recovered.sourceText.includes(courseData.sections[0].text))
  check('空白浏览器通过界面预览和恢复，保持来源/作答/修正/日期', recovered)
  result.recoveryFriction = '当前首次恢复需要先建立空课程，才能使用课程内恢复入口；未修改产品结构。'
  for (const width of [320, 375, 414, 768]) {
    await restoredPage.setViewportSize({ width, height: 900 })
    await open(restoredPage, { courseId: recovered.courseId, view: 'records' })
    await expect(restoredPage.getByRole('heading', { name: '学习记录', exact: true })).toBeVisible()
    const again = restoredPage.getByRole('button', { name: '再次练习', exact: true }).first()
    await again.scrollIntoViewIfNeeded()
    await again.click()
    await expect(restoredPage.getByRole('button', { name: '提交本题', exact: true })).toBeVisible()
    await screenshot(`13-恢复后练习-${width}`, restoredPage)
    const submit = await restoredPage.getByRole('button', { name: '提交本题', exact: true }).boundingBox()
    assert.ok(submit && submit.x >= 0 && submit.x + submit.width <= width + 1)
    check(`恢复后${width}px从记录进入可操作练习`)
  }
  await restoredContext.close()
  assert.equal(result.apiPosts.length, 0)
  assert.deepEqual(result.pageErrors, [])
  check('零AI生成POST且无页面脚本错误')
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.failure = { message: error.message, stack: error.stack }
  if (page) result.failureState = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const rows = await db.learningRecords.toArray()
    return { attempts: rows.filter((r) => r.kind === 'attempt'), drafts: rows.filter((r) => r.kind === 'draft'), text: document.body.innerText.slice(0, 16000), controls: [...document.querySelectorAll('.question-heading, .question-cat-place, .guide-bubble, button')].map((el) => ({ name: el.textContent?.slice(0, 80), class: el.className, rect: el.getBoundingClientRect().toJSON() })) }
  }).catch(() => null)
  if (page) await page.screenshot({ path: path.join(evidence, 'capture-failure.png'), fullPage: true }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  const video = page?.video()
  await context?.close()
  if (video && result.status === 'passed') {
    const videoPath = path.join(output, '猫思之-浏览器自动演示.webm')
    await video.saveAs(videoPath)
    result.video = path.relative(root, videoPath)
  }
  await browser?.close()
  await server?.close()
  result.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(evidence, 'walkthrough.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(path.join(evidenceRoot, 'walkthrough.json'), JSON.stringify({ ...result, runEvidence: path.relative(root, evidence) }, null, 2))
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, evidence: path.relative(root, evidence), apiPosts: result.apiPosts.length, pageErrors: result.pageErrors.length }))
}
