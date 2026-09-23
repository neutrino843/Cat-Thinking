import Dexie, { type Table } from 'dexie'
import type { DocData, DocMeta } from '../types'

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

class MSZDB extends Dexie {
  docs!: Table<StoredDoc, string>
  templates!: Table<StoredTemplate, string>
  constructor() {
    super('maosizhi')
    this.version(1).stores({ docs: 'id, updatedAt' })
    // M5：新增自定义模板表（仅增量加表，docs schema 不变，老库自动升级）
    this.version(2).stores({ docs: 'id, updatedAt', templates: 'id, createdAt' })
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
  return s ? (JSON.parse(s.payload) as DocData) : null
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
