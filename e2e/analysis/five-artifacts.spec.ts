import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import type { AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import type { DocData, SourceDocument } from '../../src/types'
import { resetStore, selectNode, waitForApp } from '../helpers'
import { ANALYSIS_SYNTHETIC } from '../../services/analysis-service/test/fixtures/browserSyntheticTexts'

const expectedFact = ' Photosynthesis converts light into stored chemical energy.'
const expectedFactStart = ANALYSIS_SYNTHETIC.normal.indexOf(expectedFact)

const privateHeaders = () => ({ authorization: `Bearer ${process.env.ANALYSIS_GATEWAY_TOKEN ?? ''}` })
const panel = (page: Page) => page.getByRole('dialog', { name: 'AI 学习分析' })
const control = (request: APIRequestContext, action: string, data?: unknown) => request.post(`http://127.0.0.1:8790/__synthetic/${action}`, { headers: privateHeaders(), data })

interface StoredDoc { id: string; title: string; payload: string }
interface Task { docId: string; runId?: string }
interface Receipt { originDocId: string; targetDocId: string; runId: string; artifactId: string }
interface Practice { answers: Record<string, string | number | boolean>; submitted: boolean; selfAssessments: Record<string, boolean[]> }
interface LocalSnapshot { docs: StoredDoc[]; sources: SourceDocument[]; tasks: Task[]; receipts: Receipt[]; practices: Practice[] }

async function localSnapshot(page: Page): Promise<LocalSnapshot> {
  return page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    const read = <T,>(table: string) => new Promise<T[]>((resolve, reject) => {
      const request = database.transaction(table).objectStore(table).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => reject(request.error)
    })
    try {
      return { docs: await read<StoredDoc>('docs'), sources: await read<SourceDocument>('sources'),
        tasks: await read<Task>('analysisTasks'), receipts: await read<Receipt>('applicationReceipts'), practices: await read<Practice>('quizPractices') }
    } finally { database.close() }
  })
}

