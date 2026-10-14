import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { db } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { learningBase, type PracticeAttempt } from './model'
import { commitGraphChanges, createCourse, createLearningArchive, loadCourseSnapshot, saveEntity, saveLearningBatch, savePracticeBundle } from './repository'
import { mergeKnowledgePoints, undoKnowledgeMerge } from './knowledgeGraph'
import { COURSE_PACKAGE_LIMITS, exportCoursePackage, previewCoursePackage, restoreCoursePackage } from './coursePackage'
import { installLearningTestStore } from './testStore'

let store: ReturnType<typeof installLearningTestStore>
beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); store = installLearningTestStore() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function setup() {
  const fixture = await localArtifactFixtures(); const course = await createCourse({ name: '公开合成课程备份' })
  fixture.doc.nodes[fixture.doc.rootId].images = [{ id: 'synthetic-image', blobId: 'synthetic-blob', w: 64, h: 64 }]
  await db.docs.add({ id: fixture.doc.id, title: fixture.doc.title, createdAt: 1, updatedAt: 1, payload: JSON.stringify(fixture.doc) }); await db.sources.add(fixture.source); await db.analysisTasks.add(fixture.task)
  await db.blobs.add({ id: 'synthetic-blob', docId: fixture.doc.id, nodeId: fixture.doc.rootId, createdAt: 1, blob: new Blob(['公开附件内容'], { type: 'image/png' }) })
  await db.blobs.add({ id: 'synthetic-unreferenced-blob', docId: fixture.doc.id, createdAt: 1, blob: new Blob(['未挂在节点上的完整附件'], { type: 'application/octet-stream' }) })
  await db.docVersions.add({ id: 'synthetic-version', docId: fixture.doc.id, title: fixture.doc.title, createdAt: 1, payload: JSON.stringify(fixture.doc) })
  const archive = await createLearningArchive({ courseId: course.id, docId: fixture.doc.id, runId: fixture.quiz.runId, artifacts: [fixture.mindmap, fixture.quiz] })
  const question = { archiveId: archive.id, artifactId: fixture.quiz.id, questionId: 'choice', confirmed: false }
  const attempt: PracticeAttempt = { ...learningBase(course.id, 'synthetic-submission', 1), kind: 'attempt', question, answer: 0, submittedAt: 1, learningDate: '1970-01-01', answerRevealed: false, origin: 'practice' }
  await savePracticeBundle(attempt, { ...learningBase(course.id, 'synthetic-assessment', 1), kind: 'assessment', attemptId: attempt.id, outcome: 'success', difficulty: 'good', selfAssessmentComplete: true }, { ...learningBase(course.id, 'synthetic-review', 1), kind: 'schedule', question, status: 'active', stage: 1, dueDate: '2026-10-14', manual: false, ruleVersion: 'review-v1', lastAttemptId: attempt.id })
  return { ...fixture, course, archive, attempt }
}
async function plainPayload(courseId: string) { return JSON.parse(await (await exportCoursePackage(courseId)).text()) }
async function rehash(payload: Record<string, unknown>) { const scope = { ...payload }; delete scope.contentHash; payload.contentHash = await sha256Hex(canonicalizeJson(scope)); return payload }

