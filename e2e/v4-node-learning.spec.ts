import { expect, test, type Page } from '@playwright/test'
import { analysisRunSchema, type AnalysisRunV1, type ArtifactEnvelopeV1, type EngineCapabilitiesV1 } from '@cat-thinking/analysis-contracts'

async function seed(page: Page, legacy = false) {
  return page.evaluate(async ({ legacy }) => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { buildFixture } = await import('/src/test/fixture.ts')
    const { createCourse, attachDocument } = await import('/src/learning/repository.ts')
    const { captureNodeSources, createNodePoint, beginNodeRound, reloadNodeState, saveNodeDraft, updateNodeState, connectNodePoints } = await import('/src/learning/nodeLearning.ts')
    const doc = buildFixture({ text: '两章合成课件', children: [{ text: '前章定义' }, { text: '当前推导' }] })
    const text = '前章定义给出运算的条件。当前推导需要先核对这一条件，再进行变换。'
    const source = { version: 1 as const, id: 'v4-browser-source', docId: doc.id, name: '合成课件.txt', kind: 'text' as const, mime: 'text/plain', size: text.length, lastModified: 1, importedAt: 1, extractor: 'v4-synthetic', text, charCount: text.length, anchors: [] }
    await saveDocumentBundle(doc, [source])
    const course = await createCourse({ name: legacy ? '旧课程样例' : 'V4 专业课', ...(legacy ? {} : { learningMode: 'nodes' as const }) })
    await attachDocument(course.id, doc.id)
    let state = await captureNodeSources(course.id, doc.id, 'slides')
    const first = await createNodePoint(state, state.chapters[0].id, '前章定义', [{ snapshotId: state.sources[0].id, start: 0, end: 13 }])
    state = await reloadNodeState(state.id)
    state = await updateNodeState(state, (next) => next.chapters.push({ id: 'browser-chapter-two', title: '第二章' }))
    const second = await createNodePoint(state, 'browser-chapter-two', '当前推导', [{ snapshotId: state.sources[0].id, start: 0, end: text.length }])
    state = await reloadNodeState(state.id)
    const older = await beginNodeRound(state, second.id); state = await reloadNodeState(state.id)
    state = await saveNodeDraft(state, older, '较早的关键问题', '较早的推导草稿')
    const newer = await beginNodeRound(state, second.id); state = await reloadNodeState(state.id)
    await saveNodeDraft(state, newer, '较新的另一个问题', '较新的草稿')
    await connectNodePoints(course.id, first.id, second.id, 'prerequisite', '当前步骤依赖前章条件')
    return { courseId: course.id, stateId: state.id, pointId: second.id, older, newer }
  }, { legacy })
}

async function open(page: Page) {
  await page.getByRole('button', { name: '今日学习', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '课程学习工作台' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ version: 1, error: { code: 'service_unavailable', category: 'availability', retryable: false, message: 'Synthetic offline' } }) }))
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
})

test('autosaves a free derivation, explicitly collects it, and restores chapter review without AI', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/')) writes.push(r.url()) })
  await seed(page); await open(page)
  const workspace = page.getByRole('region', { name: '节点学习工作区' })
  await expect(workspace).toBeVisible()
  await workspace.getByLabel('我已经想到的步骤', { exact: true }).fill('根据前章条件，先验证 $x_1^2$ 的适用范围。')
  await expect(workspace.getByText('草稿已保存在本机，尚未自动收录为个人理解。', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: '保存为个人理解', exact: true }).click()
  await expect(workspace.getByText('个人理解与历史修订', { exact: true })).toBeVisible()
  await page.reload(); await open(page)
  await expect(workspace.getByLabel('我已经想到的步骤', { exact: true })).toHaveValue(/根据前章条件/)
  await workspace.getByRole('button', { name: '整章复习', exact: true }).click()
  const review = workspace.getByRole('region', { name: '整章复习' })
  await review.getByText('当前推导', { exact: true }).click()
  await expect(review.locator('.katex').first()).toBeVisible()
  await expect(review).toContainText('当前步骤依赖前章条件')
  expect(writes).toEqual([])
})

