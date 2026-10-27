import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { installLearningTestStore } from './testStore'
import { attachDocument, createCourse, deleteLearningArchive, loadCourseSnapshot, saveEntity, saveLearningBatch } from './repository'
import { beginNodeRound, captureNodeSources, collectNodeNote, connectNodePoints, createNodePoint, prepareNodeHint, recordNodeHintViewed, reloadNodeState, saveNodeDraft, updateNodeState } from './nodeLearning'
import { exportCoursePackage, previewCoursePackage, restoreCoursePackage } from './coursePackage'
import { parseLearningEntity } from './archiveValidation'
import { analysisRequestSchema, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { createSourceSnapshot } from '../analysis/fingerprint'
import { artifactContentHash } from '../analysis/localArtifactIdentity'
import { createLearningArchive } from './repository'
import { bindNodeHintArchive } from './nodeLearning'
import { getNodeCandidatePage, listNodeCandidates, updateNodeFromCandidate } from './nodeCandidates'

beforeEach(() => { installLearningTestStore(); vi.stubGlobal('Blob', NodeBlob) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setup() {
  const course = await createCourse({ name: '节点学习合成课程', learningMode: 'nodes' })
  const text = '第一章 群的性质。第二章 利用前置定义说明当前步骤。'
  const docId = 'node-doc'; const sourceId = 'node-source'; const rootId = 'node-root'
  await db.docs.add({ id: docId, title: '合成课件', createdAt: 1, updatedAt: 1, payload: JSON.stringify({ version: 3, id: docId, title: '合成课件', rootId, layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: '合成课件' } }, createdAt: 1, updatedAt: 1 }) })
  await db.sources.add({ version: 1, id: sourceId, docId, name: '合成课件', kind: 'text', mime: 'text/plain', size: text.length, lastModified: 1, importedAt: 1, extractor: 'synthetic', text, charCount: text.length, contentHash: await sha256Hex(text), anchors: [] })
  await attachDocument(course.id, docId)
  let state = await captureNodeSources(course.id, docId, 'slides')
  const ref = { snapshotId: state.sources[0].id, start: 0, end: text.length }
  const point = await createNodePoint(state, state.chapters[0].id, '前置定义', [ref])
  state = await reloadNodeState(state.id)
  const roundId = await beginNodeRound(state, point.id)
  state = await reloadNodeState(state.id)
  return { course, docId, text, point, roundId, ref, state }
}

async function finishSyntheticHint(f: Awaited<ReturnType<typeof setup>>) {
  const state = await saveNodeDraft(await reloadNodeState(f.state.id), f.roundId, '证明这一步', '自己的尝试')
  const support = await prepareNodeHint(state, f.roundId, 1)
  const sources = await db.sources.where('docId').equals(support.docId).toArray()
  const manifest = { version: 1 as const, sources: await Promise.all(sources.map((source) => createSourceSnapshot(source))) }
  const artifact: Extract<ArtifactEnvelopeV1, { kind: 'summary' }> = {
    version: 1, schemaVersion: 1, id: 'synthetic-node-summary', kind: 'summary', runId: 'synthetic-node-run', docId: support.docId,
    sourceContentHashes: manifest.sources.map((source) => source.contentHash), createdAt: 1, updatedAt: 1,
    payload: { overview: { id: 'synthetic-overview', text: '核对前置条件再变换。', evidenceIds: ['synthetic-evidence'], citations: [{ version: 1, provenance: 'source', sourceId: sources[0].id, start: 0, end: 4 }] }, keyPoints: [{ id: 'synthetic-key-point', text: '核对运算条件。', evidenceIds: ['synthetic-evidence'], citations: [{ version: 1, provenance: 'source', sourceId: sources[0].id, start: 0, end: 4 }] }], confusions: [] },
  }
  const request = analysisRequestSchema.parse({ version: 1, requestKey: 'b'.repeat(64), docId: support.docId, manifest, artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 3, externalKnowledge: false, invocationLimit: 8 } })
  await db.analysisTasks.add({ version: 1, docId: support.docId, request, runId: artifact.runId, partBytes: 128000, uploadedParts: {}, revision: 2, lastSequence: 0, updatedAt: 1,
    artifactIdentities: { summary: { artifactId: artifact.id, attempt: 1, runRevision: 2, contentHash: await artifactContentHash(artifact) } } })
  const archive = await createLearningArchive({ courseId: f.course.id, docId: support.docId, runId: artifact.runId, artifacts: [artifact] })
  return { support, archive }
}

