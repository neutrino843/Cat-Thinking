import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { flush } = await import('/src/store/persist.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { mountKnowledgePracticeHarness } = await import('/src/test/KnowledgePracticeHarness.tsx')
    flush(); await db.docs.count(); await db.delete(); await db.open()
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source]); await db.analysisTasks.add(fixture.task)
    ;(window as unknown as { __stopKnowledgeHarness: () => void }).__stopKnowledgeHarness = mountKnowledgePracticeHarness(fixture.mindmap, fixture.quiz)
  })
})

test('knowledge → question → knowledge navigation keeps a single answer state and keyboard focus', async ({ page }) => {
  const dialog = page.locator('[data-test-learning-dialog]')
  await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('这个节点有 3 道相关练习')
  const child = dialog.locator('[data-mindmap-node-id="child"]')
  await child.getByRole('button', { name: '练习 1', exact: true }).click()
  const question = dialog.locator('[data-quiz-question-id="choice"]')
  await expect(question).toBeFocused()
  await question.getByRole('radio', { name: '正确项', exact: true }).check()
  await expect(dialog.getByText('正在保存作答…')).toHaveCount(0)
  await question.getByRole('button', { name: '对应知识点：分支', exact: true }).click()
  await expect(child).toBeFocused()
  await child.getByRole('button', { name: '练习 1', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(question).toBeFocused()
  await expect(question.getByRole('radio', { name: '正确项', exact: true })).toBeChecked()
  expect(await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return db.quizPractices.count() })).toBe(1)
})

test('source invalidation removes navigation and a late click never reconstructs a deleted task', async ({ page }) => {
  const dialog = page.locator('[data-test-learning-dialog]')
  await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('这个节点有 3 道相关练习')
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { notifyAnalysisBinding } = await import('/src/analysis/taskNotifications.ts')
    const task = (await db.analysisTasks.toArray())[0]
    await db.analysisTasks.delete(task.docId)
    notifyAnalysisBinding({ version: 1, docId: task.docId, type: 'deleted' })
  })
  await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('当前无法确认')
  await expect(dialog.getByRole('button', { name: '练习 1', exact: true })).toHaveCount(0)
  await expect(dialog.locator('[data-quiz-question-id]')).toHaveCount(0)
  expect(await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return db.analysisTasks.count() })).toBe(0)
})

for (const change of ['source', 'reference-answer'] as const) {
  test(`${change} identity change clears old navigation and answers without new calls`, async ({ page }) => {
    const dialog = page.locator('[data-test-learning-dialog]')
    await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('这个节点有 3 道相关练习')
    await dialog.locator('[data-quiz-question-id="choice"]').getByRole('radio', { name: '正确项', exact: true }).check()
    await expect(dialog.getByText('正在保存作答…')).toHaveCount(0)
    await page.evaluate(async (kind) => {
      const { db } = await import('/src/store/db.ts')
      const { notifyAnalysisBinding } = await import('/src/analysis/taskNotifications.ts')
      const task = (await db.analysisTasks.toArray())[0]
      if (kind === 'source') {
        const source = (await db.sources.toArray())[0]
        await db.sources.put({ ...source, text: `${source.text}已修订`, charCount: source.charCount + 3 })
      } else {
        const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
        const { artifactContentHash } = await import('/src/analysis/localArtifactIdentity.ts')
        const fixture = await localArtifactFixtures()
        fixture.quiz.docId = task.docId
        const question = fixture.quiz.payload.questions[0]
        if (question.type === 'multiple-choice') question.answerIndex = 1
        await db.analysisTasks.put({ ...task, revision: task.revision + 1, artifactIdentities: { ...task.artifactIdentities,
          quiz: { ...task.artifactIdentities.quiz, attempt: 2, runRevision: task.revision + 1, contentHash: await artifactContentHash(fixture.quiz) } } })
      }
      notifyAnalysisBinding({ version: 1, docId: task.docId, type: 'artifact' })
    }, change)
    await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('当前无法确认')
    await expect(dialog.locator('[data-quiz-question-id]')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '练习 1', exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return db.analysisTasks.count() })).toBe(1)
  })
}

