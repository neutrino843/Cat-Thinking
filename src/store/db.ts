import Dexie, { type Table } from 'dexie'
import type { DocData, DocMeta, SourceDocument } from '../types'
import { cloneDocBlobs, cloneFromTemplate } from '../lib/templateClone'
import { migrateDoc } from '../lib/migrate'
import type { MSZFileHandle } from '../lib/fsaTypes'
import type { StoredAnalysisTask } from '../analysis/taskPersistence'
import type { ApplicationReceipt } from '../analysis/mindMapApplication'
import type { QuizPracticeRecord } from '../analysis/quizPractice'
import { verifyRelationSourceHashes } from '../lib/relationSources'
import { notifyAnalysisBinding } from '../analysis/taskNotifications'
import type { LearningEntity } from '../learning/model'

/** 文档附件总量上限（64MB）：上传/校验时累加 blobs 表同 docId 总字节，超出拒绝 */
export const BLOB_QUOTA_BYTES = 64 * 1024 * 1024

export interface StoredDoc {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  payload: string
}

/** Permanent deletion keeps only an identity fence; content never belongs here. */
export interface DocumentTombstone {
  id: string
  deletedAt: number
}

export class DocumentDeletedError extends Error {
  constructor() {
    super('已删除文档不能由旧编辑自动恢复，请使用回收站还原或重新导入为新文档。')
    this.name = 'DocumentDeletedError'
  }
}

/** 自定义模板（M5）：结构与 StoredDoc 同构 */
export interface StoredTemplate {
  id: string
  name: string
  createdAt: number
  payload: string
}

/** 回收站条目（M6）：软删除文档的完整快照，30 天保留期后清扫 */
export interface StoredTrash {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt: number
  payload: string
}

/** 回收站元信息（不含 payload，用于列表展示） */
export interface TrashMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt: number
}

/** Blob 存储条目（M7-P1 建表，P3 使用）：图片/附件二进制数据 */
export interface StoredBlob {
  id: string
  /** 所属文档 id（用于文档删除时联动清理） */
  docId: string
  /** 关联节点 id（可选，图片可挂节点） */
  nodeId?: string

  blob: Blob
  createdAt: number
}

/**
 * M10：.msz 单文件模式的句柄绑定（docId ↔ 用户磁盘上的 .msz 文件）。
 * FileSystemFileHandle 是平台可结构化克隆对象，直接持久化进 IndexedDB；
 * 跨会话重开后通过 queryPermission/requestPermission 恢复读写授权。
 */
export interface StoredFileHandle {
  /** 主键：一篇文档最多绑定一个 .msz 文件 */
  docId: string
  handle: MSZFileHandle
  savedAt: number
}

/**
 * M15：文档版本快照（历史版本）。saveDoc 时节流写入，支持浏览与回滚。
 */
export interface StoredDocVersion {
  id: string
  docId: string
  title: string
  createdAt: number
  payload: string
}

/** 版本元信息（不含 payload，用于列表展示） */
export interface DocVersionMeta {
  id: string
  docId: string
  title: string
  createdAt: number
}

