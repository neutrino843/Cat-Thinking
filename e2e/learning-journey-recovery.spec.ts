import { expect, test, type Locator, type Page } from '@playwright/test'

type ReadingFixture = { courseId: string; documentId: string; journeyId: string }
type ReadFault = { courseId: string; reject: boolean; hold: boolean; pending: number; rejectAfterNote?: string; release: (reject?: boolean) => void }
declare global { interface Window { __ctRecoveryFault?: ReadFault } }

const NOTE = '合成回归：把原文和自己的解释对照，保留完整理解。'
const DATE = '2099-11-01'
const posts = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page, baseURL }) => {
  const attempts: string[] = []
  posts.set(page, attempts)
  const origin = new URL(baseURL!).origin
  await page.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort('blockedbyclient')
    if (url.pathname.startsWith('/api/')) {
      if (request.method() === 'POST') attempts.push(url.pathname)
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', message: 'Isolated synthetic reading regression' } }) })
    }
    return route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
})

test.afterEach(async ({ page }) => { expect(posts.get(page)).toEqual([]) })

async function seed(page: Page): Promise<ReadingFixture> {
  return page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { createExampleCourse } = await import('/src/learning/exampleCourse.ts')
    const { updateCourse, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const { startReadingJourney, saveJourney } = await import('/src/learning/learningLoop.ts')
    const { sha256Hex } = await import('/src/analysis/fingerprint.ts')
    const course = await updateCourse({ ...await createExampleCourse(), example: false, name: '合成续学回归课程', dailyMinutes: 60, dailyQuestionLimit: 20 })
    const snapshot = await loadCourseSnapshot(course.id)
    const documentId = snapshot.documents[0].docId
    const source = (await db.sources.where('docId').equals(documentId).toArray())[0]
    const text = '阅读应把原文和自己的解释对照。\n'.repeat(200)
    await db.sources.put({ ...source, text, charCount: text.length, size: new TextEncoder().encode(text).length, contentHash: await sha256Hex(text) })
    const journey = await startReadingJourney(course.id, documentId)
    await saveJourney({ ...journey, status: 'paused', position: 1300, note: '合成上轮笔记' })
    return { courseId: course.id, documentId, journeyId: journey.id }
  })
}

async function openWorkspace(page: Page, fixture: ReadingFixture, includeJourney = true) {
  await page.evaluate(({ courseId, journeyId, includeJourney }) => {
    window.dispatchEvent(new CustomEvent('msz:learning-open', { detail: { courseId, view: includeJourney ? 'today' : 'materials', ...(includeJourney ? { journeyId } : {}) } }))
  }, { ...fixture, includeJourney })
  return page.getByRole('region', { name: '课程学习工作台', exact: true })
}

async function openReading(page: Page, fixture: ReadingFixture) {
  await openWorkspace(page, fixture)
  const layer = page.getByRole('dialog', { name: '原文阅读学习', exact: true })
  await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeEnabled()
  return layer
}

async function readSaved(page: Page, fixture: ReadingFixture) {
  return page.evaluate(async ({ courseId, journeyId }) => {
    const { db } = await import('/src/store/db.ts')
    const rows = await db.learningRecords.where('courseId').equals(courseId).toArray()
    const journey = rows.find((row) => row.kind === 'journey' && row.id === journeyId)
    const points = rows.filter((row) => row.kind === 'point' && row.id === `${journeyId}:personal`)
    return {
      journey: journey?.kind === 'journey' ? { revision: journey.revision, status: journey.status, step: journey.step, position: journey.position, note: journey.note, dueDate: journey.dueDate, finishedAt: journey.finishedAt } : null,
      journeys: rows.filter((row) => row.kind === 'journey').length,
      personalPoints: points.length,
      definition: points[0]?.kind === 'point' ? points[0].definition : undefined,
      tombstone: !!await db.learningCourseTombstones.get(courseId),
    }
  }, fixture)
}

async function writeNote(layer: Locator, rapid = false) {
  await layer.getByRole('button', { name: '继续下一步', exact: true }).click()
  const field = layer.getByRole('textbox', { name: '我读懂了什么', exact: true })
  await expect(layer.locator('footer [role="status"]')).toHaveText('进度已保存在本机')
  if (rapid) { await field.fill(''); await field.pressSequentially(NOTE); await expect(field).toBeFocused() }
  else await field.fill(NOTE)
  await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeEnabled()
}