test('same-title nodes retain separate precise links, including a question linked to one node only', async ({ page }) => {
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { artifactContentHash } = await import('/src/analysis/localArtifactIdentity.ts')
    const { mountKnowledgePracticeHarness } = await import('/src/test/KnowledgePracticeHarness.tsx')
    ;(window as unknown as { __stopKnowledgeHarness: () => void }).__stopKnowledgeHarness()
    const fixture = await localArtifactFixtures()
    const task = (await db.analysisTasks.toArray())[0]
    fixture.mindmap.docId = task.docId; fixture.quiz.docId = task.docId
    fixture.mindmap.payload.nodes.forEach((node) => { node.text = '相同标题' })
    fixture.mindmap.payload.nodes[0].evidenceIds = ['separate-evidence']
    fixture.quiz.payload.questions[1].evidenceIds = ['separate-evidence']
    task.artifactIdentities.mindmap.contentHash = await artifactContentHash(fixture.mindmap)
    task.artifactIdentities.quiz.contentHash = await artifactContentHash(fixture.quiz)
    await db.analysisTasks.put(task)
    mountKnowledgePracticeHarness(fixture.mindmap, fixture.quiz)
  })
  const dialog = page.locator('[data-test-learning-dialog]')
  await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('这个节点有 1 道相关练习')
  await expect(dialog.locator('[data-mindmap-node-id="root"] > .analysis-actions')).toContainText('相关练习 1 题')
  await expect(dialog.locator('[data-mindmap-node-id="child"] > .analysis-actions')).toContainText('相关练习 2 题')
  const choices = dialog.locator('[data-quiz-question-id="choice"]')
  await expect(choices.getByRole('button', { name: '对应知识点：相同标题', exact: true })).toHaveCount(1)
  await choices.getByRole('button', { name: '对应知识点：相同标题', exact: true }).click()
  await expect(dialog.locator('[data-mindmap-node-id="child"]')).toBeFocused()
})

test('mobile node and exercise navigation remains accessible without duplicating answers', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = page.locator('[data-test-learning-dialog]')
  await expect(dialog.getByRole('region', { name: '知识与练习联动' })).toContainText('这个节点有 3 道相关练习')
  await dialog.getByLabel('选择知识节点').selectOption('child')
  await dialog.getByRole('button', { name: '查看第 3 题', exact: true }).click()
  await expect(dialog.locator('[data-quiz-question-id="short"]')).toBeFocused()
  await dialog.getByRole('textbox', { name: '第 3 题简答' }).fill('我自己的解释')
  await dialog.getByRole('button', { name: '提交练习', exact: true }).click()
  await expect(dialog.getByText('客观题：', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: '重新作答', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '第 3 题简答' })).toHaveValue('')
})