export class MSZDB extends Dexie {
  docs!: Table<StoredDoc, string>
  templates!: Table<StoredTemplate, string>
  trash!: Table<StoredTrash, string>
  blobs!: Table<StoredBlob, string>
  fileHandles!: Table<StoredFileHandle, string>
  docVersions!: Table<StoredDocVersion, string>
  sources!: Table<SourceDocument, string>
  analysisTasks!: Table<StoredAnalysisTask, string>
  applicationReceipts!: Table<ApplicationReceipt, string>
  quizPractices!: Table<QuizPracticeRecord, string>
  documentTombstones!: Table<DocumentTombstone, string>
  learningRecords!: Table<LearningEntity, string>
  learningCourseTombstones!: Table<{ id: string; deletedAt: number }, string>
  learningEntityTombstones!: Table<{ id: string; courseId: string; deletedAt: number }, string>
  constructor(name = 'maosizhi') {
    super(name)
    this.version(1).stores({ docs: 'id, updatedAt' })
    // M5：新增自定义模板表（仅增量加表，docs schema 不变，老库自动升级）
    this.version(2).stores({ docs: 'id, updatedAt', templates: 'id, createdAt' })
    // M6：新增回收站表（仅增量加表，docs/templates schema 不变，老库自动升级）
    this.version(3).stores({
      docs: 'id, updatedAt',
      templates: 'id, createdAt',
      trash: 'id, deletedAt',
    })
    // M7：新增 blobs 表（图片/附件二进制存储），仅增量加表，老库自动升级
    this.version(4).stores({
      docs: 'id, updatedAt',
      templates: 'id, createdAt',
      trash: 'id, deletedAt',
      blobs: 'id, docId, nodeId',
    })
    // M10：新增 fileHandles 表（.msz 单文件模式句柄绑定），仅增量加表，老库自动升级
    this.version(5).stores({
      docs: 'id, updatedAt',
      templates: 'id, createdAt',
      trash: 'id, deletedAt',
      blobs: 'id, docId, nodeId',
      fileHandles: 'docId',
    })
    // M15：新增 doc_versions 表（文档版本快照，支持历史浏览与回滚）
    this.version(6).stores({
      docs: 'id, updatedAt',
      templates: 'id, createdAt',
      trash: 'id, deletedAt',
      blobs: 'id, docId, nodeId',
      fileHandles: 'docId',
      docVersions: 'id, docId, createdAt',
    })
    // M17：来源文档与提取文本独立存放，避免编辑导图时重复序列化大段原文。
    this.version(7).stores({
      docs: 'id, updatedAt',
      templates: 'id, createdAt',
      trash: 'id, deletedAt',
      blobs: 'id, docId, nodeId',
      fileHandles: 'docId',
      docVersions: 'id, docId, createdAt',
      sources: 'id, docId, importedAt',
    })
    // Additive migration: existing documents, sources and history remain intact.
    this.version(8).stores({ analysisTasks: 'docId, runId, updatedAt' })
    this.version(9).stores({
      applicationReceipts: 'applicationIntentId, originDocId, targetDocId, artifactId',
      quizPractices: 'id, docId, runId, artifactId, updatedAt',
    })
    // Additive v10: durable identity fences also protect ordinary documents.
    // Fences have no automatic expiry: a suspended tab can retain old content indefinitely.
    this.version(10).stores({ documentTombstones: 'id' })
    // Learning V1 is additive: live task retention never removes immutable learning archives.
    this.version(11).stores({ learningRecords: 'id, kind, courseId, docId, [courseId+kind]', learningCourseTombstones: 'id', learningEntityTombstones: 'id, courseId' })
  }
}

export const db = new MSZDB()

function toMeta(s: StoredDoc): DocMeta {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }
}