describe('complete course packages', () => {
  it('includes all existing blobs, editable docs, original text, history and schedules without task secrets', async () => {
    const f = await setup(); const preview = await previewCoursePackage(await exportCoursePackage(f.course.id))
    expect(preview.counts).toMatchObject({ documents: 1, sources: 1, blobs: 2, archives: 1, attempts: 1, schedules: 1 })
    expect(preview.payload.documents[0].versions).toHaveLength(1)
    expect(Object.keys(preview.payload)).not.toEqual(expect.arrayContaining(['analysisTasks', 'providerSettings', 'apiKey', 'fileHandles']))
  })
  it('restores as new identities while preserving historical provenance and independent archive quotes', async () => {
    const f = await setup(); const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); await db.analysisTasks.delete(f.doc.id)
    const restored = await restoreCoursePackage(preview); const snapshot = await loadCourseSnapshot(restored.id)
    expect(restored.id).not.toBe(f.course.id); expect(snapshot.docs[0].id).not.toBe(f.doc.id); expect(snapshot.points[0].id).not.toBe(preview.payload.records.find((r) => r.kind === 'point')!.id)
    expect(snapshot.archives[0].id).not.toBe(f.archive.id); expect(snapshot.archives[0].originDocId).toBe(snapshot.docs[0].id); expect(snapshot.archives[0].provenanceDocId).toBe(f.doc.id)
    expect(snapshot.archives[0].runId).toBe(f.quiz.runId); expect(snapshot.archives[0].sources[0].id).toBe(f.source.id); expect(snapshot.archives[0].sources[0].text).toBe(f.source.text)
    expect(snapshot.attempts[0].question.archiveId).toBe(snapshot.archives[0].id); expect(snapshot.assessments[0].attemptId).toBe(snapshot.attempts[0].id); expect(snapshot.schedules[0].lastAttemptId).toBe(snapshot.attempts[0].id)
    expect(await db.analysisTasks.count()).toBe(0); expect((await loadCourseSnapshot(f.course.id)).archives[0].id).toBe(f.archive.id)
    const stored = await db.docs.get(snapshot.docs[0].id); const doc = JSON.parse(stored!.payload); const original = f.doc.nodes[f.doc.rootId].images![0]
    expect(doc.rootId).not.toBe(f.doc.rootId); expect(doc.nodes[doc.rootId].images[0].blobId).not.toBe(original.blobId)
    const blob = await db.blobs.get(doc.nodes[doc.rootId].images[0].blobId); expect(await blob!.blob.text()).toBe('公开附件内容'); expect(await db.docVersions.count()).toBe(2)
  })
  it('encrypts the whole package and authenticates password/ciphertext before preview', async () => {
    const f = await setup(); const file = await exportCoursePackage(f.course.id, { password: 'synthetic-password-only' }); const text = await file.text()
    expect(text).not.toContain(f.course.name); expect(text).not.toContain(f.source.text); expect(text).not.toContain('synthetic-password-only')
    await expect(previewCoursePackage(file)).rejects.toThrow(/输入密码/); await expect(previewCoursePackage(file, { password: 'wrong-password' })).rejects.toThrow(/密码不正确/)
    const preview = await previewCoursePackage(file, { password: 'synthetic-password-only' }); expect(preview.courseName).toBe(f.course.name)
    const envelope = JSON.parse(text); envelope.data = `${envelope.data[0] === 'A' ? 'B' : 'A'}${envelope.data.slice(1)}`
    await expect(previewCoursePackage(new Blob([JSON.stringify(envelope)]), { password: 'synthetic-password-only' })).rejects.toThrow(/密码不正确/)
  })
  it('does not silently omit attachments above the old inline-image threshold', async () => {
    const f = await setup(); const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 17)], { type: 'application/octet-stream' })
    await db.blobs.put({ id: 'synthetic-large-blob', docId: f.doc.id, createdAt: 1, blob: big })
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); const packed = preview.payload.documents[0].blobs.find((b) => b.id === 'synthetic-large-blob')
    expect(packed!.data.length).toBe(Math.ceil(big.size / 3) * 4)
  })
  it('rejects missing current attachments and corrupted blob bytes', async () => {
    const f = await setup(); const payload = await plainPayload(f.course.id); payload.documents[0].blobs[0].data = btoa('replaced bytes')
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/附件校验/)
    await db.blobs.delete('synthetic-blob'); await expect(exportCoursePackage(f.course.id)).rejects.toThrow(/缺失附件/)
  })
  it('revalidates the stage on restore and makes zero writes after a preview was modified', async () => {
    const f = await setup(); const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); const before = await db.learningRecords.count()
    preview.payload.course.name = 'changed after preview'
    await expect(restoreCoursePackage(preview)).rejects.toThrow(/校验失败/); expect(await db.learningRecords.count()).toBe(before)
  })
  it('rolls back all restored entities when original text storage fails', async () => {
    const f = await setup(); const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); const before = { records: await db.learningRecords.count(), docs: await db.docs.count(), blobs: await db.blobs.count() }
    store.failWritesTo('sources'); await expect(restoreCoursePackage(preview)).rejects.toThrow(/synthetic/)
    expect({ records: await db.learningRecords.count(), docs: await db.docs.count(), blobs: await db.blobs.count() }).toEqual(before)
  })
  it('keeps archived learning portable when the editable document has been deleted', async () => {
    const f = await setup(); await db.docs.delete(f.doc.id); const preview = await previewCoursePackage(await exportCoursePackage(f.course.id))
    expect(preview.warnings[0]).toContain('已经不存在'); const restored = await restoreCoursePackage(preview); const snapshot = await loadCourseSnapshot(restored.id)
    expect(snapshot.documents).toHaveLength(0); expect(snapshot.archives[0].sources[0].text).toBe(f.source.text); expect(snapshot.attempts).toHaveLength(1)
  })
  it('rejects unknown or executable settings even with a recomputed outer checksum', async () => {
    const f = await setup(); const payload = await plainPayload(f.course.id); payload.providerSettings = { apiKey: 'forbidden' }
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/结构/)
    const clean = await plainPayload(f.course.id); clean.documents[0].doc.nodes[clean.documents[0].doc.rootId].task = { owner: 'safe', execute: 'forbidden' }
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(clean))]))).rejects.toThrow(/结构/)
  })
  it('rejects oversized input before reading its content and enforces password bounds', async () => {
    await expect(previewCoursePackage({ size: COURSE_PACKAGE_LIMITS.maxFileBytes + 1 } as Blob)).rejects.toThrow(/192 MB/)
    const f = await setup(); await expect(exportCoursePackage(f.course.id, { password: 'short' })).rejects.toThrow(/8 至 200/)
  })
  it('rejects fabricated objective answers and inconsistent self-assessment even after rehashing', async () => {
    const f = await setup()
    for (const answer of [true, 'not-a-choice', 50]) { const payload = await plainPayload(f.course.id); payload.records.find((r: { kind: string }) => r.kind === 'attempt').answer = answer; await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/作答类型/)
    }
    const payload = await plainPayload(f.course.id); const attempt = payload.records.find((r: { kind: string }) => r.kind === 'attempt'); attempt.question.questionId = 'short'; attempt.answer = '合成回答'
    payload.records.find((r: { kind: string }) => r.kind === 'assessment').rubricChecks = [true]
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/自评要点/)
  })
  it('refuses forged node-to-point bindings and duplicate mapping identities', async () => {
    const f = await setup(); const payload = await plainPayload(f.course.id); const points = payload.records.filter((r: { kind: string }) => r.kind === 'point')
    const rootPoint = points.find((p: { generatedNodeId: string }) => p.generatedNodeId === 'root'); const childPoint = points.find((p: { generatedNodeId: string }) => p.generatedNodeId === 'child')
    const binding = { ...learningBase(f.course.id, 'forged-binding', 1), kind: 'binding', docId: f.doc.id, archiveId: f.archive.id, artifactId: f.mindmap.id, status: 'active', mappings: [{ generatedNodeId: 'root', localNodeId: f.doc.rootId, pointId: childPoint.id, originalText: '主题' }] }
    payload.records.push(binding); await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/生成知识点/)
    binding.mappings[0].pointId = rootPoint.id; binding.mappings.push({ ...binding.mappings[0] }); await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(payload))]))).rejects.toThrow(/节点身份映射/)
  })
  it('remaps removed relation snapshots and can undo a restored merge without touching original identities', async () => {
    const f = await setup(); let current = await loadCourseSnapshot(f.course.id)
    await saveLearningBatch(current.points.map((p) => ({ entity: { ...p, status: 'active' }, expectedRevision: p.revision }))); current = await loadCourseSnapshot(f.course.id)
    const [a, b] = current.points; await saveEntity({ ...learningBase(f.course.id, 'old-removed-edge'), kind: 'relation', fromPointId: a.id, toPointId: b.id, type: 'comparison', confirmed: true }, null)
    current = await loadCourseSnapshot(f.course.id); const expected = (s: typeof current) => ({ points: Object.fromEntries(s.points.map((p) => [p.id, p.revision])), relations: Object.fromEntries(s.relations.map((p) => [p.id, p.revision])) })
    await commitGraphChanges(f.course.id, mergeKnowledgePoints(current, a.id, b.id, { eventId: 'original-merge', at: 10, confirmed: true }), expected(current))
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); const restored = await restoreCoursePackage(preview); let copy = await loadCourseSnapshot(restored.id)
    expect(copy.merges[0].beforeRelations?.[0].id).not.toBe('old-removed-edge')
    await commitGraphChanges(restored.id, undoKnowledgeMerge(copy, copy.merges[0].id, { eventId: 'restored-undo', at: 20 }), expected(copy)); copy = await loadCourseSnapshot(restored.id)
    expect(copy.relations).toHaveLength(1); expect(copy.relations[0].id).not.toBe('old-removed-edge')
    expect((await loadCourseSnapshot(f.course.id)).relations).toHaveLength(0)
    const forged = await plainPayload(f.course.id); forged.records.find((r: { kind: string }) => r.kind === 'merge').beforePoints[0].courseId = 'other-course'
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(forged))]))).rejects.toThrow()
  })
  it('restores grouped exam scope and all corresponding session IDs while preserving the completed report', async () => {
    const f = await setup(); const session = await saveEntity({ ...learningBase(f.course.id, 'group-exam'), kind: 'session', purpose: 'exam', title: '一组公开合成模拟练习', pointIds: [], steps: [], questions: [f.attempt.question], status: 'active' }, null)
    await savePracticeBundle({ ...f.attempt, id: 'exam-attempt', sessionId: session.id }); await saveEntity({ ...session, status: 'completed' }, session.revision)
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id)); const restored = await restoreCoursePackage(preview); const snapshot = await loadCourseSnapshot(restored.id)
    expect(snapshot.sessions[0].id).not.toBe(session.id); expect(snapshot.sessions[0].status).toBe('completed')
    expect(snapshot.sessions[0].questions?.[0].archiveId).toBe(snapshot.archives[0].id)
    expect(snapshot.attempts.find((a) => !!a.sessionId)?.sessionId).toBe(snapshot.sessions[0].id)
    const forged = await plainPayload(f.course.id); forged.records.find((r: { id: string }) => r.id === 'exam-attempt').question.questionId = 'boolean'; forged.records.find((r: { id: string }) => r.id === 'exam-attempt').answer = false
    await expect(previewCoursePackage(new Blob([JSON.stringify(await rehash(forged))]))).rejects.toThrow(/缺少对应作答/)
  })
})