/** Faults run only after the real transaction commits, keeping IDB lifetimes intact. */
async function installReadFault(page: Page, fixture: ReadingFixture, options: { reject?: boolean; hold?: boolean; rejectAfterNote?: string } = {}) {
  await page.evaluate(async ({ courseId, options }) => {
    const { db } = await import('/src/store/db.ts')
    const original = db.transaction.bind(db)
    const releases: Array<(reject?: boolean) => void> = []
    const state: ReadFault = { courseId, reject: !!options.reject, hold: !!options.hold, rejectAfterNote: options.rejectAfterNote, pending: 0, release: (reject) => { state.hold = false; releases.splice(0).forEach((release) => release(reject)) } }
    window.__ctRecoveryFault = state
    db.transaction = ((...args: any[]) => original(...args).then((result: any) => {
      if (args[0] === 'rw' && state.rejectAfterNote && result?.kind === 'journey' && result.note === state.rejectAfterNote) { state.reject = true; state.rejectAfterNote = undefined }
      if (args[0] !== 'r' || result?.course?.id !== state.courseId) return result
      if (state.reject) throw new Error('Synthetic committed snapshot read rejection')
      if (!state.hold) return result
      state.pending++
      return new Promise((resolve, reject) => releases.push((fail) => { state.pending--; if (fail) reject(new Error('Synthetic late snapshot rejection')); else resolve(result) }))
    })) as typeof db.transaction
  }, { courseId: fixture.courseId, options })
}

