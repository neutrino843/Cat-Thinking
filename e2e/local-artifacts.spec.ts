import { expect, test } from '@playwright/test'

// These tests use genuine Chromium IndexedDB. Every Playwright context is isolated.
test.beforeEach(async ({ page }) => {
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { flush } = await import('/src/store/persist.ts')
    flush()
    await db.docs.count()
    await db.delete()
    await db.open()
  })
})

test('MindMap application is atomic and idempotent without overwriting later edits', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle, loadDoc, saveDoc, moveToTrash, restoreDoc, purgeDoc } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { applyMindMapArtifact } = await import('/src/analysis/mindMapApplication.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source])
    await db.analysisTasks.add(fixture.task)
    const input = { originDocId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.mindmap }
    const [first, second] = await Promise.all([applyMindMapArtifact(input), applyMindMapArtifact(input)])
    const originalUntouched = JSON.stringify(await loadDoc(fixture.doc.id)) === JSON.stringify(fixture.doc)
    const originalSourceUntouched = JSON.stringify(await db.sources.get(fixture.source.id)) === JSON.stringify(fixture.source)
    const target = await loadDoc(first.targetDocId)
    target.title = '用户随后编辑，必须保留'
    await saveDoc(target)
    const repeated = await applyMindMapArtifact(input)
    const preservedTitle = (await loadDoc(first.targetDocId)).title
    const beforeDocs = await db.docs.count(), beforeSources = await db.sources.count(), beforeReceipts = await db.applicationReceipts.count()
    const abortSource = () => { throw new Error('synthetic atomic rollback') }
    db.sources.hook('creating', abortSource)
    let failed = false
    try { await applyMindMapArtifact({ ...input, applicationIntentId: 'explicit-rollback-intent' }) } catch { failed = true }
    db.sources.hook('creating').unsubscribe(abortSource)
    const rollback = failed && beforeDocs === await db.docs.count() && beforeSources === await db.sources.count() && beforeReceipts === await db.applicationReceipts.count()
    await moveToTrash(first.targetDocId)
    let trashLateSaveRejected = false
    try { await saveDoc(target) } catch { trashLateSaveRejected = true }
    const trashed = await applyMindMapArtifact(input)
    const restoredId = await restoreDoc(first.targetDocId)
    const restoredReferences = (await loadDoc(restoredId)).relations[0].sourceRefs[0]
    const copiedSources = await db.sources.where('docId').equals(first.targetDocId).toArray()
    const referencesIndependent = restoredReferences.sourceId === copiedSources[0].id && copiedSources[0].id !== fixture.source.id
    await moveToTrash(first.targetDocId)
    await purgeDoc(first.targetDocId)
    let purgeLateSaveRejected = false
    try { await saveDoc(target) } catch { purgeLateSaveRejected = true }
    const deleted = await applyMindMapArtifact(input)
    return { first, second, repeated, originalUntouched, originalSourceUntouched, preservedTitle, rollback, trashed, restoredId,
      referencesIndependent, deleted, trashLateSaveRejected, purgeLateSaveRejected, targetAbsent: !await loadDoc(first.targetDocId), receiptCount: await db.applicationReceipts.count() }
  })
  expect(result.first.targetDocId).toBe(result.second.targetDocId)
  expect([result.first.reused, result.second.reused].sort()).toEqual([false, true])
  expect(result.originalUntouched && result.originalSourceUntouched && result.rollback && result.referencesIndependent).toBe(true)
  expect(result.preservedTitle).toBe('用户随后编辑，必须保留')
  expect(result.repeated.reused).toBe(true)
  expect(result.trashed.status).toBe('trashed')
  expect(result.restoredId).toBe(result.first.targetDocId)
  expect(result.deleted.status).toBe('deleted')
  expect(result.targetAbsent).toBe(true)
  expect(result.receiptCount).toBe(1)
  expect(result.trashLateSaveRejected && result.purgeLateSaveRejected).toBe(true)
})