async function diagnostic(request: APIRequestContext, runId: string): Promise<{ run: AnalysisRunV1; ledger: { invocationCount: number; unresolvedCount: number; usage: { inputTokens: number; outputTokens: number } } }> {
  const response = await request.get(`http://127.0.0.1:8790/__synthetic/runs/${runId}`, { headers: privateHeaders() })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function importAndOpen(page: Page, text: string = ANALYSIS_SYNTHETIC.normal) {
  await resetStore(page)
  await waitForApp(page)
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '合成学习文档.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  const imported = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await imported.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(imported).toBeHidden()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('合成测试环境')
}

async function generateFive(page: Page): Promise<Task & { runId: string }> {
  for (const name of ['导图', '测验', '知识整理']) await panel(page).getByRole('checkbox', { name, exact: true }).check()
  await expect(panel(page).getByRole('combobox', { name: '测验题数' })).toHaveValue('5')
  await expect(panel(page).getByRole('combobox', { name: '测验题数' }).locator('option')).toHaveText(['5 题', '10 题', '20 题'])
  await panel(page).getByRole('button', { name: '生成所选内容', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  const task = (await localSnapshot(page)).tasks[0]
  if (!task?.runId) throw new Error('Completed synthetic run has no durable binding')
  return { ...task, runId: task.runId }
}

async function reopen(page: Page) {
  await page.reload()
  await waitForApp(page)
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
}

test.afterEach(async ({ page, request }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const task = (await localSnapshot(page).catch(() => undefined))?.tasks[0]
    if (task?.runId) await testInfo.attach('five-artifact-run-metadata', {
      body: JSON.stringify(await diagnostic(request, task.runId).catch(() => ({}))), contentType: 'application/json',
    })
  }
  await control(request, 'gate', { open: true })
})

test('学习目标仅调整内容，手动选择仍可用，明确生成前不上传或新增调用', async ({ page, request }, testInfo) => {
  const mutations: string[] = []
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.startsWith('/api/analysis/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(outgoing.method())) mutations.push(outgoing.method())
  })
  await importAndOpen(page)
  const goals = panel(page).getByRole('group', { name: '这次想怎么学？' })
  await expect(goals.getByRole('button', { name: '整理要点', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await goals.getByRole('button', { name: '理解结构', exact: true }).click()
  for (const name of ['大纲', '导图']) await expect(panel(page).getByRole('checkbox', { name, exact: true })).toBeChecked()
  await expect(panel(page).getByRole('checkbox', { name: '摘要', exact: true })).not.toBeChecked()
  await panel(page).getByRole('checkbox', { name: '测验', exact: true }).check()
  await expect(goals).toContainText('已自定义内容')
  await expect(goals.locator('[aria-pressed="true"]')).toHaveCount(0)
  await goals.getByRole('button', { name: '自测复习', exact: true }).click()
  await expect(panel(page).getByRole('checkbox', { name: '测验', exact: true })).toBeChecked()
  for (const name of ['摘要', '大纲', '导图', '知识整理']) await expect(panel(page).getByRole('checkbox', { name, exact: true })).not.toBeChecked()
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 375) await goals.screenshot({ path: testInfo.outputPath('learning-goals-375.png') })
  }
  expect(mutations).toEqual([])
  expect((await localSnapshot(page)).tasks).toEqual([])
  await page.setViewportSize({ width: 1280, height: 900 })
  await panel(page).getByRole('button', { name: '生成所选内容', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  const task = (await localSnapshot(page)).tasks[0]
  if (!task?.runId) throw new Error('Missing submitted quiz run')
  const result = await diagnostic(request, task.runId)
  expect(result.run.request.artifacts).toEqual(['quiz'])
  expect(result.ledger.invocationCount).toBe(2)
})

test('连接能力缩减时保留选择并阻止生成，重新选可用目标不会创建任务', async ({ page }) => {
  let available = ['quiz']
  const mutations: string[] = []
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.startsWith('/api/analysis/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(outgoing.method())) mutations.push(outgoing.method())
  })
  await page.route('**/api/analysis/v1/capabilities', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), artifactKinds: available } })
  })
  await importAndOpen(page)
  const goals = panel(page).getByRole('group', { name: '这次想怎么学？' })
  await expect(panel(page)).toContainText('当前连接不支持所需的摘要、大纲')
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲', exact: true })).toBeDisabled()
  await expect(goals.getByRole('button', { name: '理解结构', exact: true })).toBeDisabled()
  await expect(panel(page).getByRole('checkbox', { name: '摘要', exact: true })).toBeChecked()
  await goals.getByRole('button', { name: '自测复习', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '生成所选内容', exact: true })).toBeEnabled()
  available = ['summary', 'outline']
  await page.evaluate(() => window.dispatchEvent(new Event('cat-thinking:ai-settings-changed')))
  await expect(panel(page)).toContainText('当前连接不支持所需的测验')
  await expect(panel(page).getByRole('button', { name: '生成所选内容', exact: true })).toBeDisabled()
  await expect(panel(page).getByRole('checkbox', { name: '测验', exact: true })).toBeChecked()
  await goals.getByRole('button', { name: '整理要点', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '生成摘要与大纲', exact: true })).toBeEnabled()
  available = ['mindmap']
  await page.evaluate(() => window.dispatchEvent(new Event('cat-thinking:ai-settings-changed')))
  await expect(goals.getByRole('button', { name: '整理要点', exact: true })).toBeDisabled()
  for (const name of ['摘要', '大纲']) await panel(page).getByRole('checkbox', { name, exact: true }).uncheck()
  await expect(panel(page).getByRole('checkbox', { name: '摘要', exact: true })).toBeDisabled()
  await panel(page).getByRole('checkbox', { name: '导图', exact: true }).check()
  await expect(panel(page)).toContainText('当前连接不支持所需的大纲')
  await expect(panel(page).getByRole('button', { name: '生成所选内容', exact: true })).toBeDisabled()
  available = ['knowledge']
  await page.evaluate(() => window.dispatchEvent(new Event('cat-thinking:ai-settings-changed')))
  await expect(panel(page)).toContainText('当前连接不支持所需的大纲、导图')
  await panel(page).getByRole('checkbox', { name: '导图', exact: true }).uncheck()
  await panel(page).getByRole('checkbox', { name: '知识整理', exact: true }).check()
  await expect(panel(page).getByRole('button', { name: '生成所选内容', exact: true })).toBeEnabled()
  expect((await localSnapshot(page)).tasks).toEqual([])
  expect(mutations).toEqual([])
})