test('archived live practice keeps multiple submissions, and independent mind maps save exact node mappings', async ({ page }) => {
  const archive = await page.evaluate(async () => {
    const { createCourse, createLearningArchive } = await import('/src/learning/repository.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { db } = await import('/src/store/db.ts')
    const fixture = await localArtifactFixtures()
    const task = (await db.analysisTasks.toArray())[0]
    fixture.quiz.docId = task.docId; fixture.mindmap.docId = task.docId
    const course = await createCourse({ name: '合成课程' })
    return createLearningArchive({ courseId: course.id, docId: task.docId, runId: task.runId, artifacts: [fixture.mindmap, fixture.quiz] })
  })
  const dialog = page.locator('[data-test-learning-dialog]')
  const question = dialog.locator('[data-quiz-question-id="choice"]')
  await question.getByRole('radio', { name: '正确项', exact: true }).check()
  await dialog.getByRole('button', { name: '提交练习', exact: true }).click()
  await expect(dialog.getByText('正在保存作答…')).toHaveCount(0)
  await dialog.getByRole('button', { name: '重新作答', exact: true }).click()
  await question.getByRole('radio', { name: '其他项', exact: true }).check()
  await dialog.getByRole('button', { name: '提交练习', exact: true }).click()
  await expect(dialog.getByText('正在保存作答…')).toHaveCount(0)
  await question.getByRole('combobox', { name: '题目 choice 补学原因', exact: true }).selectOption('概念混淆')
  await question.getByRole('combobox', { name: '题目 choice 疑问', exact: true }).selectOption('answer')
  await question.getByRole('textbox', { name: '题目 choice 复核备注', exact: true }).fill('需要对照原文复核')
  await question.getByRole('button', { name: '保存补学反馈', exact: true }).click()
  await expect(question.getByText('疑问已保存', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: '创建独立导图', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '打开生成导图', exact: true })).toBeVisible()
  const result = await page.evaluate(async (courseId) => {
    const { loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const { db } = await import('/src/store/db.ts')
    const snapshot = await loadCourseSnapshot(courseId)
    const binding = snapshot.bindings[0]
    const doc = JSON.parse((await db.docs.get(binding.docId)).payload)
    return { answers: snapshot.attempts.map((attempt) => attempt.answer).sort(), knownTimes: snapshot.attempts.every((attempt) => attempt.submittedAt !== null),
      issue: snapshot.issues[0]?.reason, feedbackReason: snapshot.assessments.find((assessment) => assessment.reason)?.reason,
      mappings: binding.mappings.map((mapping) => ({ original: mapping.generatedNodeId, nodePresent: !!doc.nodes[mapping.localNodeId],
        pointPresent: snapshot.points.some((point) => point.id === mapping.pointId && point.generatedNodeId === mapping.generatedNodeId) })) }
  }, archive.courseId)
  expect(result.answers).toEqual([0, 1]); expect(result.knownTimes).toBe(true)
  expect(result.issue).toBe('answer'); expect(result.feedbackReason).toBe('概念混淆：需要对照原文复核')
  expect(result.mappings).toEqual([{ original: 'root', nodePresent: true, pointPresent: true }, { original: 'child', nodePresent: true, pointPresent: true }])
})

test('save-to-course entry captures verified source and results then opens the course workspace', async ({ page }) => {
  const dialog = page.locator('[data-test-learning-dialog]')
  await dialog.getByRole('textbox', { name: '新课程名称', exact: true }).fill('从结果保存的课程')
  await dialog.getByRole('button', { name: '保存到课程', exact: true }).click()
  await expect(dialog.getByText('学习资料已保存到课程。', { exact: false })).toBeVisible()
  const stored = await page.evaluate(async () => {
    const { listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const course = (await listCourses())[0]
    const snapshot = await loadCourseSnapshot(course.id)
    return { name: course.name, archiveCount: snapshot.archives.length, pointCount: snapshot.points.length, sourceCount: snapshot.archives[0].sources.length,
      artifacts: snapshot.archives[0].artifacts.map((artifact) => artifact.kind) }
  })
  expect(stored).toEqual({ name: '从结果保存的课程', archiveCount: 1, pointCount: 2, sourceCount: 1, artifacts: ['mindmap', 'quiz'] })
  await dialog.getByRole('button', { name: '进入课程继续学习', exact: true }).click()
  await expect(page.locator('[data-learning-workspace]')).toBeVisible()
  await expect(page.locator('[data-learning-workspace]').getByRole('combobox', { name: '当前课程' })).toContainText('从结果保存的课程')
})

test('same artifact ID with replaced content cannot append live history to an older archive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { artifactContentHash } = await import('/src/analysis/localArtifactIdentity.ts')
    const { analysisTaskRepository } = await import('/src/analysis/taskPersistence.ts')
    const { saveQuizPractice } = await import('/src/analysis/quizPractice.ts')
    const { createCourse, createLearningArchive, recordArchivedQuizSubmission, findArchiveForArtifact, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const fixture = await localArtifactFixtures()
    const task = (await db.analysisTasks.toArray())[0]
    fixture.quiz.docId = task.docId
    const course = await createCourse({ name: '引用版本测试' })
    const archive = await createLearningArchive({ courseId: course.id, docId: task.docId, runId: task.runId, artifacts: [fixture.quiz] })
    const context = { docId: task.docId, runId: task.runId, artifact: fixture.quiz }
    const first = await saveQuizPractice(context, { answers: { choice: 0 }, submitted: true, selfAssessments: {}, submissionId: 'first-submit', submittedAt: 1 }, null)
    let wrongHashRejected = false, wrongSourceRejected = false
    try { await recordArchivedQuizSubmission(archive.id, { ...first, artifactHash: 'f'.repeat(64) }, 'bad-hash') } catch { wrongHashRejected = true }
    try { await recordArchivedQuizSubmission(archive.id, { ...first, sourceFingerprint: 'f'.repeat(64) }, 'bad-source') } catch { wrongSourceRejected = true }
    const updated = structuredClone(fixture.quiz)
    if (updated.payload.questions[0].type === 'multiple-choice') updated.payload.questions[0].answerIndex = 1
    const hash = await artifactContentHash(updated)
    await analysisTaskRepository.save({ ...task, revision: task.revision + 1, artifactIdentities: { ...task.artifactIdentities,
      quiz: { ...task.artifactIdentities.quiz, attempt: 2, runRevision: task.revision + 1, contentHash: hash } } })
    const next = await saveQuizPractice({ ...context, artifact: updated }, { answers: { choice: 1 }, submitted: true, selfAssessments: {}, submissionId: 'changed-submit', submittedAt: 2 }, null)
    const matched = await findArchiveForArtifact(task.docId, task.runId, updated.id, { artifactHash: next.artifactHash, sourceFingerprint: next.sourceFingerprint })
    return { wrongHashRejected, wrongSourceRejected, matchesOld: !!matched, attempts: (await loadCourseSnapshot(course.id)).attempts.map((attempt) => attempt.answer), liveSaved: !!await db.quizPractices.get(next.id) }
  })
  expect(result).toEqual({ wrongHashRejected: true, wrongSourceRejected: true, matchesOld: false, attempts: [0], liveSaved: true })
})

