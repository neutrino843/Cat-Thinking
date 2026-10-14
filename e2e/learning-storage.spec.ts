import { expect, test } from '@playwright/test'

// Dedicated fresh Chromium contexts: public synthetic content, no user profile or real provider calls.
test.beforeEach(async ({ page }) => {
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { flush } = await import('/src/store/persist.ts')
    flush(); await db.docs.count(); await db.delete(); await db.open()
  })
})

test('local learning closes, reopens, and restores the encrypted course with new IDs without calling a provider', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const { createCourse, createLearningArchive, saveEntity, savePracticeBundle, loadCourseSnapshot } = await import('/src/learning/repository.ts')
    const { exportCoursePackage, previewCoursePackage, restoreCoursePackage } = await import('/src/learning/coursePackage.ts')
    let providerCalls = 0; const previousFetch = window.fetch
    window.fetch = async () => { providerCalls++; throw new Error('provider calls forbidden in learning storage test') }
    try {
      const f = await localArtifactFixtures(); const course = await createCourse({ name: '公开合成浏览器课程' })
      f.doc.nodes[f.doc.rootId].attachments = [{ id: 'test-attachment', blobId: 'test-blob', name: '合成.txt', size: 12, mime: 'text/plain' }]
      await saveDocumentBundle(f.doc, [f.source], new Map([['test-blob', new Blob(['公开附件内容'], { type: 'text/plain' })]])); await db.analysisTasks.add(f.task)
      const archive = await createLearningArchive({ courseId: course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.mindmap, f.quiz] })
      const ref = { archiveId: archive.id, artifactId: f.quiz.id, questionId: 'choice', confirmed: true }
      const draft = await saveEntity({ ...learningBase(course.id), kind: 'draft', question: ref, answer: 0, answerRevealed: false, attemptId: 'browser-attempt' }, null)
      const at = Date.UTC(2026, 9, 13, 8)
      const attempt = { ...learningBase(course.id, draft.attemptId, at), kind: 'attempt', question: ref, answer: 0, submittedAt: at, learningDate: '2026-10-13', answerRevealed: false, origin: 'practice' }
      await savePracticeBundle(attempt, { ...learningBase(course.id, 'browser-assessment', at), kind: 'assessment', attemptId: attempt.id, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true }, { ...learningBase(course.id, 'browser-review', at), kind: 'schedule', question: ref, status: 'active', dueDate: '2026-10-14', stage: 1, manual: true, ruleVersion: 'manual-v1', lastAttemptId: attempt.id }, null, { kind: 'draft', id: draft.id, expectedRevision: draft.revision })
      await db.analysisTasks.delete(f.doc.id); db.close(); await db.open()
      const reopened = await loadCourseSnapshot(course.id)
      const file = await exportCoursePackage(course.id, { password: 'public-synthetic-password' })
      let incorrectPasswordRejected = false
      try { await previewCoursePackage(file, { password: 'wrong-password' }) } catch { incorrectPasswordRejected = true }
      const preview = await previewCoursePackage(file, { password: 'public-synthetic-password' }); const restored = await restoreCoursePackage(preview)
      const snapshot = await loadCourseSnapshot(restored.id); const doc = JSON.parse((await db.docs.get(snapshot.docs[0].id)).payload)
      const attachment = await db.blobs.get(doc.nodes[doc.rootId].attachments[0].blobId)
      const restoredSources = await db.sources.where('docId').equals(doc.id).toArray()
      return { reopenedAttempts: reopened.attempts.length, reopenedDrafts: reopened.drafts.length, providerCalls, incorrectPasswordRejected,
        newCourse: restored.id !== course.id, newDoc: doc.id !== f.doc.id, newNode: doc.rootId !== f.doc.rootId, newSource: restoredSources[0].id !== f.source.id,
        newArchive: snapshot.archives[0].id !== archive.id, preservedProvenance: snapshot.archives[0].provenanceDocId === f.doc.id && snapshot.archives[0].runId === f.quiz.runId,
        independentQuote: snapshot.archives[0].sources[0].text === f.source.text, attemptLinked: snapshot.attempts[0].question.archiveId === snapshot.archives[0].id,
        scheduleLinked: snapshot.schedules[0].lastAttemptId === snapshot.attempts[0].id, attachment: await attachment.blob.text(), taskCount: await db.analysisTasks.count(), originalsPreserved: !!await db.docs.get(f.doc.id) }
    } finally { window.fetch = previousFetch }
  })
  expect(result).toEqual({ reopenedAttempts: 1, reopenedDrafts: 0, providerCalls: 0, incorrectPasswordRejected: true, newCourse: true, newDoc: true, newNode: true, newSource: true, newArchive: true, preservedProvenance: true, independentQuote: true, attemptLinked: true, scheduleLinked: true, attachment: '公开附件内容', taskCount: 0, originalsPreserved: true })
})

