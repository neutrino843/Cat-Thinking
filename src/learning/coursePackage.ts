import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { db, BLOB_QUOTA_BYTES, type StoredBlob } from '../store/db'
import type { DocData, SourceDocument } from '../types'
import { validateDoc } from '../lib/exporters'
import { verifyRelationSourceHashes } from '../lib/relationSources'
import { sha256Hex } from '../analysis/fingerprint'
import { isRecord, parseLearningEntity, parseSourceDocument, validateLearningArchive } from './archiveValidation'
import { LearningError, newLearningId, type Course, type LearningEntity, type LearningArchive } from './model'
import { prerequisiteCycle } from './knowledgeGraph'

export const COURSE_PACKAGE_LIMITS = Object.freeze({ maxFileBytes: 192 * 1024 * 1024, maxPayloadBytes: 128 * 1024 * 1024, maxBlobBytes: 64 * 1024 * 1024, maxRecords: 50_000, maxDocuments: 1000, maxNodes: 50_000 })
const FORMAT = 'maosizhi-course'
const ITERATIONS = 250_000
const AAD = new TextEncoder().encode(`${FORMAT}:1`)
interface PortableBlob { id: string; docId: string; nodeId?: string; mime: string; data: string; hash: string; createdAt: number }
interface PortableDocument { doc: DocData; sources: SourceDocument[]; blobs: PortableBlob[]; versions: { id: string; docId: string; title: string; createdAt: number; doc: DocData }[] }
export interface CoursePackagePayload { format: typeof FORMAT; version: 1; exportedAt: number; course: Course; records: LearningEntity[]; documents: PortableDocument[]; missingDocumentIds: string[]; contentHash: string }
export interface CoursePackagePreview { courseName: string; exportedAt: number; counts: { documents: number; sources: number; blobs: number; archives: number; attempts: number; schedules: number; records: number }; warnings: string[]; payload: CoursePackagePayload }
function invalid(message = '课程包结构、版本或引用无效。'): never { throw new LearningError('invalid', message) }
function keys(v: unknown, allowed: string[]): Record<string, unknown> { if (!isRecord(v) || Object.keys(v).some((k) => !allowed.includes(k))) invalid(); return v }
function boundedArray(v: unknown, max: number): asserts v is unknown[] { if (!Array.isArray(v) || v.length > max) invalid('课程包数据量超过限制。') }
function bytesToBase64(bytes: Uint8Array): string { let text = ''; for (let i = 0; i < bytes.length; i += 16_384) text += String.fromCharCode(...bytes.subarray(i, i + 16_384)); return btoa(text) }
function base64ToBytes(v: unknown, max: number): Uint8Array {
  if (typeof v !== 'string' || v.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) invalid('课程包二进制编码无效或超限。')
  const raw = atob(v); if (raw.length > max) invalid('课程包附件超限。'); return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
async function hashBytes(bytes: Uint8Array): Promise<string> { const buffer = await crypto.subtle.digest('SHA-256', asBuffer(bytes)); return [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, '0')).join('') }
function payloadForHash(payload: CoursePackagePayload): unknown { const rest: Partial<CoursePackagePayload> = { ...payload }; delete rest.contentHash; return rest }
function mapped<K, V>(map: ReadonlyMap<K, V>, key: K): V { const value = map.get(key); if (value === undefined) invalid('课程包恢复缺少明确的身份映射。'); return value }
async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  if (password.length < 8 || password.length > 200) throw new LearningError('password', '课程包密码需要 8 至 200 个字符。')
  const material = await crypto.subtle.importKey('raw', asBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: asBuffer(salt), iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
function inspectDocument(raw: unknown): DocData {
  const top = keys(raw, ['version', 'id', 'title', 'rootId', 'layout', 'nodes', 'relations', 'summaries', 'boundaryBoxes', 'createdAt', 'updatedAt'])
  if (top.version !== 3 || !isRecord(top.nodes) || Object.keys(top.nodes).length > COURSE_PACKAGE_LIMITS.maxNodes || typeof top.createdAt !== 'number' || !Number.isSafeInteger(top.createdAt) || typeof top.updatedAt !== 'number' || !Number.isSafeInteger(top.updatedAt)) invalid()
  for (const node of Object.values(top.nodes)) keys(node, ['id', 'parent', 'children', 'text', 'note', 'href', 'color', 'collapsed', 'task', 'tags', 'icons', 'links', 'images', 'attachments', 'richNote'])
  for (const rawNode of Object.values(top.nodes)) {
    const node = rawNode as Record<string, unknown>
    if (node.task !== undefined) { const task = keys(node.task, ['start', 'end', 'progress', 'milestone', 'deps', 'priority', 'owner', 'note']); if (task.deps !== undefined) { boundedArray(task.deps, 50_000); task.deps.forEach((d) => keys(d, ['from', 'type'])) } }
    if (node.richNote !== undefined) keys(node.richNote, ['html'])
    const nested: [string, string[]][] = [['tags', ['id', 'text', 'color']], ['links', ['id', 'kind', 'url', 'nodeId']], ['images', ['id', 'blobId', 'w', 'h', 'crop']], ['attachments', ['id', 'blobId', 'name', 'size', 'mime']]]
    for (const [key, allowed] of nested) if (node[key] !== undefined) { boundedArray(node[key], 1000); (node[key] as unknown[]).forEach((v) => { const row = keys(v, allowed); if (key === 'images' && row.crop !== undefined) keys(row.crop, ['x', 'y', 'w', 'h']) }) }
  }
  // Native validation adds optional undefined fields; portable JSON has exactly the serialized shape.
  return JSON.parse(JSON.stringify(validateDoc(structuredClone(top)))) as DocData
}
function entityReferences(record: LearningEntity): { questionRefs: { archiveId: string; artifactId: string; questionId: string }[]; sourceRefs: { archiveId: string; sourceId: string; end: number }[] } {
  return { questionRefs: 'question' in record ? [record.question] : record.kind === 'point' ? record.questionRefs : record.kind === 'session' ? record.questions ?? [] : [], sourceRefs: record.kind === 'point' || record.kind === 'relation' ? record.sourceRefs ?? [] : [] }
}
export async function validateCoursePackagePayload(raw: unknown): Promise<CoursePackagePayload> {
  const input = keys(raw, ['format', 'version', 'exportedAt', 'course', 'records', 'documents', 'missingDocumentIds', 'contentHash'])
  if (input.format !== FORMAT || input.version !== 1 || typeof input.exportedAt !== 'number' || !Number.isSafeInteger(input.exportedAt) || input.exportedAt < 0 || typeof input.contentHash !== 'string') invalid()
  if (new TextEncoder().encode(canonicalizeJson(input)).length > COURSE_PACKAGE_LIMITS.maxPayloadBytes) invalid('课程包超过 128 MB 的校验上限。')
  const course = parseLearningEntity(input.course); if (course.kind !== 'course') invalid()
  boundedArray(input.records, COURSE_PACKAGE_LIMITS.maxRecords); const records = input.records.map(parseLearningEntity)
  if (records.some((r) => r.kind === 'course' || r.courseId !== course.id) || new Set([course.id, ...records.map((r) => r.id)]).size !== records.length + 1) invalid()
  boundedArray(input.documents, COURSE_PACKAGE_LIMITS.maxDocuments); boundedArray(input.missingDocumentIds, COURSE_PACKAGE_LIMITS.maxDocuments)
  if (input.missingDocumentIds.some((v) => typeof v !== 'string')) invalid()
  const documents: PortableDocument[] = []; let blobTotal = 0
  const allBlobIds = new Set<string>(); const allSourceIds = new Set<string>(); const versionIds = new Set<string>()
  for (const rawDocument of input.documents) {
    const bundle = keys(rawDocument, ['doc', 'sources', 'blobs', 'versions']); const doc = inspectDocument(bundle.doc)
    boundedArray(bundle.sources, 1000); const sources = bundle.sources.map(parseSourceDocument)
    if (sources.some((s) => s.docId !== doc.id || allSourceIds.has(s.id))) invalid(); sources.forEach((s) => allSourceIds.add(s.id))
    for (const source of sources) if (source.contentHash !== undefined && await sha256Hex(source.text) !== source.contentHash) invalid('课程包原文哈希不一致。')
    await verifyRelationSourceHashes(doc, sources)
    boundedArray(bundle.blobs, 20_000); const blobs: PortableBlob[] = []; let docBlobTotal = 0
    for (const rawBlob of bundle.blobs) {
      const row = keys(rawBlob, ['id', 'docId', 'nodeId', 'mime', 'data', 'hash', 'createdAt'])
      if (typeof row.id !== 'string' || row.docId !== doc.id || typeof row.mime !== 'string' || row.mime.length > 200 || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || allBlobIds.has(row.id) || row.nodeId !== undefined && (typeof row.nodeId !== 'string' || !doc.nodes[row.nodeId])) invalid()
      allBlobIds.add(row.id); const bytes = base64ToBytes(row.data, COURSE_PACKAGE_LIMITS.maxBlobBytes); blobTotal += bytes.length; docBlobTotal += bytes.length
      if (blobTotal > COURSE_PACKAGE_LIMITS.maxBlobBytes || docBlobTotal > BLOB_QUOTA_BYTES) invalid('课程包附件总量超过 64 MB。')
      if (await hashBytes(bytes) !== row.hash) invalid('课程包附件校验失败。'); blobs.push(row as unknown as PortableBlob)
    }
    const blobIds = new Set(blobs.map((b) => b.id))
    for (const node of Object.values(doc.nodes)) for (const ref of [...node.images ?? [], ...node.attachments ?? []]) if (!blobIds.has(ref.blobId)) invalid('编辑文档有缺失附件，无法完整恢复。')
    boundedArray(bundle.versions, 50); const versions: PortableDocument['versions'] = []
    for (const rawVersion of bundle.versions) {
      const v = keys(rawVersion, ['id', 'docId', 'title', 'createdAt', 'doc']); const versionDoc = inspectDocument(v.doc)
      if (typeof v.id !== 'string' || versionIds.has(v.id) || v.docId !== doc.id || versionDoc.id !== doc.id || typeof v.title !== 'string' || typeof v.createdAt !== 'number' || !Number.isSafeInteger(v.createdAt)) invalid()
      versionIds.add(v.id); versions.push({ id: v.id, docId: doc.id, title: v.title, createdAt: v.createdAt, doc: versionDoc })
    }
    documents.push({ doc, sources, blobs, versions })
  }
  const docIds = new Set(documents.map((d) => d.doc.id)); if (docIds.size !== documents.length || (input.missingDocumentIds as string[]).some((id) => docIds.has(id))) invalid()
  const ids = new Map(records.map((r) => [r.id, r])); const archiveMap = new Map<string, LearningArchive>()
  for (const record of records) if (record.kind === 'archive') archiveMap.set(record.id, await validateLearningArchive(record))
  const pointExists = (id: string) => ids.get(id)?.kind === 'point'
  for (const record of records) {
    const refs = entityReferences(record)
    for (const ref of refs.questionRefs) { const archive = archiveMap.get(ref.archiveId); const artifact = archive?.artifacts.find((a) => a.id === ref.artifactId && a.kind === 'quiz'); if (!artifact || artifact.kind !== 'quiz' || !artifact.payload.questions.some((q) => q.id === ref.questionId)) invalid('课程包题目身份不一致。') }
    for (const ref of refs.sourceRefs) { const source = archiveMap.get(ref.archiveId)?.sources.find((s) => s.id === ref.sourceId); if (!source || ref.end > source.text.length) invalid('课程包原文引用越界或缺失。') }
    if (record.kind === 'attempt' || record.kind === 'draft') {
      const artifact = archiveMap.get(record.question.archiveId)?.artifacts.find((a) => a.id === record.question.artifactId && a.kind === 'quiz')
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((q) => q.id === record.question.questionId) : undefined
      if (!question || question.type === 'multiple-choice' && (typeof record.answer !== 'number' || record.answer < 0 || record.answer >= question.options.length)
        || question.type === 'true-false' && typeof record.answer !== 'boolean' || question.type === 'short-answer' && typeof record.answer !== 'string') invalid('课程包作答类型或选项范围与题目不一致。')
    }
    if (record.kind === 'document' && !docIds.has(record.docId) && !(input.missingDocumentIds as string[]).includes(record.docId)) invalid()
    if (record.kind === 'point' && record.parentId && !pointExists(record.parentId)) invalid()
    if (record.kind === 'assessment') {
      const attempt = ids.get(record.attemptId); if (attempt?.kind !== 'attempt') invalid()
      const artifact = archiveMap.get(attempt.question.archiveId)?.artifacts.find((a) => a.id === attempt.question.artifactId && a.kind === 'quiz')
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((q) => q.id === attempt.question.questionId) : undefined
      if (!question || record.rubricChecks !== undefined && (question.type !== 'short-answer' || record.rubricChecks.length !== question.rubric.length)) invalid('课程包简答自评要点与题目不一致。')
    }
    if (record.kind === 'attempt' && record.sessionId) {
      const session = ids.get(record.sessionId)
      if (!session || session.kind !== 'session' || session.purpose !== 'exam' || !session.questions?.some((q) => q.archiveId === record.question.archiveId && q.artifactId === record.question.artifactId && q.questionId === record.question.questionId)) invalid('课程包作答场次与所选题目不一致。')
    }
    if (record.kind === 'schedule' && record.lastAttemptId && ids.get(record.lastAttemptId)?.kind !== 'attempt') invalid()
    if (record.kind === 'relation' && (!pointExists(record.fromPointId) || !pointExists(record.toPointId))) invalid()
    if (record.kind === 'merge' && (!pointExists(record.fromPointId) || !pointExists(record.toPointId) || record.undoOf && ids.get(record.undoOf)?.kind !== 'merge')) invalid()
    if (record.kind === 'merge') for (const prior of [...record.beforePoints ?? [], ...record.beforeRelations ?? []]) {
      if (prior.courseId !== course.id) invalid('课程包合并快照课程归属无效。')
      const oldRefs = entityReferences(prior)
      for (const ref of oldRefs.questionRefs) { const artifact = archiveMap.get(ref.archiveId)?.artifacts.find((a) => a.id === ref.artifactId && a.kind === 'quiz'); if (!artifact || artifact.kind !== 'quiz' || !artifact.payload.questions.some((q) => q.id === ref.questionId)) invalid('课程包合并快照题目引用无效。') }
      for (const ref of oldRefs.sourceRefs) { const source = archiveMap.get(ref.archiveId)?.sources.find((s) => s.id === ref.sourceId); if (!source || ref.end > source.text.length) invalid('课程包合并快照原文引用无效。') }
      if (prior.kind === 'point' && prior.parentId && !pointExists(prior.parentId) || prior.kind === 'relation' && (!pointExists(prior.fromPointId) || !pointExists(prior.toPointId))) invalid('课程包合并快照知识身份无效。')
    }
    if (record.kind === 'session' || record.kind === 'application') if (record.pointIds.some((id) => !pointExists(id))) invalid()
    if (record.kind === 'session' && record.purpose === 'exam' && record.status === 'completed') {
      if (record.questions?.some((q) => !records.some((r) => r.kind === 'attempt' && r.sessionId === record.id && r.question.archiveId === q.archiveId && r.question.artifactId === q.artifactId && r.question.questionId === q.questionId && (typeof r.answer !== 'string' || !!r.answer.trim())))) invalid('课程包测验完成状态缺少对应作答。')
    }
    if (record.kind === 'binding') {
      const artifact = archiveMap.get(record.archiveId)?.artifacts.find((a) => a.id === record.artifactId && a.kind === 'mindmap')
      if (!artifact || artifact.kind !== 'mindmap' || new Set(record.mappings.map((m) => m.generatedNodeId)).size !== record.mappings.length || new Set(record.mappings.map((m) => m.localNodeId)).size !== record.mappings.length) invalid('课程包节点身份映射无效。')
      for (const mapping of record.mappings) {
        const node = artifact.payload.nodes.find((n) => n.id === mapping.generatedNodeId); const point = ids.get(mapping.pointId)
        if (!node || mapping.originalText !== node.text || mapping.originalNote !== node.note || point?.kind !== 'point' || point.archiveId !== record.archiveId || point.generatedNodeId !== mapping.generatedNodeId) invalid('课程包节点关联不属于该生成知识点。')
      }
      // A deleted or edited local node disables its mapping; stale mapping metadata is portable, never guessed.
    }
  }
  const relationRecords = records.filter((r): r is Extract<LearningEntity, { kind: 'relation' }> => r.kind === 'relation')
  if (prerequisiteCycle(relationRecords)) invalid('课程包前置关系形成循环。')
  const pointRecords = records.filter((r): r is Extract<LearningEntity, { kind: 'point' }> => r.kind === 'point')
  for (const point of pointRecords) { const seen = new Set([point.id]); let parentId = point.parentId; while (parentId) { if (seen.has(parentId)) invalid('课程包章节结构形成循环。'); seen.add(parentId); parentId = (ids.get(parentId) as typeof point | undefined)?.parentId } }
  for (const kind of ['schedule', 'draft'] as const) {
    const references = records.filter((r) => r.kind === kind).map((r) => canonicalizeJson((r as Extract<LearningEntity, { kind: typeof kind }>).question))
    if (new Set(references.map((ref) => { const q = JSON.parse(ref) as { archiveId: string; artifactId: string; questionId: string }; return canonicalizeJson([q.archiveId, q.artifactId, q.questionId]) })).size !== references.length) invalid('课程包有重复题目草稿或复习安排。')
  }
  const payload = { ...input, course, records, documents } as unknown as CoursePackagePayload
  // Compare original bytes: sanitization during preview cannot conceal tampering or replace the checked scope.
  if (await sha256Hex(canonicalizeJson(payloadForHash(input as unknown as CoursePackagePayload))) !== input.contentHash) throw new LearningError('corrupt', '课程包内容校验失败。')
  return payload
}
export async function exportCoursePackage(courseId: string, options: { password?: string } = {}): Promise<Blob> {
  const captured = await db.transaction('r', [db.learningRecords, db.learningCourseTombstones, db.docs, db.sources, db.blobs, db.docVersions], async () => {
    if (await db.learningCourseTombstones.get(courseId)) invalid('课程已删除。')
    const course = await db.learningRecords.get(courseId); if (!course || course.kind !== 'course') invalid('课程不存在。')
    const records = (await db.learningRecords.where('courseId').equals(courseId).toArray()).filter((r) => r.id !== courseId)
    const docIds = new Set(records.flatMap((r) => r.kind === 'document' || r.kind === 'binding' ? [r.docId] : []))
    const documents = []; const missingDocumentIds: string[] = []
    for (const docId of docIds) {
      const row = await db.docs.get(docId); if (!row) { missingDocumentIds.push(docId); continue }
      documents.push({ doc: JSON.parse(row.payload) as DocData, sources: await db.sources.where('docId').equals(docId).toArray(), blobs: await db.blobs.where('docId').equals(docId).toArray(), versions: await db.docVersions.where('docId').equals(docId).toArray() })
    }
    return { course, records, documents, missingDocumentIds }
  })
  const documents: PortableDocument[] = []
  for (const item of captured.documents) {
    const blobs: PortableBlob[] = []
    for (const row of item.blobs) { const bytes = new Uint8Array(await row.blob.arrayBuffer()); blobs.push({ id: row.id, docId: row.docId, ...(row.nodeId ? { nodeId: row.nodeId } : {}), mime: row.blob.type, data: bytesToBase64(bytes), hash: await hashBytes(bytes), createdAt: row.createdAt }) }
    documents.push({ doc: item.doc, sources: item.sources, blobs, versions: item.versions.map((v) => ({ id: v.id, docId: v.docId, title: v.title, createdAt: v.createdAt, doc: JSON.parse(v.payload) as DocData })) })
  }
  const payload: CoursePackagePayload = JSON.parse(JSON.stringify({ format: FORMAT, version: 1, exportedAt: Date.now(), course: captured.course, records: captured.records, documents, missingDocumentIds: captured.missingDocumentIds, contentHash: '' })) as CoursePackagePayload
  payload.contentHash = await sha256Hex(canonicalizeJson(payloadForHash(payload))); await validateCoursePackagePayload(payload)
  if (!options.password) return new Blob([JSON.stringify(payload)], { type: 'application/vnd.maosizhi.course+json' })
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await passwordKey(options.password, salt)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(AAD) }, key, asBuffer(new TextEncoder().encode(JSON.stringify(payload))))
  return new Blob([JSON.stringify({ format: FORMAT, version: 1, encrypted: true, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) })], { type: 'application/vnd.maosizhi.course+json' })
}
export async function previewCoursePackage(file: Blob, options: { password?: string } = {}): Promise<CoursePackagePreview> {
  if (file.size > COURSE_PACKAGE_LIMITS.maxFileBytes) throw new LearningError('limit', '课程包文件超过 192 MB。')
  let raw: unknown
  try { raw = JSON.parse(await file.text()) } catch { invalid('课程包不是有效 JSON 文件。') }
  if (isRecord(raw) && raw.encrypted === true) {
    const envelope = keys(raw, ['format', 'version', 'encrypted', 'cipher', 'kdf', 'iterations', 'salt', 'iv', 'data'])
    if (envelope.format !== FORMAT || envelope.version !== 1 || envelope.cipher !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS) invalid('课程包加密版本不受支持。')
    const salt = base64ToBytes(envelope.salt, 16); const iv = base64ToBytes(envelope.iv, 12); if (salt.length !== 16 || iv.length !== 12) invalid()
    if (!options.password) throw new LearningError('password', '此课程包已加密，请输入密码。')
    const key = await passwordKey(options.password, salt)
    try { const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(AAD) }, key, asBuffer(base64ToBytes(envelope.data, COURSE_PACKAGE_LIMITS.maxPayloadBytes + 16))); raw = JSON.parse(new TextDecoder().decode(decrypted)) }
    catch { throw new LearningError('password', '密码不正确或加密课程包已经损坏。') }
  }
  const payload = await validateCoursePackagePayload(raw)
  const warnings = payload.missingDocumentIds.length ? [`${payload.missingDocumentIds.length} 份可编辑文档已经不存在；归档原文和学习记录仍会恢复，失效编辑关联会移除。`] : []
  let historicalMissing = 0; let staleMappings = 0
  for (const bundle of payload.documents) {
    const available = new Set(bundle.blobs.map((b) => b.id)); const availableSources = new Set(bundle.sources.map((s) => s.id))
    for (const version of bundle.versions) { for (const node of Object.values(version.doc.nodes)) historicalMissing += [...node.images ?? [], ...node.attachments ?? []].filter((r) => !available.has(r.blobId)).length; historicalMissing += (version.doc.relations ?? []).flatMap((r) => r.sourceRefs ?? []).filter((r) => !availableSources.has(r.sourceId)).length }
  }
  for (const binding of payload.records.filter((r) => r.kind === 'binding')) if (binding.kind === 'binding') { const doc = payload.documents.find((d) => d.doc.id === binding.docId)?.doc; if (doc) staleMappings += binding.mappings.filter((m) => !doc.nodes[m.localNodeId]).length }
  if (historicalMissing) warnings.push(`${historicalMissing} 项旧文档版本附件或引用的原始内容已经不存在；恢复旧版本结构时会移除这些失效项。`)
  if (staleMappings) warnings.push(`${staleMappings} 项已删除节点的学习关联会停用。`)
  return { courseName: payload.course.name, exportedAt: payload.exportedAt, counts: { documents: payload.documents.length, sources: payload.documents.reduce((n, d) => n + d.sources.length, 0), blobs: payload.documents.reduce((n, d) => n + d.blobs.length, 0), archives: payload.records.filter((r) => r.kind === 'archive').length, attempts: payload.records.filter((r) => r.kind === 'attempt').length, schedules: payload.records.filter((r) => r.kind === 'schedule').length, records: payload.records.length }, warnings, payload }
}
/** New local identities, preserved historical provenance. No analysis task/run is reinstated. */
export async function restoreCoursePackage(preview: CoursePackagePreview, options: { name?: string } = {}): Promise<Course> {
  const payload = await validateCoursePackagePayload(preview.payload)
  const courseId = newLearningId(); const idMap = new Map(payload.records.map((r) => [r.id, newLearningId()])); idMap.set(payload.course.id, courseId)
  // Removed self-relations still exist in undo snapshots and need fresh local identities too.
  for (const record of payload.records) if (record.kind === 'merge') for (const id of [...record.beforeRelations?.map((r) => r.id) ?? [], ...Object.keys(record.afterRelationRevisions ?? {})]) if (!idMap.has(id)) idMap.set(id, newLearningId())
  const docMap = new Map(payload.documents.map((d) => [d.doc.id, newLearningId()])); const nodeMaps = new Map<string, Map<string, string>>(); const sourceMaps = new Map<string, Map<string, string>>(); const blobMaps = new Map<string, Map<string, string>>()
  for (const bundle of payload.documents) {
    const nodeIds = new Set([Object.keys(bundle.doc.nodes), ...bundle.versions.map((v) => Object.keys(v.doc.nodes))].flat())
    nodeMaps.set(bundle.doc.id, new Map([...nodeIds].map((id) => [id, newLearningId()])))
    sourceMaps.set(bundle.doc.id, new Map(bundle.sources.map((s) => [s.id, newLearningId()])))
    blobMaps.set(bundle.doc.id, new Map(bundle.blobs.map((b) => [b.id, newLearningId()])))
  }
  const remapDoc = (input: DocData): DocData => {
    const docId = mapped(docMap, input.id); const nodes = mapped(nodeMaps, input.id); const sources = mapped(sourceMaps, input.id); const blobs = mapped(blobMaps, input.id)
    const result = structuredClone(input); result.id = docId; result.rootId = mapped(nodes, input.rootId)
    result.nodes = Object.fromEntries(Object.entries(input.nodes).map(([id, n]) => { const node = structuredClone(n); node.id = mapped(nodes, id); node.parent = n.parent ? mapped(nodes, n.parent) : null; node.children = n.children.map((c) => mapped(nodes, c))
      if (node.task?.deps) node.task.deps = node.task.deps.map((d) => ({ ...d, from: mapped(nodes, d.from) }))
      if (node.links) node.links = node.links.map((l) => l.kind === 'node' && l.nodeId ? { ...l, nodeId: mapped(nodes, l.nodeId) } : l)
      if (node.images) node.images = node.images.filter((i) => blobs.has(i.blobId)).map((i) => ({ ...i, blobId: mapped(blobs, i.blobId) })); if (node.attachments) node.attachments = node.attachments.filter((a) => blobs.has(a.blobId)).map((a) => ({ ...a, blobId: mapped(blobs, a.blobId) }))
      return [node.id, node]
    }))
    if (result.relations) result.relations = result.relations.map((r) => ({ ...r, id: newLearningId(), from: mapped(nodes, r.from), to: mapped(nodes, r.to), ...(r.sourceRefs ? { sourceRefs: r.sourceRefs.filter((s) => sources.has(s.sourceId)).map((s) => ({ ...s, sourceId: mapped(sources, s.sourceId) })) } : {}) }))
    if (result.summaries) result.summaries = result.summaries.map((s) => ({ ...s, id: newLearningId(), members: s.members.map((id) => mapped(nodes, id)) }))
    if (result.boundaryBoxes) result.boundaryBoxes = result.boundaryBoxes.map((s) => ({ ...s, id: newLearningId(), members: s.members.map((id) => mapped(nodes, id)) }))
    return inspectDocument(result)
  }
  const localId = (id: string) => idMap.get(id) ?? id
  const remapEntity = (input: LearningEntity): LearningEntity => {
    const r = structuredClone(input); r.id = localId(r.id); r.courseId = courseId
    if ('question' in r) r.question.archiveId = localId(r.question.archiveId)
    if (r.kind === 'archive') r.originDocId = docMap.get(r.originDocId) ?? r.originDocId
    if (r.kind === 'document') r.docId = mapped(docMap, r.docId)
    if (r.kind === 'point' || r.kind === 'relation') for (const ref of r.sourceRefs ?? []) ref.archiveId = localId(ref.archiveId)
    if (r.kind === 'point') {
      r.questionRefs.forEach((q) => q.archiveId = localId(q.archiveId)); if (r.parentId) r.parentId = localId(r.parentId); if (r.archiveId) r.archiveId = localId(r.archiveId)
      if (r.docId) { const oldDocId = r.docId; r.docId = docMap.get(oldDocId); if (r.nodeId) r.nodeId = nodeMaps.get(oldDocId)?.get(r.nodeId); if (!r.docId) { delete r.docId; delete r.nodeId } }
    }
    if (r.kind === 'assessment') r.attemptId = localId(r.attemptId)
    if (r.kind === 'attempt' && r.sessionId) r.sessionId = localId(r.sessionId)
    if (r.kind === 'draft') r.attemptId = localId(r.attemptId) === r.attemptId ? newLearningId() : localId(r.attemptId)
    if (r.kind === 'schedule' && r.lastAttemptId) r.lastAttemptId = localId(r.lastAttemptId)
    if (r.kind === 'relation' || r.kind === 'merge') { r.fromPointId = localId(r.fromPointId); r.toPointId = localId(r.toPointId) }
    if (r.kind === 'merge') {
      if (r.undoOf) r.undoOf = localId(r.undoOf); if (r.beforePoints) r.beforePoints = r.beforePoints.map((p) => remapEntity(p) as typeof p); if (r.beforeRelations) r.beforeRelations = r.beforeRelations.map((p) => remapEntity(p) as typeof p)
      for (const key of ['afterPointRevisions', 'afterRelationRevisions'] as const) { const revisions = r[key]; if (revisions) r[key] = Object.fromEntries(Object.entries(revisions).map(([id, revision]) => [localId(id), revision])) }
    }
    if (r.kind === 'session' || r.kind === 'application') { r.pointIds = r.pointIds.map(localId); if (r.kind === 'session') { r.steps.forEach((s) => s.pointId = localId(s.pointId)); r.questions?.forEach((q) => q.archiveId = localId(q.archiveId)) } }
    if (r.kind === 'binding') {
      const oldDocId = r.docId; const doc = payload.documents.find((d) => d.doc.id === oldDocId)?.doc
      r.docId = mapped(docMap, oldDocId); r.archiveId = localId(r.archiveId); r.mappings = r.mappings.filter((m) => doc?.nodes[m.localNodeId])
      if (!r.mappings.length) r.status = 'retired'
      else if (r.mappings.some((m) => doc?.nodes[m.localNodeId].text !== m.originalText || doc?.nodes[m.localNodeId].note !== m.originalNote || doc?.nodes[m.localNodeId].richNote !== undefined)) r.status = 'pending'
      r.mappings.forEach((m) => { m.localNodeId = mapped(mapped(nodeMaps, oldDocId), m.localNodeId); m.pointId = localId(m.pointId) })
    }
    return parseLearningEntity(r)
  }
  const missing = new Set(payload.missingDocumentIds)
  const records = payload.records.filter((r) => !(r.kind === 'document' || r.kind === 'binding') || !missing.has(r.docId)).map(remapEntity)
  const course: Course = { ...payload.course, id: courseId, courseId, name: options.name?.trim() || `${payload.course.name}（恢复）`, revision: 1, automaticReviews: false, updatedAt: Date.now() }
  parseLearningEntity(course)
  const documents = payload.documents.map((bundle) => {
    const docId = mapped(docMap, bundle.doc.id); const sourceIds = mapped(sourceMaps, bundle.doc.id); const nodeIds = mapped(nodeMaps, bundle.doc.id)
    return { oldId: bundle.doc.id, doc: remapDoc(bundle.doc), sources: bundle.sources.map((s) => ({ ...structuredClone(s), id: mapped(sourceIds, s.id), docId, anchors: s.anchors.filter((a) => nodeIds.has(a.nodeId)).map((a) => ({ ...a, nodeId: mapped(nodeIds, a.nodeId) })) })), blobs: bundle.blobs,
      versions: bundle.versions.map((v) => ({ ...v, id: newLearningId(), docId, doc: remapDoc(v.doc) })) }
  })
  const blobs: StoredBlob[] = []
  for (const bundle of documents) for (const b of bundle.blobs) blobs.push({ id: mapped(mapped(blobMaps, bundle.oldId), b.id), docId: bundle.doc.id, ...(b.nodeId ? { nodeId: mapped(mapped(nodeMaps, bundle.oldId), b.nodeId) } : {}), createdAt: b.createdAt, blob: new Blob([asBuffer(base64ToBytes(b.data, COURSE_PACKAGE_LIMITS.maxBlobBytes))], { type: b.mime }) })
  await Promise.all(records.filter((r): r is LearningArchive => r.kind === 'archive').map(validateLearningArchive))
  await db.transaction('rw', [db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones, db.docs, db.sources, db.blobs, db.docVersions, db.trash, db.documentTombstones], async () => {
    if (await db.learningRecords.get(courseId) || await db.learningCourseTombstones.get(courseId)) invalid('恢复身份冲突，请重新检查课程包。')
    for (const doc of documents) if (await db.docs.get(doc.doc.id) || await db.trash.get(doc.doc.id) || await db.documentTombstones.get(doc.doc.id)) invalid('恢复文档身份冲突。')
    await db.learningRecords.bulkAdd([course, ...records])
    for (const bundle of documents) {
      await db.docs.add({ id: bundle.doc.id, title: bundle.doc.title, createdAt: bundle.doc.createdAt, updatedAt: bundle.doc.updatedAt, payload: JSON.stringify(bundle.doc) })
      if (bundle.sources.length) await db.sources.bulkAdd(bundle.sources)
      if (bundle.versions.length) await db.docVersions.bulkAdd(bundle.versions.map((v) => ({ id: v.id, docId: v.docId, title: v.title, createdAt: v.createdAt, payload: JSON.stringify(v.doc) })))
    }
    if (blobs.length) await db.blobs.bulkAdd(blobs)
  })
  return course
}
