import Dexie, { type Table } from 'dexie'
import type { DocData, DocMeta } from '../types'
import { cloneDocBlobs, cloneFromTemplate } from '../lib/templateClone'
import { migrateDoc } from '../lib/migrate'

/** 文档附件总量上限（64MB）：上传/校验时累加 blobs 表同 docId 总字节，超出拒绝 */
export const BLOB_QUOTA_BYTES = 64 * 1024 * 1024

export interface StoredDoc {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  payload: string
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

class MSZDB extends Dexie {
  docs!: Table<StoredDoc, string>
  templates!: Table<StoredTemplate, string>
  trash!: Table<StoredTrash, string>
  blobs!: Table<StoredBlob, string>
  constructor() {
    super('maosizhi')
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
  await db.docs.put({
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    payload: JSON.stringify(doc),
  })
}

export async function deleteDoc(id: string): Promise<void> {
  await db.transaction('rw', db.docs, db.blobs, async () => {
    await db.docs.delete(id)
    await deleteBlobsByDoc(id)
  })
}

/* ---------------- Blob 存储（M7-P3） ---------------- */

/** 生成 blob id：与 uid 同模式，crypto.randomUUID 优先 */
function genBlobId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * 保存 blob：写入前校验文档 blob 总量是否超 64MB 配额。
 * 超限抛中文 Error；否则 put 新条目并返回 id。
 */
export async function saveBlob(docId: string, blob: Blob, nodeId?: string): Promise<string> {
  const all = await db.blobs.where('docId').equals(docId).toArray()
  const total = all.reduce((s, b) => s + b.blob.size, 0)
  if (total + blob.size > BLOB_QUOTA_BYTES) {
    throw new Error(`文档附件总量超限（${BLOB_QUOTA_BYTES / 1024 / 1024}MB）`)
  }
  const id = genBlobId()
  await db.blobs.put({ id, docId, nodeId, blob, createdAt: Date.now() })
  return id
}

/** 取单个 blob 二进制；未找到返回 undefined */
export async function getBlob(blobId: string): Promise<Blob | undefined> {
  const row = await db.blobs.get(blobId)
  return row?.blob
}

/** 替换/写入 blob（给定 id），用于导入恢复 */
export async function putBlob(id: string, docId: string, blob: Blob, nodeId?: string): Promise<void> {
  await db.blobs.put({ id, docId, nodeId, blob, createdAt: Date.now() })
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
  await db.transaction('rw', db.docs, db.trash, async () => {
    const s = await db.docs.get(id)
    if (!s) return
    await db.trash.put({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      deletedAt: Date.now(),
      payload: s.payload,
    })
    await db.docs.delete(id)
  })
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
  return await db.transaction('rw', db.docs, db.trash, db.blobs, async () => {
    const t = await db.trash.get(id)
    if (!t) return null
    const existing = await db.docs.get(id)
    let targetId = id
    let payload = t.payload
    if (existing) {
      const doc = JSON.parse(t.payload) as DocData
      const { doc: cloned, blobMap } = cloneFromTemplate(doc)
      await cloneDocBlobs(t.id, cloned.id, blobMap, getBlob, putBlob)
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

/** 永久删除单条 */
export async function purgeDoc(id: string): Promise<void> {
  await db.transaction('rw', db.trash, db.blobs, async () => {
    await deleteBlobsByDoc(id)
    await db.trash.delete(id)
  })
}

/** 清空回收站 */
export async function emptyTrash(): Promise<void> {
  await db.transaction('rw', db.trash, db.blobs, async () => {
    const all = await db.trash.toArray()
    for (const t of all) await deleteBlobsByDoc(t.id)
    await db.trash.clear()
  })
}

/** 启动清扫：删除 deletedAt 超过 retentionDays 的条目（fire-and-forget 调用） */
export async function sweepTrash(retentionDays = 30): Promise<void> {
  const cutoff = Date.now() - retentionDays * DAY_MS
  const stale = await db.trash.where('deletedAt').below(cutoff).toArray()
  await Promise.all(stale.map((t) => db.trash.delete(t.id)))
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

export async function saveTemplate(name: string, doc: DocData): Promise<string> {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  const { doc: cloned, blobMap } = cloneFromTemplate(doc)
  await cloneDocBlobs(doc.id, id, blobMap, getBlob, putBlob)
  await db.templates.put({ id, name, createdAt: Date.now(), payload: JSON.stringify(cloned) })
  return id
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.transaction('rw', db.templates, db.blobs, async () => {
    await deleteBlobsByDoc(id)
    await db.templates.delete(id)
  })
}

export const LAST_KEY = 'msz.lastDoc'