test('MindMap rejects stale sources and binding before any partial document write', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { applyMindMapArtifact } = await import('/src/analysis/mindMapApplication.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source]); await db.analysisTasks.add(fixture.task)
    await db.sources.put({ ...fixture.source, text: fixture.source.text + '修改', charCount: fixture.source.charCount + 2 })
    let changedSourceRejected = false
    try { await applyMindMapArtifact({ originDocId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.mindmap }) } catch { changedSourceRejected = true }
    await db.sources.put(fixture.source)
    await db.analysisTasks.put({ ...fixture.task, artifactIdentities: {} })
    let changedBindingRejected = false
    try { await applyMindMapArtifact({ originDocId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.mindmap }) } catch { changedBindingRejected = true }
    return { changedSourceRejected, changedBindingRejected, docs: await db.docs.count(), sources: await db.sources.count(), receipts: await db.applicationReceipts.count() }
  })
  expect(result).toEqual({ changedSourceRejected: true, changedBindingRejected: true, docs: 1, sources: 1, receipts: 0 })
})

test('Quiz practice persists typed answers and CAS, then refuses late writes after deletion', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle, deleteDoc } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { loadQuizPractice, saveQuizPractice } = await import('/src/analysis/quizPractice.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source]); await db.analysisTasks.add(fixture.task)
    const context = { docId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.quiz }
    const state = { answers: { choice: 0, boolean: false, short: '用户自己的答案' }, submitted: true, selfAssessments: { short: [true, false] } }
    const first = await saveQuizPractice(context, state, null)
    const restored = await loadQuizPractice(context)
    const races = await Promise.allSettled([saveQuizPractice(context, { ...state, answers: { choice: 1 } }, first.revision), saveQuizPractice(context, { ...state, answers: { choice: 0 } }, first.revision)])
    const accepted = races.filter((item) => item.status === 'fulfilled').length
    const conflict = races.filter((item) => item.status === 'rejected' && item.reason.code === 'conflict').length
    const keys = Object.keys(await db.quizPractices.get(first.id)).sort()
    await db.analysisTasks.put({ ...fixture.task, artifactIdentities: { ...fixture.task.artifactIdentities, quiz: { artifactId: 'replacement-quiz', attempt: 2, runRevision: 10 } } })
    let replacementRejected = false
    try { await saveQuizPractice(context, state, 2) } catch { replacementRejected = true }
    await deleteDoc(fixture.doc.id)
    let lateRejected = false
    try { await saveQuizPractice(context, state, 2) } catch { lateRejected = true }
    return { restored, accepted, conflict, keys, replacementRejected, lateRejected, practices: await db.quizPractices.count() }
  })
  expect(result.restored.answers).toEqual({ choice: 0, boolean: false, short: '用户自己的答案' })
  expect(result.accepted).toBe(1); expect(result.conflict).toBe(1)
  expect(result.keys).not.toContain('payload'); expect(result.keys).not.toContain('answerIndex')
  expect(result.replacementRejected && result.lateRejected).toBe(true)
  expect(result.practices).toBe(0)
})