export async function listDocs(): Promise<DocMeta[]> {
  const all = await db.docs.toArray()
  return all.map(toMeta).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadDoc(id: string): Promise<DocData | null> {
  const s = await db.docs.get(id)
  if (!s) return null
  try {
    const raw = JSON.parse(s.payload) as DocData | { version: 1 } & DocData
    // M7：v1 → v2 懒迁移（不改盘直到首次编辑保存）
    return migrateDoc(raw as DocData)
  } catch (e) {
    // 修 F-3：payload 损坏不可向上抛未处理 rejection；返回 null 由调用方 fallback
    console.error(`[猫思之] 文档 ${id} 的数据已损坏，无法读取`, e)
    return null
  }
}

export async function saveDoc(doc: DocData): Promise<void> {
  await db.transaction('rw', db.docs, db.trash, db.documentTombstones, db.applicationReceipts, async () => {
    const existing = await db.docs.get(doc.id)
    await assertWritableDocumentIdentity(doc.id)
    if (!existing && await db.applicationReceipts.where('targetDocId').equals(doc.id).first()) throw new DocumentDeletedError()
    await db.docs.put({
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      payload: JSON.stringify(doc),
    })
  })
  // M15：节流写入版本快照（每文档最少间隔 5 分钟，保留最近 50 个版本）
  await snapshotVersion(doc)
}

/** Call inside a transaction that includes trash and documentTombstones. */
async function assertWritableDocumentIdentity(id: string): Promise<void> {
  if (await db.documentTombstones.get(id) || await db.trash.get(id)) throw new DocumentDeletedError()
}

/* ---------------- 版本历史（M15） ---------------- */

/** 版本节流：同文档两次快照最小间隔（毫秒） */
const VERSION_MIN_INTERVAL_MS = 5 * 60 * 1000
/** 每文档保留版本数上限 */
const VERSION_MAX_PER_DOC = 50
/** 内存记录每文档上次快照时间，避免每次 saveDoc 都查库 */
const lastVersionAt = new Map<string, number>()

function genVersionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * saveDoc 时调用：若距该文档上次快照超过 VERSION_MIN_INTERVAL_MS 则写入新快照，
 * 并在超过 VERSION_MAX_PER_DOC 时清理最旧版本。best-effort，失败仅 warn 不阻断保存。
 */
async function snapshotVersion(doc: DocData): Promise<void> {
  try {
    await db.transaction('rw', db.docs, db.trash, db.documentTombstones, db.docVersions, async () => {
      const current = await db.docs.get(doc.id)
      // The document may have been deleted or changed after its main save committed.
      if (!current || current.payload !== JSON.stringify(doc) || await db.trash.get(doc.id) || await db.documentTombstones.get(doc.id)) return
      const now = Date.now()
      const last = lastVersionAt.get(doc.id) ?? 0
      if (now - last < VERSION_MIN_INTERVAL_MS) return
      await db.docVersions.put({ id: genVersionId(), docId: doc.id, title: doc.title, createdAt: now, payload: current.payload })
      const all = await db.docVersions.where('docId').equals(doc.id).sortBy('createdAt')
      if (all.length > VERSION_MAX_PER_DOC) await db.docVersions.bulkDelete(all.slice(0, all.length - VERSION_MAX_PER_DOC).map((version) => version.id))
      lastVersionAt.set(doc.id, now)
    })
  } catch (e) {
    console.warn('[猫思之] 版本快照写入失败', e)
  }
}

/** 测试钩子：清空版本节流记忆，便于单测/E2E 立即产生快照 */
export function __resetVersionThrottle(): void {
  lastVersionAt.clear()
}

/** 列出某文档的版本元信息（按时间倒序，不含 payload） */
export async function listVersions(docId: string): Promise<DocVersionMeta[]> {
  const all = await db.docVersions.where('docId').equals(docId).sortBy('createdAt')
  return all
    .reverse()
    .map((v) => ({ id: v.id, docId: v.docId, title: v.title, createdAt: v.createdAt }))
}

/** 读取单个版本快照（迁移到当前模型版本后返回） */
export async function loadVersion(versionId: string): Promise<DocData | null> {
  const v = await db.docVersions.get(versionId)
  if (!v) return null
  try {
    const raw = JSON.parse(v.payload) as DocData
    return migrateDoc(raw)
  } catch (e) {
    console.error('[猫思之] 版本快照解析失败', e)
    return null
  }
}

/**
 * 用指定版本快照覆盖当前文档（回滚）。将快照内容写入 docs 表并更新 updatedAt，
 * 同时刷新该文档的内存节流标记以便后续保存立即产生新版本。
 */
export async function restoreVersion(versionId: string): Promise<DocData | null> {
  try {
    return await db.transaction('rw', db.docs, db.trash, db.documentTombstones, db.docVersions, async () => {
      const version = await db.docVersions.get(versionId)
      if (!version) return null
      const migrated = migrateDoc(JSON.parse(version.payload) as DocData)
      if (migrated.id !== version.docId || !await db.docs.get(version.docId)) return null
      await assertWritableDocumentIdentity(version.docId)
      const now = Date.now()
      const restored: DocData = { ...migrated, updatedAt: now }
      await db.docs.put({ id: restored.id, title: restored.title, createdAt: restored.createdAt, updatedAt: now, payload: JSON.stringify(restored) })
      lastVersionAt.set(restored.id, now)
      return restored
    })
  } catch (e) {
    console.error('[猫思之] 版本回滚失败', e)
    return null
  }
}

/** 删除单个版本快照 */
export async function deleteVersion(versionId: string): Promise<void> {
  await db.docVersions.delete(versionId)
}

/** 原子保存新导图及其来源文档，避免出现只有导图或只有原文的半成功状态。 */
export async function saveDocumentBundle(doc: DocData, sources: SourceDocument[], blobs: ReadonlyMap<string, Blob> = new Map()): Promise<void> {
  if (sources.some((source) => source.docId !== doc.id)) {
    throw new Error('来源文档与导图 ID 不一致')
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('来源文档 ID 重复')
  await verifyRelationSourceHashes(doc, sources)
  await db.transaction('rw', [db.docs, db.sources, db.blobs, db.trash, db.documentTombstones, db.applicationReceipts], async () => {
    await assertWritableDocumentIdentity(doc.id)
    if (!await db.docs.get(doc.id) && await db.applicationReceipts.where('targetDocId').equals(doc.id).first()) throw new DocumentDeletedError()
    await assertBlobQuota(doc.id, blobs)
    for (const source of sources) {
      const existing = await db.sources.get(source.id)
      if (existing && existing.docId !== doc.id) throw new Error('来源 ID 属于其他文档，不能覆盖其原文')
    }
    await db.docs.put({
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      payload: JSON.stringify(doc),
    })
    // bundle 表示完整替换：导入同 id 的备份时，先清理旧来源，避免遗留幽灵数据。
    await db.sources.where('docId').equals(doc.id).delete()
    if (sources.length) await db.sources.bulkPut(sources)
    for (const [id, blob] of blobs) await putBlob(id, doc.id, blob)
  })
  // 版本历史属于辅助能力；主文档与来源已原子落盘后，再 best-effort 建初始快照。
  await snapshotVersion(doc)
  notifyAnalysisBinding({ version: 1, docId: doc.id, type: 'artifact' })
}

/** Explicit file import may recover content, while a deleted identity stays permanently fenced. */
export async function saveImportedDocumentBundle(doc: DocData, sources: SourceDocument[], blobs: ReadonlyMap<string, Blob> = new Map()): Promise<DocData> {
  const saveCopy = async (): Promise<DocData> => {
    const cloned = cloneFromTemplate(doc, sources, { preserveCollapsed: true })
    // Imported files retain their presentation and creation time; only identities change.
    cloned.doc.createdAt = doc.createdAt
    const copiedBlobs = new Map<string, Blob>()
    for (const [oldId, newId] of cloned.blobMap) {
      const blob = blobs.get(oldId)
      if (blob) copiedBlobs.set(newId, blob)
    }
    await saveDocumentBundle(cloned.doc, cloned.sources, copiedBlobs)
    return cloned.doc
  }
  if (await db.documentTombstones.get(doc.id) || await db.trash.get(doc.id)) return saveCopy()
  try {
    await saveDocumentBundle(doc, sources, blobs)
    return doc
  } catch (error) {
    // A deletion can commit between the initial read and the bundle transaction.
    if (error instanceof DocumentDeletedError) return saveCopy()
    throw error
  }
}

/** 按导图列出来源；后续多文档分析继续复用这一边界。 */
export async function listSourcesByDoc(docId: string): Promise<SourceDocument[]> {
  return await db.sources.where('docId').equals(docId).sortBy('importedAt')
}

export async function getSource(id: string): Promise<SourceDocument | undefined> {
  return await db.sources.get(id)
}

export async function putSource(source: SourceDocument): Promise<void> {
  await db.transaction('rw', db.sources, db.trash, db.documentTombstones, async () => {
    await assertWritableDocumentIdentity(source.docId)
    const existing = await db.sources.get(source.id)
    if (existing && existing.docId !== source.docId) throw new Error('来源 ID 属于其他文档，不能覆盖其原文')
    await db.sources.put(source)
  })
  const notify = () => notifyAnalysisBinding({ version: 1, docId: source.docId, type: 'artifact' })
  if (Dexie.currentTransaction) Dexie.currentTransaction.on('complete', notify)
  else notify()
}

export async function deleteSourcesByDoc(docId: string): Promise<void> {
  await db.sources.where('docId').equals(docId).delete()
  const notify = () => notifyAnalysisBinding({ version: 1, docId, type: 'artifact' })
  // Never broadcast a mutation which could still roll back in its parent transaction.
  if (Dexie.currentTransaction) Dexie.currentTransaction.on('complete', notify)
  else notify()
}

export async function deleteDoc(id: string): Promise<void> {
  await db.transaction('rw', permanentDeletionTables(), () => permanentlyDeleteInsideTransaction(id))
  notifyAnalysisBinding({ version: 1, docId: id, type: 'deleted' })
}

/* ---------------- Blob 存储（M7-P3） ---------------- */

/** 生成 blob id：与 uid 同模式，crypto.randomUUID 优先 */
function genBlobId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Every attachment entry point shares the same transaction-safe document quota. */
async function assertBlobQuota(docId: string, replacements: ReadonlyMap<string, Blob>): Promise<void> {
  const sizes = new Map((await db.blobs.where('docId').equals(docId).toArray()).map((row) => [row.id, row.blob.size]))
  for (const [id, blob] of replacements) sizes.set(id, blob.size)
  let total = 0
  for (const size of sizes.values()) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('附件数据已损坏。')
    total += size
    if (total > BLOB_QUOTA_BYTES) throw new Error(`文档附件总量超限（${BLOB_QUOTA_BYTES / 1024 / 1024}MB）`)
  }
}

/**
 * 保存 blob：写入前校验文档 blob 总量是否超 64MB 配额。
 * 超限抛中文 Error；否则 put 新条目并返回 id。
 */
export async function saveBlob(docId: string, blob: Blob, nodeId?: string): Promise<string> {
  return await db.transaction('rw', db.blobs, db.docs, db.trash, db.documentTombstones, async () => {
    await assertWritableDocumentIdentity(docId)
    const owner = await db.docs.get(docId)
    if (!owner) throw new Error('附件所属文档已经不存在。')
    const id = genBlobId()
    await assertBlobQuota(docId, new Map([[id, blob]]))
    await db.blobs.put({ id, docId, nodeId, blob, createdAt: Date.now() })
    return id
  })
}

/** 取单个 blob 二进制；未找到返回 undefined */
export async function getBlob(blobId: string): Promise<Blob | undefined> {
  const row = await db.blobs.get(blobId)
  return row?.blob
}

/** 替换/写入 blob（给定 id），用于导入恢复 */
export async function putBlob(id: string, docId: string, blob: Blob, nodeId?: string): Promise<void> {
  await db.transaction('rw', db.blobs, db.trash, db.documentTombstones, async () => {
    await assertWritableDocumentIdentity(docId)
    const existing = await db.blobs.get(id)
    if (existing && existing.docId !== docId) throw new Error('附件 ID 属于其他文档，不能覆盖其内容。')
    await assertBlobQuota(docId, new Map([[id, blob]]))
    await db.blobs.put({ id, docId, nodeId, blob, createdAt: Date.now() })
  })
}

/** 删除单个 blob */
export async function deleteBlob(blobId: string): Promise<void> {
  await db.blobs.delete(blobId)
}

/** 按文档 id 批量删除 blob（删除/还原文档时联动清理） */
export async function deleteBlobsByDoc(docId: string): Promise<void> {
  await db.blobs.where('docId').equals(docId).delete()
}

/* ---------------- 回收站（M6） ---------------- */

const DAY_MS = 86400000

/**
 * 软删除：事务内 docs.get → trash.put(deletedAt=now) → docs.delete，保证不丢数据。
 * 文档不存在则静默 no-op（与原 deleteDoc 行为对齐）。
 */
export async function moveToTrash(id: string): Promise<void> {
  await db.transaction('rw', db.docs, db.trash, db.quizPractices, db.documentTombstones, async () => {
    const s = await db.docs.get(id)
    if (!s || await db.documentTombstones.get(id)) return
    await db.trash.put({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      deletedAt: Date.now(),
      payload: s.payload,
    })
    await db.docs.delete(id)
    await db.quizPractices.where('docId').equals(id).delete()
  })
  notifyAnalysisBinding({ version: 1, docId: id, type: 'deleted' })
}

/** 列出回收站（按 deletedAt 降序，仅 meta） */
export async function listTrash(): Promise<TrashMeta[]> {
  const all = await db.trash.toArray()
  return all
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      deletedAt: t.deletedAt,
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

/**
 * 从回收站还原：trash.get → docs.put → trash.delete。
 * 若 docs 已存在同 id（实践中 uuid 不冲突，仅防御），用 cloneFromTemplate 重映射 id 后入库，
 * 保留原标题/原时间戳。返回还原后的文档 id（用于 App 定位）。
 */
export async function restoreDoc(id: string): Promise<string | null> {
  return await db.transaction('rw', db.docs, db.trash, db.blobs, db.sources, db.documentTombstones, async () => {
    const t = await db.trash.get(id)
    if (!t || await db.documentTombstones.get(id)) return null
    const existing = await db.docs.get(id)
    let targetId = id
    let payload = t.payload
    if (existing) {
      const doc = JSON.parse(t.payload) as DocData
      const originalSources = await db.sources.where('docId').equals(id).toArray()
      const { doc: cloned, blobMap, sources } = cloneFromTemplate(doc, originalSources)
      await cloneDocBlobs(t.id, cloned.id, blobMap, getBlob, putBlob)
      if (sources.length) await db.sources.bulkAdd(sources)
      cloned.title = t.title
      cloned.createdAt = t.createdAt
      cloned.updatedAt = t.updatedAt
      targetId = cloned.id
      payload = JSON.stringify(cloned)
    }
    await db.docs.put({
      id: targetId,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      payload,
    })
    await db.trash.delete(id)
    return targetId
  })
}

function permanentDeletionTables(): Table[] {
  return [db.docs, db.trash, db.blobs, db.docVersions, db.sources, db.analysisTasks, db.quizPractices, db.fileHandles, db.documentTombstones]
}

/** All deletion callers hold the same write transaction, including the durable fence. */
async function permanentlyDeleteInsideTransaction(id: string): Promise<void> {
  if (!await db.documentTombstones.get(id)) await db.documentTombstones.put({ id, deletedAt: Date.now() })
  await db.docs.delete(id)
  await db.trash.delete(id)
  await db.analysisTasks.delete(id)
  await db.quizPractices.where('docId').equals(id).delete()
  await db.fileHandles.delete(id)
  await deleteBlobsByDoc(id)
  await deleteSourcesByDoc(id)
  const versions = await db.docVersions.where('docId').equals(id).primaryKeys()
  await db.docVersions.bulkDelete(versions)
  lastVersionAt.delete(id)
}

/** 永久删除单条 */
export async function purgeDoc(id: string): Promise<void> {
  const deleted = await db.transaction('rw', permanentDeletionTables(), async () => {
    // A stale trash action must not delete a document already restored elsewhere.
    if (!await db.trash.get(id)) return false
    await permanentlyDeleteInsideTransaction(id)
    return true
  })
  if (deleted) notifyAnalysisBinding({ version: 1, docId: id, type: 'deleted' })
}

/** 清空回收站 */
export async function emptyTrash(): Promise<void> {
  const deletedIds: string[] = []
  await db.transaction('rw', permanentDeletionTables(), async () => {
    const all = await db.trash.toArray()
    for (const t of all) {
      deletedIds.push(t.id)
      await permanentlyDeleteInsideTransaction(t.id)
    }
  })
  for (const docId of deletedIds) notifyAnalysisBinding({ version: 1, docId, type: 'deleted' })
}

/** 启动清扫：删除 deletedAt 超过 retentionDays 的条目（fire-and-forget 调用）。
 * 修审计 M-1：旧实现只删 trash 条目不删关联 blob，导致超期文档的二进制数据永久泄漏；
 * 现在事务内同步清理 blobs。M15：同步清理版本快照。 */
export async function sweepTrash(retentionDays = 30): Promise<void> {
  const cutoff = Date.now() - retentionDays * DAY_MS
  const deletedIds: string[] = []
  await db.transaction('rw', permanentDeletionTables(), async () => {
    const stale = await db.trash.where('deletedAt').below(cutoff).toArray()
    for (const t of stale) {
      deletedIds.push(t.id)
      await permanentlyDeleteInsideTransaction(t.id)
    }
  })
  for (const docId of deletedIds) notifyAnalysisBinding({ version: 1, docId, type: 'deleted' })
}

/* ---------------- 自定义模板（M5） ---------------- */

export interface CustomTemplate {
  id: string
  name: string
  createdAt: number
  doc: DocData
}

export async function listTemplates(): Promise<CustomTemplate[]> {
  const all = await db.templates.toArray()
  return all
    .map((t) => {
      try {
        return { id: t.id, name: t.name, createdAt: t.createdAt, doc: JSON.parse(t.payload) as DocData }
      } catch {
        return null
      }
    })
    .filter((t): t is CustomTemplate => !!t)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveTemplate(name: string, doc: DocData, importedSources?: SourceDocument[], importedBlobs?: ReadonlyMap<string, Blob>): Promise<string> {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  const sourceDocuments = importedSources ?? await listSourcesByDoc(doc.id)
  await verifyRelationSourceHashes(doc, sourceDocuments)
  const { doc: cloned, blobMap, sources } = cloneFromTemplate(doc, sourceDocuments)
  const previousCloneId = cloned.id
  cloned.id = id
  for (const source of sources) if (source.docId === previousCloneId) source.docId = id
  await db.transaction('rw', db.templates, db.blobs, db.sources, db.trash, db.documentTombstones, async () => {
    await cloneDocBlobs(doc.id, id, blobMap, (blobId) => importedBlobs ? Promise.resolve(importedBlobs.get(blobId)) : getBlob(blobId), putBlob)
    if (sources.length) await db.sources.bulkAdd(sources)
    await db.templates.add({ id, name, createdAt: Date.now(), payload: JSON.stringify(cloned) })
  })
  return id
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.transaction('rw', db.templates, db.blobs, db.sources, async () => {
    await deleteBlobsByDoc(id)
    await deleteSourcesByDoc(id)
    await db.templates.delete(id)
  })
}

/* ---------------- .msz 单文件模式句柄绑定（M10） ---------------- */

/** 持久化文档 → .msz 文件句柄的绑定（覆盖保存同一主键） */
export async function bindFileHandle(docId: string, handle: MSZFileHandle): Promise<void> {
  await db.transaction('rw', db.docs, db.trash, db.documentTombstones, db.fileHandles, async () => {
    await assertWritableDocumentIdentity(docId)
    if (!await db.docs.get(docId)) throw new DocumentDeletedError()
    await db.fileHandles.put({ docId, handle, savedAt: Date.now() })
  })
}

/** 读取文档绑定的 .msz 句柄；未绑定返回 undefined */
export async function getFileHandle(docId: string): Promise<MSZFileHandle | undefined> {
  const row = await db.fileHandles.get(docId)
  return row?.handle
}

/** 更新绑定的最近保存时间（Ctrl+S 覆写成功后） */
export async function touchFileHandle(docId: string): Promise<void> {
  await db.transaction('rw', db.docs, db.trash, db.documentTombstones, db.fileHandles, async () => {
    await assertWritableDocumentIdentity(docId)
    const row = await db.fileHandles.get(docId)
    if (row && await db.docs.get(docId)) await db.fileHandles.put({ ...row, savedAt: Date.now() })
  })
}

/** 删除文档的 .msz 句柄绑定（不影响磁盘文件本身） */
export async function unbindFileHandle(docId: string): Promise<void> {
  await db.fileHandles.delete(docId)
}

export const LAST_KEY = 'msz.lastDoc'