test('actual IndexedDB rollback leaves no partial restored course when a source write fails', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { createCourse, createLearningArchive } = await import('/src/learning/repository.ts')
    const { exportCoursePackage, previewCoursePackage, restoreCoursePackage } = await import('/src/learning/coursePackage.ts')
    const f = await localArtifactFixtures(); await saveDocumentBundle(f.doc, [f.source]); await db.analysisTasks.add(f.task)
    const course = await createCourse({ name: '公开合成回滚测试' }); await createLearningArchive({ courseId: course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.mindmap, f.quiz] })
    const preview = await previewCoursePackage(await exportCoursePackage(course.id))
    const before = { records: await db.learningRecords.count(), docs: await db.docs.count(), sources: await db.sources.count() }
    const fail = () => { throw new Error('synthetic original-text save failure') }; db.sources.hook('creating', fail)
    let rejected = false
    try { await restoreCoursePackage(preview) } catch { rejected = true } finally { db.sources.hook('creating').unsubscribe(fail) }
    const after = { records: await db.learningRecords.count(), docs: await db.docs.count(), sources: await db.sources.count() }
    return { before, after, rejected }
  })
  expect(result.rejected).toBe(true); expect(result.after).toEqual(result.before)
})

test('encrypted course restores into a genuinely empty browser context with sources, history and attachments', async ({ page, browser }) => {
  const exported = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { createCourse, createLearningArchive, appendAttempt } = await import('/src/learning/repository.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const { exportCoursePackage } = await import('/src/learning/coursePackage.ts')
    const f = await localArtifactFixtures(); const course = await createCourse({ name: '干净环境恢复课程' })
    f.doc.nodes[f.doc.rootId].attachments = [{ id: 'portable-attachment', blobId: 'portable-blob', name: '公开.txt', size: 12, mime: 'text/plain' }]
    await saveDocumentBundle(f.doc, [f.source], new Map([['portable-blob', new Blob(['公开附件内容'], { type: 'text/plain' })]]))
    await db.analysisTasks.add(f.task)
    const archive = await createLearningArchive({ courseId: course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.mindmap, f.quiz] })
    const at = Date.UTC(2026, 9, 14, 0)
    await appendAttempt({ ...learningBase(course.id, 'portable-attempt', at), kind: 'attempt',
      question: { archiveId: archive.id, artifactId: f.quiz.id, questionId: 'choice', confirmed: true },
      answer: 0, submittedAt: at, learningDate: '2026-10-14', answerRevealed: false, origin: 'practice' })
    const blob = await exportCoursePackage(course.id, { password: 'public-transfer-password' })
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), originalCourseId: course.id, sourceText: f.source.text }
  })
  const isolated = await browser.newContext()
  try {
    const restoredPage = await isolated.newPage()
    let generationCalls = 0
    await restoredPage.route('**/api/**', (route) => {
      if (route.request().method() === 'POST') generationCalls++
      return route.abort()
    })
    // A module URL does not initialize the app or create a welcome document.
    await restoredPage.goto('/src/main.tsx')
    const result = await restoredPage.evaluate(async (bytes) => {
      const { db } = await import('/src/store/db.ts')
      const { previewCoursePackage, restoreCoursePackage } = await import('/src/learning/coursePackage.ts')
      const { listCourses, loadCourseSnapshot } = await import('/src/learning/repository.ts')
      const before = { courses: (await listCourses()).length, docs: await db.docs.count(), sources: await db.sources.count() }
      const preview = await previewCoursePackage(new Blob([new Uint8Array(bytes)]), { password: 'public-transfer-password' })
      const course = await restoreCoursePackage(preview); const snapshot = await loadCourseSnapshot(course.id)
      const doc = JSON.parse((await db.docs.get(snapshot.docs[0].id)).payload)
      const attachment = await db.blobs.get(doc.nodes[doc.rootId].attachments[0].blobId)
      return { before, courseId: course.id, courses: (await listCourses()).length, sources: snapshot.archives[0].sources[0].text,
        answer: snapshot.attempts[0].answer, historyLinked: snapshot.attempts[0].question.archiveId === snapshot.archives[0].id,
        attachment: await attachment.blob.text(), taskCount: await db.analysisTasks.count() }
    }, exported.bytes)
    expect(result.before).toEqual({ courses: 0, docs: 0, sources: 0 })
    expect(result.courseId).not.toBe(exported.originalCourseId)
    expect(result).toMatchObject({ courses: 1, sources: exported.sourceText, answer: 0, historyLinked: true, attachment: '公开附件内容', taskCount: 0 })
    expect(generationCalls).toBe(0)
  } finally { await isolated.close() }
})