test('returns from a prerequisite to the exact earlier round instead of the latest question', async ({ page }) => {
  const ids = await seed(page); await open(page)
  await page.getByLabel('学习轮次', { exact: true }).selectOption(ids.older)
  await expect(page.getByLabel('这一轮想弄清什么', { exact: true })).toHaveValue('较早的关键问题')
  await page.getByRole('button', { name: /查看关联节点.*前章定义/ }).click()
  await page.getByRole('button', { name: '返回刚才的知识节点', exact: true }).click()
  await expect(page.getByLabel('这一轮想弄清什么', { exact: true })).toHaveValue('较早的关键问题')
  await expect(page.getByLabel('我已经想到的步骤', { exact: true })).toHaveValue('较早的推导草稿')
})

test('a clean form adopts an external update before further editing', async ({ page }) => {
  const ids = await seed(page); await open(page)
  await page.evaluate(async ({ stateId, newer }) => {
    const { reloadNodeState, saveNodeDraft } = await import('/src/learning/nodeLearning.ts')
    await saveNodeDraft(await reloadNodeState(stateId), newer, '外部更新的问题', '另一窗口的新内容')
  }, ids)
  await expect(page.getByLabel('我已经想到的步骤', { exact: true })).toHaveValue('另一窗口的新内容')
  await page.getByLabel('我已经想到的步骤', { exact: true }).fill('在已同步内容上继续')
  await expect(page.getByText('草稿已保存在本机，尚未自动收录为个人理解。', { exact: true })).toBeVisible()
  const saved = await page.evaluate(async ({ stateId }) => { const { reloadNodeState } = await import('/src/learning/nodeLearning.ts'); return (await reloadNodeState(stateId)).rounds.at(-1)?.input }, ids)
  expect(saved).toBe('在已同步内容上继续')
})

test('legacy courses keep their old default and can opt into node learning', async ({ page }) => {
  await seed(page, true); await open(page)
  await expect(page.getByRole('region', { name: '节点学习工作区' })).toHaveCount(0)
  await page.getByRole('button', { name: '节点学习', exact: true }).click()
  await expect(page.getByRole('region', { name: '节点学习工作区' })).toBeVisible()
})

test('an empty browser can inspect and restore a V4 course package without a placeholder course', async ({ page }) => {
  const ids = await seed(page)
  const payload = await page.evaluate(async ({ courseId }) => { const { exportCoursePackage } = await import('/src/learning/coursePackage.ts'); return (await exportCoursePackage(courseId)).text() }, ids)
  await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); await db.learningRecords.clear() })
  await open(page)
  await page.getByLabel('选择课程包', { exact: true }).setInputFiles({ name: 'synthetic.mszcourse', mimeType: 'application/json', buffer: Buffer.from(payload) })
  await page.getByRole('button', { name: '检查课程包', exact: true }).click()
  await page.getByRole('button', { name: '确认恢复为新课程', exact: true }).click()
  await expect(page.getByRole('region', { name: '节点学习工作区' })).toBeVisible()
  await expect(page.getByLabel('我已经想到的步骤', { exact: true })).toHaveValue('较新的草稿')
  await expect(page.getByRole('button', { name: /查看关联节点.*前章定义/ })).toBeVisible()
})