describe('V4 node learning identity and persistence', () => {
  it('keeps drafts writable after a preparation document disappears and allows explicit preparation again', async () => {
    const f = await setup()
    let state = await saveNodeDraft(f.state, f.roundId, '原来的问题', '原来的推导')
    const support = await prepareNodeHint(state, f.roundId, 1)
    await db.docs.delete(support.docId)
    state = await saveNodeDraft(await reloadNodeState(state.id), f.roundId, '原来的问题', '原来的推导')
    const replacement = await prepareNodeHint(state, f.roundId, 1)
    expect(replacement.id).not.toBe(support.id)
    expect((await reloadNodeState(state.id)).supports).toHaveLength(2)
    state = await reloadNodeState(state.id)
    expect((await prepareNodeHint(state, f.roundId, 1)).id).toBe(replacement.id)
    expect((await reloadNodeState(state.id)).supports).toHaveLength(2)
    await expect(updateNodeState(state, (next) => next.supports.push({ ...support, id: 'phantom-preparation', docId: 'missing-doc' }))).rejects.toThrow(/准备资料不存在/)
  })
  it('exposes candidates beyond the first 500 and reports whether another page exists', async () => {
    const f = await setup()
    const row = await db.docs.get(f.docId); const doc = JSON.parse(row!.payload)
    doc.nodes[doc.rootId].children = Array.from({ length: 501 }, (_, i) => `candidate-${i}`)
    for (const id of doc.nodes[doc.rootId].children) doc.nodes[id] = { id, parent: doc.rootId, children: [], text: id }
    await db.docs.put({ ...row!, payload: JSON.stringify(doc) })
    const snapshot = await loadCourseSnapshot(f.course.id)
    const first = await getNodeCandidatePage(snapshot)
    expect(first.items).toHaveLength(500); expect(first.hasMore).toBe(true)
    const last = await getNodeCandidatePage(snapshot, 500)
    expect(last.items.map((item) => item.title)).toEqual(['candidate-500'])
    expect(last.hasMore).toBe(false)
    await expect(getNodeCandidatePage(snapshot, -1)).rejects.toThrow(/分页/)
  })
  it('starts from imported text without fake questions or AI archives', async () => {
    const f = await setup(); const snapshot = await loadCourseSnapshot(f.course.id)
    expect(snapshot.archives).toHaveLength(0); expect(snapshot.attempts).toHaveLength(0)
    expect(snapshot.nodeWorkspace?.sources[0].text).toBe(f.text)
    expect(snapshot.nodeWorkspace?.rounds[0].refs).toEqual([f.ref])
  })
  it('isolates two free questions and rejects stale writers rather than overwriting their drafts', async () => {
    const f = await setup()
    const saved = await saveNodeDraft(f.state, f.roundId, '第一问题', '自己的步骤')
    await expect(saveNodeDraft(f.state, f.roundId, '另一窗口', '覆盖')).rejects.toThrow(/其他页面/)
    const second = await beginNodeRound(saved, f.point.id)
    const state = await reloadNodeState(saved.id)
    expect(state.rounds.find((r) => r.id === f.roundId)?.input).toBe('自己的步骤')
    expect(state.rounds.find((r) => r.id === second)?.input).toBe('')
    expect(state.lastRoundId).toBe(second)
  })
  it('collects personal understanding explicitly and protects revisions even in batch writes', async () => {
    const f = await setup(); const draft = await saveNodeDraft(f.state, f.roundId, '为什么', '未收录的尝试')
    expect(draft.notes).toHaveLength(0)
    const saved = await collectNodeNote(draft, f.point.id, '我的关键理由', f.roundId)
    const modified = structuredClone(saved); modified.notes[0].text = '篡改旧版本'
    await expect(saveEntity(modified, saved.revision)).rejects.toThrow(/只能追加/)
    await expect(saveLearningBatch([{ entity: modified, expectedRevision: saved.revision }])).rejects.toThrow(/只能追加/)
    expect((await reloadNodeState(saved.id)).notes[0].text).toBe('我的关键理由')
  })
  it('remembers selected textbook ranges for the next round', async () => {
    const f = await setup(); let state = await captureNodeSources(f.course.id, f.docId, 'textbook')
    const textbook = state.sources.find((s) => s.role === 'textbook')!
    const refs = [f.ref, { snapshotId: textbook.id, start: 2, end: 8 }]
    state = await saveNodeDraft(state, f.roundId, '问题', '', refs)
    const nextId = await beginNodeRound(state, f.point.id)
    expect((await reloadNodeState(state.id)).rounds.find((r) => r.id === nextId)?.refs).toEqual(refs)
  })
  it('prepares grounded hints idempotently and binds late results to their original input revision', async () => {
    const f = await setup(); let state = await saveNodeDraft(f.state, f.roundId, '证明这一步', '已知前提')
    const support = await prepareNodeHint(state, f.roundId, 1)
    state = await reloadNodeState(state.id)
    expect((await prepareNodeHint(state, f.roundId, 1)).id).toBe(support.id)
    const changed = await saveNodeDraft(state, f.roundId, '另一个问题', '新草稿')
    expect(changed.supports[0].question).toBe('证明这一步')
    expect(changed.supports[0].inputRevision).toBeLessThan(changed.rounds[0].inputRevision)
    expect((await db.sources.where('docId').equals(support.docId).toArray())[0].text).toBe(f.text)
    expect(changed.events).toHaveLength(0)
  })
  it('refuses to record a view before the hint result is archived locally', async () => {
    const f = await setup(); const state = await saveNodeDraft(f.state, f.roundId, '证明这一步', '已知前提')
    const support = await prepareNodeHint(state, f.roundId, 1)
    // 查看事件必须发生在归档绑定之后，否则结果丢失时会被误记为「已看过」
    await expect(recordNodeHintViewed(f.course.id, support.id)).rejects.toThrow(/保存在本机/)
    expect((await reloadNodeState(state.id)).events).toHaveLength(0)
  })
  it('rejects changed source snapshots and malformed ranges', async () => {
    const f = await setup(); const modified = structuredClone(f.state); modified.sources[0].text = modified.sources[0].text.replace('第一章', '第二章')
    await expect(saveEntity(modified, f.state.revision)).rejects.toThrow(/快照/)
    const malformed = structuredClone(f.state); malformed.rounds[0].refs[0].end = 999999
    expect(() => parseLearningEntity(malformed)).toThrow()
  })
  it('preserves cross-chapter endpoints, rejects prerequisite cycles and permits comparison networks', async () => {
    const f = await setup(); let state = await updateNodeState(f.state, (next) => next.chapters.push({ id: 'chapter-two', title: '第二章' }))
    const other = await createNodePoint(state, 'chapter-two', '当前方案')
    await connectNodePoints(f.course.id, f.point.id, other.id, 'prerequisite', '关键步骤需要前面的定义')
    await expect(connectNodePoints(f.course.id, other.id, f.point.id, 'prerequisite', '形成环')).rejects.toThrow(/循环/)
    await connectNodePoints(f.course.id, f.point.id, other.id, 'comparison', '对比定义')
    await connectNodePoints(f.course.id, other.id, f.point.id, 'comparison', '反向查看')
    state = await reloadNodeState(state.id); expect(state.bindings.find((b) => b.pointId === other.id)?.chapterId).toBe('chapter-two')
  })
  it('does not silently reimport the same candidate or change existing personal content', async () => {
    const f = await setup(); await createNodePoint(f.state, f.state.chapters[0].id, '新增候选', [], { key: 'candidate-1' })
    const state = await reloadNodeState(f.state.id)
    await expect(createNodePoint(state, state.chapters[0].id, '同一个候选', [], { key: 'candidate-1' })).rejects.toThrow(/已经并入/)
  })
  it('explicitly adopts a changed candidate name while preserving identity, notes and links', async () => {
    const f = await setup()
    const point = await createNodePoint(f.state, f.state.chapters[0].id, '原来的方案名称', [], { key: 'candidate-name' })
    let state = await reloadNodeState(f.state.id)
    state = await collectNodeNote(state, point.id, '我自己的关键理由')
    const relation = await connectNodePoints(f.course.id, f.point.id, point.id, 'comparison', '比较前提')
    await updateNodeFromCandidate(state, { key: 'candidate-name', title: '核对后的方案名称', refs: [] }, point.revision)
    const snapshot = await loadCourseSnapshot(f.course.id)
    expect(snapshot.points.find((p) => p.id === point.id)?.title).toBe('核对后的方案名称')
    expect(snapshot.nodeWorkspace?.notes[0].text).toBe('我自己的关键理由')
    expect(snapshot.relations[0].id).toBe(relation.id)
    await expect(updateNodeFromCandidate(state, { key: 'candidate-name', title: '过时的修改', refs: [] }, point.revision)).rejects.toThrow(/已变化/)
  })
})