test('五类实际 pipeline 经 PostgreSQL 完成，刷新与服务重启不重复调用，推断可核对原文', async ({ page, request }) => {
  await importAndOpen(page)
  const task = await generateFive(page)
  for (const name of ['摘要结果', '大纲结果', '导图结果', '测验结果', '知识整理结果']) {
    await expect(panel(page).getByRole('region', { name, exact: true })).toBeVisible()
  }
  const knowledge = panel(page).getByRole('region', { name: '知识整理结果' })
  await expect(knowledge).toContainText('原文依据')
  await expect(knowledge).toContainText('应用 · 推断')
  await expect(knowledge).toContainText('基于能量转换证据的学习推断')
  await knowledge.getByRole('button', { name: '查看原文引用 1' }).last().click()
  await expect(panel(page).getByRole('region', { name: '原文引用' }).locator('mark')).toHaveText(expectedFact)
  const initial = await diagnostic(request, task.runId)
  expect(initial.run.request.artifacts).toEqual(['summary', 'outline', 'mindmap', 'quiz', 'knowledge'])
  expect(Object.values(initial.run.artifactStates).every((state) => state?.status === 'succeeded')).toBe(true)
  expect(initial.ledger).toMatchObject({ invocationCount: 6, unresolvedCount: 0, usage: { inputTokens: 120, outputTokens: 60 } })
  const usage = await request.get(`/api/analysis/v1/runs/${task.runId}/usage`)
  expect(usage.ok()).toBeTruthy()
  expect(await usage.json()).toMatchObject({ version: 1, invocationCount: 6, completeness: 'complete' })
  await reopen(page)
  expect((await localSnapshot(page)).tasks[0]?.runId).toBe(task.runId)
  const beforeRestart = await (await request.get('http://127.0.0.1:8790/__synthetic/status', { headers: privateHeaders() })).json()
  expect((await control(request, 'restart')).ok()).toBeTruthy()
  await expect.poll(async () => {
    try { return (await (await request.get('http://127.0.0.1:8790/__synthetic/status', { headers: privateHeaders() })).json()).generation }
    catch { return 0 }
  }, { timeout: 15_000 }).toBeGreaterThan(beforeRestart.generation)
  await reopen(page)
  await expect(panel(page).getByRole('region', { name: '导图结果' })).toContainText('光能转化为化学能')
  await expect(panel(page).getByRole('region', { name: '测验结果' }).locator('fieldset')).toHaveCount(5)
  expect((await diagnostic(request, task.runId)).ledger).toEqual(initial.ledger)
  await page.screenshot({ path: 'test-results/analysis-five-artifacts.png' })
})