test('node hint runs through the real controller, explicit viewing, source links and archived recovery with synthetic transport', async ({ page }) => {
  let run: AnalysisRunV1 | undefined
  let artifact: ArtifactEnvelopeV1 | undefined
  let created = 0
  const capabilities: EngineCapabilitiesV1 = { service: 'cat-analysis-engine', serviceVersion: 'v4-synthetic', acceptsRuns: true, degradedReasons: [], contractVersions: [1], qualityProfiles: ['standard'], artifactKinds: ['summary'], maxSourcesPerRun: 20, maxSourceCharacters: 2_000_000, maxUploadPartBytes: 512000, supportsSse: false, supportsCancellation: true, supportsExternalKnowledge: false, retentionSeconds: 3600 }
  await page.route('**/api/analysis/v1/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname
    const reply = (json: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
    if (path.endsWith('/capabilities')) return reply(capabilities)
    if (path.endsWith('/runs') && request.method() === 'POST') {
      created++
      const body = request.postDataJSON()
      expect(body.request.options.invocationLimit).toBe(8)
      run = analysisRunSchema.parse({ version: 1, id: 'v4-synthetic-run', docId: body.request.docId, requestKey: body.request.requestKey, request: body.request, revision: 1, status: 'receiving', progress: 0, coverage: { input: 0, analysis: 0, chunksCompleted: 0, chunksFailed: 0, chunksTotal: 0 }, providerRoutes: [], artifactStates: { summary: { status: 'pending', attempt: 0, updatedAt: 1 } }, usage: { inputTokens: 20, outputTokens: 10, estimatedCostMicros: 0, currency: 'USD' }, createdAt: 1, updatedAt: 1 })
      return reply({ version: 1, run, reused: false })
    }
    if (!run) return route.fulfill({ status: 404, body: '{}' })
    if (request.method() === 'PUT' && path.includes('/sources/')) { const part = request.postDataJSON(); return reply({ version: 1, sourceId: part.sourceId, receivedParts: part.partCount, partCount: part.partCount, complete: true, computedHash: part.contentHash }) }
    if (path.endsWith('/start')) {
      const source = run.request.manifest.sources[0]
      const grounded = { id: 'grounded-step', text: '先核对前章定义中的运算条件，再尝试当前变换。', evidenceIds: ['evidence-node'], citations: [{ version: 1 as const, provenance: 'source' as const, sourceId: source.sourceId, start: 0, end: 10 }] }
      artifact = { version: 1, schemaVersion: 1, id: 'v4-summary', runId: run.id, docId: run.docId, sourceContentHashes: run.request.manifest.sources.map((s) => s.contentHash), createdAt: 1, updatedAt: 2, kind: 'summary', payload: { overview: grounded, keyPoints: [{ ...grounded, id: 'grounded-key' }], confusions: [] } }
      run = { ...run, status: 'succeeded', revision: 2, progress: 1, coverage: { input: 1, analysis: 1, chunksCompleted: 1, chunksFailed: 0, chunksTotal: 1 }, artifactStates: { summary: { status: 'succeeded', attempt: 1, artifactId: artifact.id, updatedAt: 2 } } }
      return reply({ version: 1, run })
    }
    if (path.endsWith('/usage')) return reply({ version: 1, runId: run.id, usage: run.usage, invocationCount: 2, unresolvedCount: 0, estimatedInputTokens: 20, reservedOutputTokens: 4096, completeness: 'complete' })
    if (path.endsWith('/artifacts/summary')) return reply(artifact)
    return reply(run)
  })
  await seed(page); await open(page)
  await page.getByRole('button', { name: '准备第一级提示', exact: true }).click()
  const generate = page.getByRole('button', { name: '确认并生成（使用模型额度）', exact: true })
  await expect(generate).toBeEnabled(); expect(created).toBe(0)
  await generate.click()
  const view = page.getByRole('button', { name: '查看提示并记录辅助', exact: true })
  await expect(view).toBeEnabled()
  await expect(page.getByText('先核对前章定义中的运算条件，再尝试当前变换。', { exact: true })).toHaveCount(0)
  await view.click()
  await expect(page.getByText('先核对前章定义中的运算条件，再尝试当前变换。', { exact: true }).first()).toBeVisible()
  const recorded = await page.evaluate(async () => { const { listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts'); const snapshot = await loadCourseSnapshot((await listCourses())[0].id); return { events: snapshot.nodeWorkspace?.events.filter((e) => e.type === 'hint-viewed').length, archive: snapshot.nodeWorkspace?.supports[0].archiveId } })
  expect(recorded.events).toBe(1); expect(recorded.archive).toBeTruthy()
  await page.reload(); await open(page)
  await expect(page.getByText('先核对前章定义中的运算条件，再尝试当前变换。', { exact: true }).first()).toBeVisible()
  expect(created).toBe(1)
})

for (const width of [320, 375, 414, 768, 1366]) test(`node workspace remains usable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await seed(page); await open(page)
  const input = page.getByLabel('我已经想到的步骤', { exact: true })
  await input.fill('长公式与节点内容需要完整保存；不能依靠裁切隐藏。')
  await expect(page.getByText('草稿已保存在本机，尚未自动收录为个人理解。', { exact: true })).toBeVisible()
  const save = page.getByRole('button', { name: '保存为个人理解', exact: true })
  await save.scrollIntoViewIfNeeded(); await save.click()
  await page.screenshot({ path: info.outputPath(`v4-${width}.png`), fullPage: true })
  const box = await save.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(44)
})