test('Dexie v7, v8 and v9 upgrade preserve local records and add empty learning storage and identity fences', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { MSZDB } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const fixture = await localArtifactFixtures()
    const DexieBase = Object.getPrototypeOf(MSZDB.prototype).constructor
    const results = []
    for (const version of [7, 8, 9]) {
      const name = `synthetic-local-artifacts-migration-${version}`
      const legacy = new DexieBase(name)
      legacy.version(version).stores({ docs: 'id, updatedAt', templates: 'id, createdAt', trash: 'id, deletedAt', blobs: 'id, docId, nodeId',
        fileHandles: 'docId', docVersions: 'id, docId, createdAt', sources: 'id, docId, importedAt', ...(version >= 8 ? { analysisTasks: 'docId, runId, updatedAt' } : {}),
        ...(version >= 9 ? { applicationReceipts: 'applicationIntentId, originDocId, targetDocId, artifactId', quizPractices: 'id, docId, runId, artifactId, updatedAt' } : {}) })
      const storedDoc = { id: fixture.doc.id, title: fixture.doc.title, createdAt: 1, updatedAt: 1, payload: JSON.stringify(fixture.doc) }
      const storedReceipt = { version: 1, applicationIntentId: 'synthetic-legacy-intent', originDocId: fixture.doc.id,
        targetDocId: fixture.doc.id, runId: fixture.task.runId, artifactId: fixture.mindmap.id, artifactHash: fixture.task.artifactIdentities.mindmap.contentHash,
        sourceFingerprint: 'b'.repeat(64), committedAt: 1 }
      const storedPractice = { version: 1, id: 'synthetic-legacy-practice', docId: fixture.doc.id, runId: fixture.task.runId, artifactId: fixture.quiz.id,
        artifactHash: fixture.task.artifactIdentities.quiz.contentHash, sourceFingerprint: 'b'.repeat(64), revision: 3, updatedAt: 7,
        questionIds: fixture.quiz.payload.questions.map((question) => question.id), answers: { choice: 0, boolean: false, short: '旧版回答' },
        submitted: true, selfAssessments: { short: [true, false] } }
      await legacy.open()
      await legacy.table('docs').add(storedDoc)
      await legacy.table('sources').add(fixture.source)
      if (version >= 8) await legacy.table('analysisTasks').add(fixture.task)
      if (version >= 9) {
        await legacy.table('applicationReceipts').add(storedReceipt)
        await legacy.table('quizPractices').add(storedPractice)
      }
      legacy.close()
      const upgraded = new MSZDB(name)
      await upgraded.open()
      results.push({ version: upgraded.verno, docs: await upgraded.docs.count(), sources: await upgraded.sources.count(), tasks: await upgraded.analysisTasks.count(),
        receipts: await upgraded.applicationReceipts.count(), practices: await upgraded.quizPractices.count(), tombstones: await upgraded.documentTombstones.count(),
        learningRecords: await upgraded.learningRecords.count(), learningTombstones: await upgraded.learningCourseTombstones.count(),
        preserved: {
          doc: JSON.stringify(await upgraded.docs.get(fixture.doc.id)) === JSON.stringify(storedDoc),
          source: JSON.stringify(await upgraded.sources.get(fixture.source.id)) === JSON.stringify(fixture.source),
          task: JSON.stringify(await upgraded.analysisTasks.get(fixture.doc.id)) === JSON.stringify(version >= 8 ? fixture.task : undefined),
          receipt: JSON.stringify(await upgraded.applicationReceipts.get(storedReceipt.applicationIntentId)) === JSON.stringify(version >= 9 ? storedReceipt : undefined),
          practice: JSON.stringify(await upgraded.quizPractices.get(storedPractice.id)) === JSON.stringify(version >= 9 ? storedPractice : undefined),
        } })
      await upgraded.delete()
    }
    return results
  })
  expect(result).toEqual([
    { version: 11, docs: 1, sources: 1, tasks: 0, receipts: 0, practices: 0, tombstones: 0, learningRecords: 0, learningTombstones: 0, preserved: { doc: true, source: true, task: true, receipt: true, practice: true } },
    { version: 11, docs: 1, sources: 1, tasks: 1, receipts: 0, practices: 0, tombstones: 0, learningRecords: 0, learningTombstones: 0, preserved: { doc: true, source: true, task: true, receipt: true, practice: true } },
    { version: 11, docs: 1, sources: 1, tasks: 1, receipts: 1, practices: 1, tombstones: 0, learningRecords: 0, learningTombstones: 0, preserved: { doc: true, source: true, task: true, receipt: true, practice: true } },
  ])
})