describe('V4 course packages', () => {
  it('refuses deletion of referenced hint archives without breaking future writes or backups', async () => {
    const f = await setup(); const { support, archive } = await finishSyntheticHint(f)
    await bindNodeHintArchive(f.course.id, support.id, archive.id)
    await expect(deleteLearningArchive(f.course.id, archive.id, archive.revision)).rejects.toThrow(/仍被节点推导历史引用/)
    const state = await saveNodeDraft(await reloadNodeState(f.state.id), f.roundId, '继续证明', '继续写下推导')
    expect(state.rounds[0].input).toBe('继续写下推导')
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id))
    expect(preview.counts.archives).toBe(1)
  })
  it('retains archived results and editable notes after the temporary document is deleted', async () => {
    const f = await setup(); const { support, archive } = await finishSyntheticHint(f)
    await bindNodeHintArchive(f.course.id, support.id, archive.id)
    await db.docs.delete(support.docId)
    expect((await prepareNodeHint(await reloadNodeState(f.state.id), f.roundId, 1)).archiveId).toBe(archive.id)
    const state = await saveNodeDraft(await reloadNodeState(f.state.id), f.roundId, '继续学习', '自己的推导')
    expect(state.rounds[0].input).toBe('自己的推导')
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id))
    expect(preview.counts.archives).toBe(1)
  })
  it('keeps generated but unviewed results recoverable, with viewing recorded separately', async () => {
    const f = await setup(); const { support, archive } = await finishSyntheticHint(f)
    await bindNodeHintArchive(f.course.id, support.id, archive.id)
    expect((await reloadNodeState(f.state.id)).events).toHaveLength(0)
    const restoredCourse = await restoreCoursePackage(await previewCoursePackage(await exportCoursePackage(f.course.id)))
    const restored = (await loadCourseSnapshot(restoredCourse.id)).nodeWorkspace!
    expect(restored.events).toHaveLength(0)
    expect(restored.supports[0].archiveId).toBeTruthy()
    expect((await recordNodeHintViewed(restoredCourse.id, restored.supports[0].id)).events).toHaveLength(1)
    expect((await recordNodeHintViewed(restoredCourse.id, restored.supports[0].id)).events).toHaveLength(1)
  })
  it('rejects another preparation archive, even when it belongs to the same course', async () => {
    const f = await setup(); const { support, archive } = await finishSyntheticHint(f)
    const latest = await reloadNodeState(f.state.id)
    const second = await prepareNodeHint(latest, f.roundId, 2)
    await expect(bindNodeHintArchive(f.course.id, second.id, archive.id)).rejects.toThrow()
    expect((await reloadNodeState(f.state.id)).supports.find((s) => s.id === second.id)?.archiveId).toBeUndefined()
    await bindNodeHintArchive(f.course.id, support.id, archive.id)
  })
  it('allows explicit new preparations after restoring an unfinished historical request', async () => {
    const f = await setup()
    const state = await saveNodeDraft(f.state, f.roundId, '历史问题', '原来的尝试')
    await prepareNodeHint(state, f.roundId, 1)
    const course = await restoreCoursePackage(await previewCoursePackage(await exportCoursePackage(f.course.id)))
    const restored = (await loadCourseSnapshot(course.id)).nodeWorkspace!
    const prepared = await prepareNodeHint(restored, restored.rounds[0].id, 1)
    expect(prepared.id).not.toBe(restored.supports[0].id)
    expect(prepared.restored).toBeUndefined()
    expect(prepared.question).toBe('历史问题')
  })
  it('remaps current source anchors and candidate keys while preserving historical provenance', async () => {
    const f = await setup()
    const row = await db.docs.get(f.docId); const doc = JSON.parse(row!.payload)
    doc.nodes['candidate-child'] = { id: 'candidate-child', parent: doc.rootId, children: [], text: '方案节点' }
    doc.nodes[doc.rootId].children = ['candidate-child']
    await db.docs.put({ ...row!, payload: JSON.stringify(doc) })
    const source = await db.sources.get('node-source')
    await db.sources.put({ ...source!, anchors: [{ nodeId: 'candidate-child', start: 0, end: 4 }] })
    const captured = await captureNodeSources(f.course.id, f.docId, 'textbook')
    const key = JSON.stringify(['doc', f.docId, 'candidate-child'])
    await createNodePoint(captured, captured.chapters[0].id, '方案节点', [], { key })
    const course = await restoreCoursePackage(await previewCoursePackage(await exportCoursePackage(f.course.id)))
    const snapshot = await loadCourseSnapshot(course.id); const restored = snapshot.nodeWorkspace!
    const candidates = await listNodeCandidates(snapshot)
    expect(candidates).toHaveLength(1)
    expect(restored.bindings.some((b) => b.originKey === candidates[0].key)).toBe(true)
    const textbook = restored.sources.find((s) => s.role === 'textbook')!
    expect(textbook.originDocId).toBe(snapshot.docs[0].id)
    expect(textbook.originSourceId).not.toBe('node-source')
    expect(textbook.provenanceSourceId).toBe('node-source')
    const restoredDoc = await db.docs.get(textbook.originDocId)
    expect(JSON.parse(restoredDoc!.payload).nodes[textbook.anchors![0].nodeId].text).toBe('方案节点')
    const refreshed = await captureNodeSources(course.id, textbook.originDocId, 'textbook')
    expect(refreshed.sources).toHaveLength(restored.sources.length)
  })
  it.each([undefined, 'course-password'])('roundtrips all node identities with password %s and never reinstates a task', async (password) => {
    const f = await setup(); let state = await saveNodeDraft(f.state, f.roundId, '保留这个问题', '我的推导')
    await prepareNodeHint(state, f.roundId, 2); state = await reloadNodeState(state.id)
    await collectNodeNote(state, f.point.id, '已收录理解', f.roundId)
    const preview = await previewCoursePackage(await exportCoursePackage(f.course.id, { password }), { password })
    expect(preview.payload.version).toBe(2)
    const recovered = await restoreCoursePackage(preview); const snapshot = await loadCourseSnapshot(recovered.id)
    const restored = snapshot.nodeWorkspace!
    expect(restored.rounds[0].id).not.toBe(f.roundId)
    expect(restored.rounds[0].pointId).toBe(snapshot.points[0].id)
    expect(restored.notes[0].roundId).toBe(restored.rounds[0].id)
    expect(restored.sources[0].text).toBe(f.text)
    expect(restored.supports[0].restored).toBe(true)
    expect(restored.supports[0].roundId).toBe(restored.rounds[0].id)
    expect(restored.lastRoundId).toBe(restored.rounds[0].id)
  })
  it('retains old plain and encrypted v1 compatibility', async () => {
    const course = await createCourse({ name: '旧课程' })
    for (const password of [undefined, 'legacy-password']) {
      const preview = await previewCoursePackage(await exportCoursePackage(course.id, { password }), { password })
      expect(preview.payload.version).toBe(1)
      expect((await restoreCoursePackage(preview)).learningMode).toBeUndefined()
    }
  })
  it('rejects tampered encrypted versions and unknown format versions', async () => {
    const f = await setup(); const blob = await exportCoursePackage(f.course.id, { password: 'course-password' })
    const raw = JSON.parse(await blob.text()); raw.version = 1
    await expect(previewCoursePackage(new Blob([JSON.stringify(raw)]), { password: 'course-password' })).rejects.toThrow()
    raw.version = 99; await expect(previewCoursePackage(new Blob([JSON.stringify(raw)]), { password: 'course-password' })).rejects.toThrow(/版本/)
  })
})