test('独立导图应用重复操作只创建一次，引用源与关系重映射，手动编辑和刷新保持', async ({ page, request }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await importAndOpen(page)
  const task = await generateFive(page)
  const before = await localSnapshot(page)
  const original = before.docs.find((doc) => doc.id === task.docId)
  const originalSource = before.sources.find((source) => source.docId === task.docId)
  if (!original || !originalSource) throw new Error('Imported synthetic source missing')
  const mindmap = panel(page).getByRole('region', { name: '导图结果' })
  await mindmap.getByRole('button', { name: '创建独立导图' }).click()
  await expect(mindmap.getByRole('button', { name: '打开生成导图' })).toBeVisible()
  await mindmap.getByRole('button', { name: '创建独立导图' }).click()
  await expect(mindmap).toContainText('已找回之前创建的导图')
  const applied = await localSnapshot(page)
  expect(applied.receipts).toHaveLength(1)
  expect(applied.docs).toHaveLength(before.docs.length + 1)
  expect(applied.docs.find((doc) => doc.id === task.docId)).toEqual(original)
  expect(applied.sources.find((source) => source.id === originalSource.id)).toEqual(originalSource)
  const receipt = applied.receipts[0]
  const targetRecord = applied.docs.find((doc) => doc.id === receipt?.targetDocId)
  if (!targetRecord) throw new Error('Applied document missing')
  const target = JSON.parse(targetRecord.payload) as DocData
  const sourceCopy = applied.sources.find((source) => source.docId === target.id)
  if (!sourceCopy) throw new Error('Copied source missing')
  expect(target.id).not.toBe(task.docId)
  expect(sourceCopy.id).not.toBe(originalSource.id)
  expect(sourceCopy.text).toBe(originalSource.text)
  expect(sourceCopy.extractor).toBe(originalSource.extractor)
  expect(sourceCopy.charCount).toBe(originalSource.charCount)
  const originalNodes = new Set(Object.keys((JSON.parse(original.payload) as DocData).nodes))
  expect(Object.keys(target.nodes).some((id) => originalNodes.has(id))).toBe(false)
  expect(sourceCopy.anchors).toHaveLength(2)
  expect(expectedFactStart).toBeGreaterThan(0)
  expect(sourceCopy.anchors.every((anchor) => target.nodes[anchor.nodeId] !== undefined
    && anchor.start === expectedFactStart && anchor.end === expectedFactStart + expectedFact.length)).toBe(true)
  expect(target.relations).toHaveLength(1)
  expect(target.relations[0]?.sourceRefs).toEqual([{ version: 1, sourceId: sourceCopy.id, contentHash: sourceCopy.contentHash,
    start: expectedFactStart, end: expectedFactStart + expectedFact.length }])
  await mindmap.getByRole('button', { name: '打开生成导图' }).click()
  await expect(panel(page)).toBeHidden()
  await selectNode(page, 0)
  await page.keyboard.press('F2')
  const editor = page.locator('textarea.node-editor').first()
  await expect(editor).toBeVisible()
  await editor.fill('用户手动调整的导图根节点')
  await editor.press('Enter')
  await expect(editor).toBeHidden()
  await page.locator('input.doc-title').fill('保留手工修改的独立导图')
  await expect.poll(async () => {
    if (browserErrors.length) await testInfo.attach('synthetic-browser-errors', { body: JSON.stringify(browserErrors), contentType: 'application/json' })
    const saved = (await localSnapshot(page)).docs.find((doc) => doc.id === target.id)
    const payload = saved ? JSON.parse(saved.payload) as DocData : undefined
    return { title: payload?.title, rootText: payload?.nodes[payload.rootId]?.text }
  }).toEqual({ title: '保留手工修改的独立导图', rootText: '用户手动调整的导图根节点' })
  await page.getByRole('tab', { name: /合成学习文档/u }).click()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析完成')
  await panel(page).getByRole('region', { name: '导图结果' }).getByRole('button', { name: '创建独立导图' }).click()
  await expect(panel(page)).toContainText('已找回之前创建的导图')
  await reopen(page)
  await panel(page).getByRole('region', { name: '导图结果' }).getByRole('button', { name: '创建独立导图' }).click()
  await expect(panel(page)).toContainText('已找回之前创建的导图')
  const repeated = await localSnapshot(page)
  expect(repeated.receipts).toHaveLength(1)
  expect(repeated.docs).toHaveLength(applied.docs.length)
  const savedTarget = JSON.parse(repeated.docs.find((doc) => doc.id === target.id)?.payload ?? '{}') as DocData
  expect(savedTarget.title).toBe('保留手工修改的独立导图')
  expect(savedTarget.nodes[savedTarget.rootId]?.text).toBe('用户手动调整的导图根节点')
  expect(savedTarget.relations).toEqual(target.relations)
  expect((await diagnostic(request, task.runId)).ledger.invocationCount).toBe(6)
})