test('ordinary permanent deletion survives two pages, queued autosave and a database reopen', async ({ page, context }) => {
  const original = await page.evaluate(async () => {
    const { db, saveDocumentBundle, saveBlob } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source])
    const blobId = await saveBlob(fixture.doc.id, new Blob(['ordinary attachment']), fixture.doc.rootId)
    await db.analysisTasks.add(fixture.task)
    await db.quizPractices.add({ id: 'synthetic-deletion-practice', docId: fixture.doc.id })
    await db.fileHandles.put({ docId: fixture.doc.id, handle: { synthetic: true }, savedAt: 1 })
    return { doc: fixture.doc, source: fixture.source, blobId }
  })
  const latePage = await context.newPage()
  await latePage.goto('/')
  await expect(latePage.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  // Freeze a write closure in another tab before deletion; page visibility flush remains active.
  await latePage.evaluate(async (saved) => {
    const { db, saveDoc, saveDocumentBundle, putSource, putBlob, touchFileHandle } = await import('/src/store/db.ts')
    const { flush, schedulePersist } = await import('/src/store/persist.ts')
    flush()
    schedulePersist(saved.doc)
    ;(window as unknown as { __lateDocumentWrites: () => Promise<string[]> }).__lateDocumentWrites = async () => {
      db.close(); await db.open()
      flush()
      const results = await Promise.allSettled([saveDoc(saved.doc), saveDocumentBundle(saved.doc, [saved.source]), putSource(saved.source),
        putBlob(saved.blobId, saved.doc.id, new Blob(['late attachment'])), touchFileHandle(saved.doc.id)])
      return results.map((result) => result.status)
    }
  }, original)
  await page.evaluate(async (id) => {
    const { deleteDoc } = await import('/src/store/db.ts')
    await deleteDoc(id)
  }, original.doc.id)
  expect(await latePage.evaluate(async () => (window as unknown as { __lateDocumentWrites: () => Promise<string[]> }).__lateDocumentWrites())).toEqual(Array(5).fill('rejected'))
  const state = await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts')
    return { doc: await db.docs.get(id), sourceCount: await db.sources.where('docId').equals(id).count(),
      blobs: await db.blobs.where('docId').equals(id).count(), tasks: await db.analysisTasks.get(id),
      practices: await db.quizPractices.where('docId').equals(id).count(), history: await db.docVersions.where('docId').equals(id).count(),
      handle: await db.fileHandles.get(id), fence: await db.documentTombstones.get(id) }
  }, original.doc.id)
  expect(state.doc).toBeUndefined(); expect(state.tasks).toBeUndefined(); expect(state.handle).toBeUndefined()
  expect([state.sourceCount, state.blobs, state.practices, state.history]).toEqual([0, 0, 0, 0])
  expect(state.fence).toEqual({ id: original.doc.id, deletedAt: expect.any(Number) })
})

test('explicit native reimport remaps all references and attachments without removing its deletion fence', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle, saveImportedDocumentBundle, deleteDoc, loadDoc } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { buildExportPayload, parseImported } = await import('/src/lib/exporters.ts')
    const { decodeImportedBlobs } = await import('/src/lib/importedBlobs.ts')
    const { convertMindMapArtifact } = await import('/src/analysis/mindMapApplication.ts')
    const fixture = await localArtifactFixtures()
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    const original = converted.doc
    original.nodes[original.rootId].attachments = [{ id: 'attachment', blobId: 'synthetic-native-blob', name: 'backup.txt', size: 7, mime: 'text/plain' }]
    original.nodes[original.rootId].collapsed = true
    await saveDocumentBundle(original, converted.sources, new Map([['synthetic-native-blob', new Blob(['content'])]]))
    const backup = parseImported(await buildExportPayload(original))
    const normal = await saveImportedDocumentBundle(backup.doc, backup.sources, decodeImportedBlobs(backup.blobs))
    await deleteDoc(original.id)
    const copied = await saveImportedDocumentBundle(backup.doc, backup.sources, decodeImportedBlobs(backup.blobs))
    const source = (await db.sources.where('docId').equals(copied.id).toArray())[0]
    const reference = copied.relations[0].sourceRefs[0]
    const blobId = copied.nodes[copied.rootId].attachments[0].blobId
    const blob = await db.blobs.get(blobId)
    return { normalSameId: normal.id === original.id, copiedId: copied.id, originalId: original.id, rootChanged: copied.rootId !== original.rootId,
      sourceIdChanged: source.id !== converted.sources[0].id, sourceAnchorMapped: source.anchors.every((anchor) => !!copied.nodes[anchor.nodeId]),
      relationMapped: reference.sourceId === source.id && reference.contentHash === source.contentHash,
      attachmentMapped: blobId !== 'synthetic-native-blob' && blob.docId === copied.id && await blob.blob.text() === 'content',
      collapsed: copied.nodes[copied.rootId].collapsed, fenced: !!await db.documentTombstones.get(original.id), oldAbsent: !await loadDoc(original.id) }
  })
  expect(result.copiedId).not.toBe(result.originalId)
  expect(result.normalSameId && result.rootChanged && result.sourceIdChanged && result.sourceAnchorMapped && result.relationMapped && result.attachmentMapped && result.fenced && result.oldAbsent).toBe(true)
  expect(result.collapsed).toBe(true)
})