test('an archived question issue disables live submission before CAS and preserves the draft until resolved', async ({ page }) => {
  const dialog = page.locator('[data-test-learning-dialog]')
  await dialog.getByRole('textbox', { name: '新课程名称', exact: true }).fill('题目疑问课程')
  await dialog.getByRole('button', { name: '保存到课程', exact: true }).click()
  await expect(dialog.getByText('学习资料已保存到课程。', { exact: false })).toBeVisible()
  const question = dialog.locator('[data-quiz-question-id="choice"]')
  await question.getByRole('radio', { name: '正确项', exact: true }).check()
  await expect(dialog.getByText('正在保存作答…')).toHaveCount(0)
  const blocked = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { saveEntity, listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const { saveQuizPractice } = await import('/src/analysis/quizPractice.ts')
    const course = (await listCourses())[0]; const snapshot = await loadCourseSnapshot(course.id)
    const archive = snapshot.archives[0]; const quiz = archive.artifacts.find((artifact) => artifact.kind === 'quiz')
    const issue = await saveEntity({ ...learningBase(course.id), kind: 'issue', question: { archiveId: archive.id, artifactId: quiz.id, questionId: 'choice', confirmed: false }, reason: 'answer', note: '跨页面标记', status: 'open' }, null)
    const draft = (await db.quizPractices.toArray())[0]
    let rejected = false
    try { await saveQuizPractice({ docId: draft.docId, runId: draft.runId, artifact: quiz }, { answers: draft.answers, submitted: true,
      selfAssessments: {}, submissionId: 'late-submit', submittedAt: Date.now() }, draft.revision) } catch { rejected = true }
    const unchanged = await db.quizPractices.get(draft.id)
    return { issueId: issue.id, rejected, sameRevision: unchanged.revision === draft.revision, submitted: unchanged.submitted, answer: unchanged.answers.choice }
  })
  expect(blocked).toMatchObject({ rejected: true, sameRevision: true, submitted: false, answer: 0 })
  await expect(question.getByRole('radio', { name: '正确项', exact: true })).toBeDisabled()
  await expect(question.getByRole('radio', { name: '正确项', exact: true })).toBeChecked()
  await expect(dialog.getByRole('button', { name: '提交练习', exact: true })).toBeDisabled()
  await page.evaluate(async (issueId) => {
    const { getEntity, saveEntity } = await import('/src/learning/repository.ts')
    const issue = await getEntity(issueId, 'issue'); await saveEntity({ ...issue, status: 'resolved' }, issue.revision)
  }, blocked.issueId)
  await expect(question.getByRole('radio', { name: '正确项', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '提交练习', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '提交练习', exact: true }).click()
  await expect(dialog.getByText('客观题：', { exact: false })).toBeVisible()
})