test('测验与待复习清单保留三题型边界、题目及原文定位、刷新恢复，重置不调用 Provider', async ({ page, request }, testInfo) => {
  await importAndOpen(page)
  const task = await generateFive(page)
  let quiz = panel(page).getByRole('region', { name: '测验结果' })
  await expect(quiz).toContainText('作答已保存到本机')
  await expect(quiz.locator('fieldset')).toHaveCount(5)
  await expect(quiz.locator('.analysis-quiz-answer')).toHaveCount(0)
  await expect(quiz.getByRole('region', { name: '本次待复习内容' })).toHaveCount(0)
  await quiz.locator('fieldset').nth(0).getByRole('radio', { name: '光能转化为化学能', exact: true }).check()
  await quiz.locator('fieldset').nth(1).getByRole('radio', { name: '错误', exact: true }).check()
  await quiz.getByRole('textbox', { name: '第 3 题简答' }).fill('输入为光能，输出储存在化学能中。')
  await expect(quiz.getByRole('button', { name: '提交练习' })).toBeEnabled()
  await quiz.getByRole('button', { name: '提交练习' }).click()
  await expect(quiz).toContainText('客观题：1 / 4 正确，2 题未答。简答题：1 / 1 已作答，0 题已自评。')
  await expect(quiz.locator('.analysis-quiz-answer')).toHaveCount(5)
  let review = quiz.getByRole('region', { name: '本次待复习内容' })
  await expect(review.getByRole('listitem')).toHaveCount(4)
  await expect(review).toContainText('第 2 题 · 与参考答案不一致')
  await expect(review).toContainText('第 3 题 · 简答待自评')
  await expect(review).toContainText('第 4 题 · 尚未作答')
  await review.getByRole('button', { name: '回看第 2 题', exact: true }).click()
  await expect(quiz.locator('fieldset').nth(1)).toBeFocused()
  const focusedQuestion = await quiz.locator('fieldset').nth(1).boundingBox()
  const modalHead = await panel(page).locator('.modal-head').boundingBox()
  expect(focusedQuestion?.y).toBeGreaterThanOrEqual((modalHead?.y ?? 0) + (modalHead?.height ?? 0))
  await review.getByRole('listitem').first().getByRole('button', { name: '查看原文引用 1', exact: true }).click()
  await expect(panel(page).getByRole('region', { name: '原文引用' }).locator('mark')).toHaveText(expectedFact)
  await quiz.getByRole('checkbox', { name: '自评：指出光能是输入', exact: true }).check()
  await expect(quiz).toContainText('1 题已自评')
  await expect(quiz).toContainText('作答已保存到本机')
  await expect(review).toContainText('第 3 题 · 自评还有待补充的要点')
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await review.evaluate((element) => element.scrollIntoView({ block: 'start' }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 375) await panel(page).screenshot({ path: testInfo.outputPath('quiz-review-375.png') })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const before = (await localSnapshot(page)).practices
  expect(before).toHaveLength(1)
  expect(before[0]).toMatchObject({ submitted: true, answers: { 'synthetic-question-1': 0, 'synthetic-question-2': false,
    'synthetic-question-3': '输入为光能，输出储存在化学能中。' }, selfAssessments: { 'synthetic-question-3': [true, false] } })
  expect(Object.keys(before[0] ?? {})).not.toContain('payload')
  expect(Object.keys(before[0] ?? {})).not.toContain('answerIndex')
  await reopen(page)
  quiz = panel(page).getByRole('region', { name: '测验结果' })
  review = quiz.getByRole('region', { name: '本次待复习内容' })
  await expect(quiz).toContainText('客观题：1 / 4 正确，2 题未答。简答题：1 / 1 已作答，1 题已自评。')
  await expect(quiz.getByRole('textbox', { name: '第 3 题简答' })).toHaveValue('输入为光能，输出储存在化学能中。')
  await expect(quiz.getByRole('checkbox', { name: '自评：指出光能是输入', exact: true })).toBeChecked()
  await expect(review).toContainText('第 3 题 · 自评还有待补充的要点')
  // Another tab can advance the persisted revision while this tab is still showing a valid form.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const record = (await db.quizPractices.toArray())[0]
    if (!record || typeof record.revision !== 'number') throw new Error('Missing public practice fixture')
    await db.quizPractices.put({ ...record, revision: record.revision + 1 })
  })
  await quiz.getByRole('checkbox', { name: '自评：指出化学能是输出', exact: true }).check()
  await expect(quiz.getByRole('button', { name: '重新读取练习', exact: true })).toBeVisible()
  await expect(review).toHaveCount(0)
  await quiz.getByRole('button', { name: '重新读取练习', exact: true }).click()
  await expect(review).toContainText('第 3 题 · 自评还有待补充的要点')
  await quiz.getByRole('checkbox', { name: '自评：指出化学能是输出', exact: true }).check()
  await expect(review.getByRole('listitem')).toHaveCount(3)
  await expect(review).not.toContainText('第 3 题')
  await quiz.getByRole('button', { name: '重新作答' }).click()
  await expect(quiz.getByRole('button', { name: '提交练习' })).toBeEnabled()
  await expect(quiz.locator('.analysis-quiz-answer')).toHaveCount(0)
  await expect(review).toHaveCount(0)
  await expect(quiz.getByRole('textbox', { name: '第 3 题简答' })).toHaveValue('')
  expect(await quiz.getByRole('radio').evaluateAll((radios) => radios.every((radio) => !(radio as HTMLInputElement).checked))).toBe(true)
  await expect.poll(async () => (await localSnapshot(page)).practices).toEqual([
    expect.objectContaining({ answers: {}, submitted: false, selfAssessments: {} }),
  ])
  expect((await diagnostic(request, task.runId)).ledger.invocationCount).toBe(6)
})

