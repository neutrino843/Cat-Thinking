import Dexie, { type Table } from 'dexie'
import type { DocData, DocMeta } from '../types'
import { cloneFromTemplate } from '../lib/templateClone'

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

class MSZDB extends Dexie {
  docs!: Table<StoredDoc, string>
  templates!: Table<StoredTemplate, string>
  trash!: Table<StoredTrash, string>
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
    return JSON.parse(s.payload) as DocData
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
  await db.docs.delete(id)
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
  return await db.transaction('rw', db.docs, db.trash, async () => {
    const t = await db.trash.get(id)
    if (!t) return null
    const existing = await db.docs.get(id)
    let targetId = id
    let payload = t.payload
    if (existing) {
      const doc = JSON.parse(t.payload) as DocData
      const cloned = cloneFromTemplate(doc)
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
  await db.trash.delete(id)
}

/** 清空回收站 */
export async function emptyTrash(): Promise<void> {
  await db.trash.clear()
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
  await db.templates.put({ id, name, createdAt: Date.now(), payload: JSON.stringify(doc) })
  return id
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.templates.delete(id)
}

export const LAST_KEY = 'msz.lastDoc'