test('permanent deletion rolls back its fence and cascade together, and every trash cleanup path fences late writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDoc, deleteDoc, moveToTrash, restoreDoc, purgeDoc, emptyTrash, sweepTrash } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const fixture = await localArtifactFixtures()
    await saveDoc(fixture.doc)
    const abortDeletion = () => { throw new Error('synthetic fence rollback') }
    db.documentTombstones.hook('creating', abortDeletion)
    let rejected = false
    try { await deleteDoc(fixture.doc.id) } catch { rejected = true }
    db.documentTombstones.hook('creating').unsubscribe(abortDeletion)
    const rollback = rejected && !!await db.docs.get(fixture.doc.id) && !await db.documentTombstones.get(fixture.doc.id)
    await moveToTrash(fixture.doc.id)
    const restored = await restoreDoc(fixture.doc.id)
    await purgeDoc(fixture.doc.id)
    const stalePurgeSafe = restored === fixture.doc.id && !!await db.docs.get(fixture.doc.id) && !await db.documentTombstones.get(fixture.doc.id)
    const paths = []
    for (const kind of ['purge', 'empty', 'sweep']) {
      const doc = { ...fixture.doc, id: `synthetic-cleanup-${kind}` }
      await saveDoc(doc); await moveToTrash(doc.id)
      if (kind === 'purge') await purgeDoc(doc.id)
      else if (kind === 'empty') await emptyTrash()
      else await sweepTrash(-1)
      let blocked = false
      try { await saveDoc(doc) } catch { blocked = true }
      paths.push(blocked && !!await db.documentTombstones.get(doc.id) && !await db.trash.get(doc.id) && !await db.docs.get(doc.id))
    }
    return { rollback, stalePurgeSafe, paths }
  })
  expect(result).toEqual({ rollback: true, stalePurgeSafe: true, paths: [true, true, true] })
})

for (const action of ['switch-document', 'delete-node'] as const) {
  test(`late attachment upload refuses ${action} identity changes and cleans its own blob`, async ({ page }) => {
    const ids = await page.evaluate(async (mode) => {
      const { db, saveDoc } = await import('/src/store/db.ts')
      const { useDoc } = await import('/src/store/docStore.ts')
      const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
      const fixture = await localArtifactFixtures()
      const other = { ...fixture.doc, id: 'synthetic-other-upload-document', title: '切换后的文档' }
      await saveDoc(fixture.doc); await saveDoc(other)
      const nodeId = fixture.doc.nodes[fixture.doc.rootId].children[0]
      useDoc.getState().openDoc(fixture.doc); useDoc.getState().select([nodeId])
      const changeIdentity = () => {
        db.blobs.hook('creating').unsubscribe(changeIdentity)
        if (mode === 'switch-document') { useDoc.getState().openDoc(other); useDoc.getState().select([nodeId]) }
        else useDoc.getState().removeNodes([nodeId])
      }
      db.blobs.hook('creating', changeIdentity)
      return { originalId: fixture.doc.id, otherId: other.id, nodeId }
    }, action)
    await page.getByRole('button', { name: '上传附件', exact: true }).waitFor()
    await page.locator('.msz-np-section', { has: page.getByRole('button', { name: '上传附件', exact: true }) }).locator('input[type="file"]').setInputFiles({
      name: 'synthetic-late.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment'),
    })
    await expect.poll(() => page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts')
      const { useDoc } = await import('/src/store/docStore.ts')
      return { blobs: await db.blobs.count(), hasAttachment: Object.values(useDoc.getState().doc.nodes).some((node) => !!node.attachments?.length) }
    })).toEqual({ blobs: 0, hasAttachment: false })
    const current = await page.evaluate(async () => (await import('/src/store/docStore.ts')).useDoc.getState().doc)
    if (action === 'switch-document') expect(current.id).toBe(ids.otherId)
    else expect(current.nodes[ids.nodeId]).toBeUndefined()
  })
}