test('大纲恢复只解锁导图重试，明确重试导图之前不会增加调用', async ({ page, request }) => {
  await importAndOpen(page, ANALYSIS_SYNTHETIC.partial)
  await panel(page).getByRole('checkbox', { name: '导图', exact: true }).check()
  await panel(page).getByRole('button', { name: '生成所选内容', exact: true }).click()
  await expect(panel(page)).toContainText('任务：部分完成', { timeout: 20_000 })
  const task = (await localSnapshot(page)).tasks[0]
  if (!task?.runId) throw new Error('Dependency fixture missing run')
  const mindmap = panel(page).getByRole('region', { name: '导图结果' })
  await expect(mindmap.getByRole('button', { name: '重试导图' })).toHaveCount(0)
  expect((await diagnostic(request, task.runId)).ledger.invocationCount).toBe(3)
  await panel(page).getByRole('button', { name: '重试大纲' }).click()
  await expect(mindmap.getByRole('button', { name: '重试导图' })).toBeEnabled({ timeout: 20_000 })
  const recovered = await diagnostic(request, task.runId)
  expect(recovered.run.artifactStates.outline?.status).toBe('succeeded')
  expect(recovered.run.artifactStates.mindmap).toMatchObject({ status: 'failed', attempt: 1, error: { retryable: true } })
  expect(recovered.ledger.invocationCount).toBe(4)
  await mindmap.getByRole('button', { name: '重试导图' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  expect((await diagnostic(request, task.runId)).run.artifactStates.mindmap).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect((await diagnostic(request, task.runId)).ledger.invocationCount).toBe(5)
})