test('concurrent submissions, same-time assessment order, schedule conflicts and history fences use genuine IndexedDB', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const { createCourse, createLearningArchive, appendAttempt, appendAssessment, loadCourseSnapshot, saveEntity, savePracticeBundle, deletePracticeHistory } = await import('/src/learning/repository.ts')
    const f = await localArtifactFixtures(); await saveDocumentBundle(f.doc, [f.source]); await db.analysisTasks.add(f.task)
    const course = await createCourse({ name: '公开合成并发测试' }); const archive = await createLearningArchive({ courseId: course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.quiz] })
    const question = { archiveId: archive.id, artifactId: f.quiz.id, questionId: 'choice', confirmed: false }
    const attempt = { ...learningBase(course.id, 'same-submit', 1), kind: 'attempt', question, answer: 0, submittedAt: 1, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' }
    await Promise.all([appendAttempt(attempt), appendAttempt(attempt)])
    for (const id of ['z-first', 'a-second']) await appendAssessment({ ...learningBase(course.id, id, 1), kind: 'assessment', attemptId: attempt.id, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true })
    const before = await loadCourseSnapshot(course.id)
    const schedule = await saveEntity({ ...learningBase(course.id, 'schedule', 1), kind: 'schedule', question, status: 'active', dueDate: '2026-10-14', stage: 0, manual: true, ruleVersion: 'manual-v1' }, null)
    let staleRejected = false
    try { await savePracticeBundle({ ...attempt, id: 'new-submit' }, undefined, { ...schedule, dueDate: '2026-10-15' }, null) } catch { staleRejected = true }
    const afterConflict = await loadCourseSnapshot(course.id)
    await deletePracticeHistory(course.id, course.revision)
    let resurrectRejected = false
    try { await appendAttempt(attempt) } catch { resurrectRejected = true }
    const cleared = await loadCourseSnapshot(course.id)
    return { attemptCount: before.attempts.length, chronological: before.assessments.map((e) => e.id), sequences: before.assessments.map((e) => e.sequence), staleRejected, conflictAttemptCount: afterConflict.attempts.length, clearedCount: cleared.attempts.length, paused: cleared.schedules[0].status, resurrectRejected }
  })
  expect(result).toEqual({ attemptCount: 1, chronological: ['z-first', 'a-second'], sequences: [1, 2], staleRejected: true, conflictAttemptCount: 1, clearedCount: 0, paused: 'paused', resurrectRejected: true })
})

test('liveQuery observes both manual points and validated archives without losing Dexie context', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { learningBase } = await import('/src/learning/model.ts')
    const { liveQuery } = await import('/src/test/LearningObservationHarness.ts')
    const { createCourse, createLearningArchive, loadCourseSnapshot, saveEntity } = await import('/src/learning/repository.ts')
    const f = await localArtifactFixtures(); await saveDocumentBundle(f.doc, [f.source]); await db.analysisTasks.add(f.task)
    const course = await createCourse({ name: '公开合成实时观察课程' }); const observations = []; const errors = []; let subscription
    await new Promise((resolve) => {
      subscription = liveQuery(async () => await loadCourseSnapshot(course.id)).subscribe({ next: (snapshot) => { observations.push({ points: snapshot.points.length, archives: snapshot.archives.length }); resolve(undefined) }, error: (error) => { errors.push({ name: error.name, message: error.message, stack: error.stack }); resolve(undefined) } })
      window.setTimeout(resolve, 2000)
    })
    await saveEntity({ ...learningBase(course.id, 'live-query-point'), kind: 'point', title: '手工知识点', definition: '', chapter: '', aliases: [], notes: '', sourceRefs: [], questionRefs: [], status: 'active' }, null)
    await new Promise((resolve) => window.setTimeout(resolve, 100))
    await createLearningArchive({ courseId: course.id, docId: f.doc.id, runId: f.quiz.runId, artifacts: [f.mindmap, f.quiz] })
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    subscription?.unsubscribe(); return { observations, errors }
  })
  expect(result.errors).toEqual([])
  expect(result.observations).toContainEqual({ points: 1, archives: 0 })
  expect(result.observations).toContainEqual({ points: 3, archives: 1 })
})