for (const width of [375, 1440]) for (const entry of ['primary', 'expanded'] as const) {
  test(`两入口恢复后快速输入、完成与重载唯一：${entry} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    const fixture = await seed(page)
    await expect(page.getByRole('button', { name: '继续学习', exact: true })).toBeEnabled()
    if (entry === 'primary') await page.getByRole('button', { name: '继续学习', exact: true }).click()
    else { await page.getByText('查看完整安排与学习记录', { exact: false }).click(); await page.getByRole('button', { name: '继续这轮学习', exact: true }).click() }
    const layer = page.getByRole('dialog', { name: '原文阅读学习', exact: true })
    await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeEnabled()
    await writeNote(layer, true)
    await layer.getByRole('button', { name: '继续下一步', exact: true }).click()
    await layer.getByLabel('下次日期（可不选）').fill(DATE)
    await layer.getByRole('button', { name: '完成本轮并保存安排', exact: true }).click()
    await expect(layer.getByRole('heading', { name: '本轮已记录', exact: true })).toBeVisible()
    const before = await readSaved(page, fixture)
    expect(before).toMatchObject({ journeys: 1, personalPoints: 1, definition: NOTE, journey: { status: 'completed', step: 3, position: 1300, note: NOTE, dueDate: DATE } })
    await page.reload()
    await expect(page.getByRole('main', { name: '今日学习首页' })).toBeVisible()
    expect(await readSaved(page, fixture)).toEqual(before)
    // A repeated explicit completion cannot create a second personal record.
    await page.evaluate(async ({ journeyId }) => {
      const { getEntity } = await import('/src/learning/repository.ts')
      const { completeJourney } = await import('/src/learning/learningLoop.ts')
      await completeJourney((await getEntity(journeyId, 'journey'))!, undefined, false)
    }, fixture)
    expect(await readSaved(page, fixture)).toEqual(before)
  })
}

test('初读失败独立错误态，显式只读重试不启动旅程写入', async ({ page }) => {
  const fixture = await seed(page), before = await readSaved(page, fixture)
  await installReadFault(page, fixture, { reject: true })
  const workspace = await openWorkspace(page, fixture, false)
  await expect(workspace.getByText('本次未能读取课程资料，请重新读取。', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '原文阅读学习', exact: true })).toHaveCount(0)
  await page.evaluate(() => { window.__ctRecoveryFault!.reject = false })
  await workspace.getByRole('button', { name: '重新读取学习资料', exact: true }).click()
  await expect(workspace.locator('.learning-error')).toHaveCount(0)
  await expect(workspace.getByLabel('当前课程')).toHaveValue(fixture.courseId)
  expect(await readSaved(page, fixture)).toEqual(before)
})

test('Q27-01：带暂停旅程的初读失败，重读不自动恢复学习记录', async ({ page }) => {
  const fixture = await seed(page)
  const allRecords = () => page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return db.learningRecords.toArray() })
  const before = await allRecords()
  await installReadFault(page, fixture, { reject: true })
  const workspace = await openWorkspace(page, fixture)
  await expect(workspace.getByText('本次未能读取课程资料，请重新读取。', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '原文阅读学习', exact: true })).toHaveCount(0)
  await page.evaluate(() => { window.__ctRecoveryFault!.reject = false })
  await workspace.getByRole('button', { name: '重新读取学习资料', exact: true }).click()
  const layer = page.getByRole('dialog', { name: '原文阅读学习', exact: true })
  await expect(layer.getByRole('button', { name: '恢复这轮学习', exact: true })).toBeEnabled()
  await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeDisabled()
  await expect(layer.getByLabel('可复制的当前笔记', { exact: true })).toHaveValue('合成上轮笔记')
  const after = await allRecords()
  await test.info().attach('q27-01-all-records-before-after', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' })
  expect(after).toEqual(before)
  await layer.getByRole('button', { name: '恢复这轮学习', exact: true }).click()
  await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeEnabled()
  const resumed = await allRecords()
  expect(resumed.filter((row) => row.id !== fixture.journeyId)).toEqual(before.filter((row) => row.id !== fixture.journeyId))
  const previous = before.find((row) => row.id === fixture.journeyId)!
  expect(resumed.find((row) => row.id === fixture.journeyId)).toMatchObject({ status: 'active', revision: previous.revision + 1, position: 1300, note: '合成上轮笔记' })
  await test.info().attach('q27-01-after-explicit-resume', { body: JSON.stringify(resumed, null, 2), contentType: 'application/json' })
})

test('写入已经成功但父读取失败时保留框和笔记，重读不重放写入', async ({ page }) => {
  const fixture = await seed(page), layer = await openReading(page, fixture)
  await layer.getByRole('button', { name: '继续下一步', exact: true }).click()
  await expect(layer.locator('footer [role="status"]')).toHaveText('进度已保存在本机')
  await installReadFault(page, fixture, { rejectAfterNote: NOTE })
  await layer.getByRole('textbox', { name: '我读懂了什么', exact: true }).fill(NOTE)
  await expect(layer.getByLabel('可复制的当前笔记', { exact: true })).toHaveValue(NOTE)
  await expect(layer.getByRole('button', { name: '继续下一步', exact: true })).toBeDisabled()
  const before = await readSaved(page, fixture)
  expect(before.journey?.note).toBe(NOTE)
  await page.evaluate(() => { window.__ctRecoveryFault!.reject = false })
  await layer.getByRole('button', { name: '重新读取并核对', exact: true }).click()
  await expect(layer.getByText('已重新核对进度和原文。本次只读取，没有自动恢复、保存或完成。', { exact: true })).toBeVisible()
  await expect(layer.getByRole('textbox', { name: '我读懂了什么', exact: true })).toHaveValue(NOTE)
  expect(await readSaved(page, fixture)).toEqual(before)
})

for (const failure of ['course-delete', 'source-changed'] as const) {
  test(`失效停写并保留笔记与日期：${failure}`, async ({ page }) => {
    const fixture = await seed(page), layer = await openReading(page, fixture)
    await writeNote(layer)
    await layer.getByRole('button', { name: '继续下一步', exact: true }).click()
    await layer.getByLabel('下次日期（可不选）').fill(DATE)
    await page.evaluate(async ({ fixture, failure }) => {
      const { db } = await import('/src/store/db.ts')
      const { getCourse, deleteCourseOrganisation } = await import('/src/learning/repository.ts')
      if (failure === 'course-delete') { const course = (await getCourse(fixture.courseId))!; await deleteCourseOrganisation(course.id, course.revision) }
      else {
        const { sha256Hex } = await import('/src/analysis/fingerprint.ts')
        const source = (await db.sources.where('docId').equals(fixture.documentId).toArray())[0]
        const text = source.text + '\n合成的新版本。'
        await db.sources.put({ ...source, text, charCount: text.length, size: new TextEncoder().encode(text).length, contentHash: await sha256Hex(text) })
      }
    }, { fixture, failure })
    await expect(layer.getByLabel('可复制的当前笔记', { exact: true })).toHaveValue(NOTE)
    await expect(layer.getByLabel('下次日期（可不选）')).toHaveValue(DATE)
    await expect(layer.getByRole('button', { name: '完成本轮并保存安排', exact: true })).toBeDisabled()
    const before = await readSaved(page, fixture)
    await layer.getByRole('button', { name: '重新读取并核对', exact: true }).click()
    await expect(layer.getByRole('button', { name: '重新读取并核对', exact: true })).toBeEnabled()
    await expect(layer.getByLabel('可复制的当前笔记', { exact: true })).toHaveValue(NOTE)
    await expect(layer.getByRole('button', { name: '完成本轮并保存安排', exact: true })).toBeDisabled()
    expect(await readSaved(page, fixture)).toEqual(before)
    if (failure === 'course-delete') expect(before).toMatchObject({ journey: null, journeys: 0, personalPoints: 0, tombstone: true })
  })
}

for (const lateFailure of [false, true]) {
  test(`切课后丢弃旧课迟到${lateFailure ? '错误' : '快照'}`, async ({ page }) => {
    const fixture = await seed(page)
    const secondId = await page.evaluate(async () => { const { createCourse } = await import('/src/learning/repository.ts'); return (await createCourse({ name: '切换后的独立课程', learningMode: 'legacy' })).id })
    await installReadFault(page, fixture, { hold: true })
    const workspace = await openWorkspace(page, fixture, false)
    await expect.poll(() => page.evaluate(() => window.__ctRecoveryFault!.pending)).toBeGreaterThan(0)
    await workspace.getByLabel('当前课程').selectOption(secondId)
    await expect(workspace.getByLabel('当前课程')).toHaveValue(secondId)
    await expect(workspace.getByRole('status').filter({ hasText: '正在读取学习资料' })).toHaveCount(0)
    await page.evaluate((fail) => window.__ctRecoveryFault!.release(fail), lateFailure)
    await expect.poll(() => page.evaluate(() => window.__ctRecoveryFault!.pending)).toBe(0)
    await expect(workspace.getByLabel('当前课程')).toHaveValue(secondId)
    await expect(workspace.locator('.learning-error')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '原文阅读学习', exact: true })).toHaveCount(0)
    expect((await readSaved(page, fixture)).journey?.status).toBe('paused')
  })
}