test('native HTML/SVG and forged image attachments download without executing or reading IndexedDB', async ({ page, context }) => {
  await page.evaluate(async () => {
    const { saveImportedDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { parseImported } = await import('/src/lib/exporters.ts')
    const { decodeImportedBlobs } = await import('/src/lib/importedBlobs.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const fixture = await localArtifactFixtures()
    const script = `localStorage.setItem('synthetic-attachment-executed','yes');const request=indexedDB.open('maosizhi');request.onsuccess=()=>{request.result.transaction('docs').objectStore('docs').get('synthetic-private-preview').onsuccess=()=>localStorage.setItem('synthetic-attachment-read-db','yes')}`
    const html = `<html><body><script>${script}</script></body></html>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>${script}</script></svg>`
    const cases = [
      { id: 'html', metadata: 'text/html', mime: 'text/html', content: html },
      { id: 'svg', metadata: 'image/svg+xml', mime: 'image/svg+xml', content: svg },
      { id: 'forged-html', metadata: 'image/png', mime: 'text/html', content: html },
      { id: 'forged-svg', metadata: 'image/png', mime: 'image/svg+xml', content: svg },
      { id: 'forged-blob', metadata: 'image/png', mime: 'image/png', content: html },
    ]
    const doc = { ...fixture.doc, id: 'synthetic-private-preview', title: 'private synthetic marker' }
    doc.nodes[doc.rootId].attachments = cases.map((item) => ({ id: item.id, blobId: item.id, name: `${item.id}.unsafe`, mime: item.metadata, size: item.content.length }))
    const _blobs = Object.fromEntries(cases.map((item) => [item.id, { dataURL: `data:${item.mime};base64,${btoa(item.content)}`, type: item.mime }]))
    const imported = parseImported(JSON.stringify({ ...doc, _blobs, _sources: [] }))
    await saveImportedDocumentBundle(imported.doc, imported.sources, decodeImportedBlobs(imported.blobs))
    useDoc.getState().openDoc(imported.doc); useDoc.getState().select([doc.rootId])
    localStorage.removeItem('synthetic-attachment-executed'); localStorage.removeItem('synthetic-attachment-read-db')
    const originalOpen = window.open.bind(window)
    let openCount = 0
    window.open = (...args) => { openCount++; return originalOpen(...args) }
    ;(window as unknown as { __attachmentOpenCount: () => number }).__attachmentOpenCount = () => openCount
  })
  for (const id of ['html', 'svg', 'forged-html', 'forged-svg', 'forged-blob']) {
    const row = page.locator('.msz-np-att-item', { has: page.getByText(`${id}.unsafe`, { exact: true }) })
    const download = page.waitForEvent('download')
    if (id === 'html' || id === 'svg') {
      await expect(row.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
      await row.getByRole('button', { name: '下载', exact: true }).click()
    } else await row.getByRole('button', { name: '预览', exact: true }).click()
    expect((await download).suggestedFilename()).toBe(`${id}.unsafe`)
  }
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    return { openCount: (window as unknown as { __attachmentOpenCount: () => number }).__attachmentOpenCount(),
      executed: localStorage.getItem('synthetic-attachment-executed'), readDatabase: localStorage.getItem('synthetic-attachment-read-db'),
      title: (await db.docs.get('synthetic-private-preview')).title }
  })
  expect(result).toEqual({ openCount: 0, executed: null, readDatabase: null, title: 'private synthetic marker' })
  expect(context.pages()).toHaveLength(1)
})

test('verified raster attachment preview remains usable and has no opener', async ({ page, context }) => {
  await page.evaluate(async () => {
    const { saveDocumentBundle } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const fixture = await localArtifactFixtures()
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    canvas.getContext('2d').fillRect(0, 0, 1, 1)
    const image = await new Promise<Blob>((resolve) => canvas.toBlob(resolve, 'image/png'))
    fixture.doc.nodes[fixture.doc.rootId].attachments = [{ id: 'safe-raster', blobId: 'safe-raster', name: 'safe.png', mime: 'image/png', size: image.size }]
    await saveDocumentBundle(fixture.doc, [], new Map([['safe-raster', image]]))
    useDoc.getState().openDoc(fixture.doc); useDoc.getState().select([fixture.doc.rootId])
  })
  const opened = context.waitForEvent('page')
  await page.locator('.msz-np-att-item', { has: page.getByText('safe.png', { exact: true }) }).getByRole('button', { name: '预览', exact: true }).click()
  const preview = await opened
  await expect(preview.locator('img')).toBeVisible()
  expect(await preview.evaluate(() => ({ noOpener: window.opener === null, width: document.querySelector('img').naturalWidth }))).toEqual({ noOpener: true, width: 1 })
  await preview.close()
})

test('applied local node/relation references remain inspectable after origin deletion and reject changed copies', async ({ page }) => {
  await page.evaluate(async () => {
    const { db, saveDocumentBundle, loadDoc, deleteDoc } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { applyMindMapArtifact } = await import('/src/analysis/mindMapApplication.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source]); await db.analysisTasks.add(fixture.task)
    const applied = await applyMindMapArtifact({ originDocId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.mindmap })
    await deleteDoc(fixture.doc.id)
    const target = await loadDoc(applied.targetDocId)
    useDoc.getState().openDoc(target); useDoc.getState().select([target.rootId])
  })
  const inspector = page.locator('section[aria-label="本地原文引用"]')
  await inspector.getByRole('button', { name: /节点原文/ }).click()
  await expect(inspector.locator('mark')).toHaveText('😀')
  await inspector.getByRole('button', { name: /关系原文：支持/ }).click()
  await expect(inspector.locator('mark')).toHaveText('😀')
  await page.evaluate(async () => {
    const { listSourcesByDoc, putSource } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const source = (await listSourcesByDoc(useDoc.getState().doc.id))[0]
    await putSource({ ...source, text: source.text + '变更', charCount: source.charCount + 2 })
  })
  await expect(inspector.locator('mark')).toHaveCount(0)
  await inspector.getByRole('button', { name: /关系原文：支持/ }).click()
  await expect(inspector.getByRole('alert')).toContainText('改变')
})

test('native JSON and template copies retain source identities without overwriting other documents', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db, saveDocumentBundle, loadDoc, saveTemplate, listTemplates, listSourcesByDoc, deleteTemplate } = await import('/src/store/db.ts')
    const { localArtifactFixtures } = await import('/src/test/localArtifactFixtures.ts')
    const { applyMindMapArtifact } = await import('/src/analysis/mindMapApplication.ts')
    const { buildExportPayload, parseImported } = await import('/src/lib/exporters.ts')
    const { cloneFromTemplate } = await import('/src/lib/templateClone.ts')
    const fixture = await localArtifactFixtures()
    await saveDocumentBundle(fixture.doc, [fixture.source]); await db.analysisTasks.add(fixture.task)
    const applied = await applyMindMapArtifact({ originDocId: fixture.doc.id, runId: fixture.task.runId, artifact: fixture.mindmap })
    const target = await loadDoc(applied.targetDocId)
    const native = parseImported(await buildExportPayload(target))
    const cloned = cloneFromTemplate(native.doc, native.sources)
    await saveDocumentBundle(cloned.doc, cloned.sources)
    const templateId = await saveTemplate('合成引用模板', target)
    const template = (await listTemplates()).find((item) => item.id === templateId)
    const templateSources = await listSourcesByDoc(template.doc.id)
    const templateCopy = cloneFromTemplate(template.doc, templateSources)
    await saveDocumentBundle(templateCopy.doc, templateCopy.sources)
    const templateReferencePreserved = templateCopy.doc.relations[0].sourceRefs[0].sourceId === templateCopy.sources[0].id
    await deleteTemplate(templateId)
    const templateSourcesRemoved = (await listSourcesByDoc(template.doc.id)).length === 0
    const countBefore = await db.docs.count()
    const collisionDoc = { ...cloned.doc, id: 'synthetic-collision-doc' }
    const collidingSources = cloned.sources.map((source) => ({ ...source, docId: collisionDoc.id }))
    let collisionRejected = false
    try { await saveDocumentBundle(collisionDoc, collidingSources) } catch { collisionRejected = true }
    const noPartialCollision = await db.docs.count() === countBefore && !await loadDoc(collisionDoc.id)
    const badHashDoc = { ...cloned.doc, id: 'synthetic-bad-hash-doc' }
    const badSources = cloned.sources.map((source) => ({ ...source, docId: badHashDoc.id, text: source.text + 'changed' }))
    let wrongHashRejected = false
    try { await saveDocumentBundle(badHashDoc, badSources) } catch { wrongHashRejected = true }
    return { nativeRefs: native.doc.relations[0].sourceRefs, nativeSourceHash: native.sources[0].contentHash,
      copyHash: cloned.sources[0].contentHash, templateReferencePreserved, templateSourcesRemoved, collisionRejected, noPartialCollision, wrongHashRejected,
      originalIntact: JSON.stringify(await db.sources.get(fixture.source.id)) === JSON.stringify(fixture.source) }
  })
  expect(result.nativeRefs[0].contentHash).toBe(result.nativeSourceHash)
  expect(result.copyHash).toBe(result.nativeSourceHash)
  expect(result.templateReferencePreserved && result.templateSourcesRemoved && result.collisionRejected && result.noPartialCollision && result.wrongHashRejected && result.originalIntact).toBe(true)
})
