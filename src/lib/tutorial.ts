import { buildDoc, findTpl } from '../data/templates'
import { db } from '../store/db'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import type { DocData } from '../types'
import { emitDocsChanged } from './tabs'

/** A new template never rewrites an existing document, including old tutorials. */
export const TUTORIAL_REVISION = '2026-10-14-v1-course-learning'

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]),
  )
  return value
}

function tutorialContent(doc: DocData): string | null {
  const visited = new Set<string>()
  const walk = (id: string, parent: string | null, depth: number): unknown => {
    const node = doc.nodes[id]
    if (!node || node.id !== id || node.parent !== parent || visited.has(id) || depth > 16 || !Array.isArray(node.children)) {
      throw new Error('invalid_tutorial_tree')
    }
    visited.add(id)
    const content = Object.fromEntries(Object.entries(node).filter(([key]) => !['id', 'parent', 'children'].includes(key)))
    return { ...content, children: node.children.map((child) => walk(child, id, depth + 1)) }
  }
  try {
    const root = walk(doc.rootId, null, 0)
    if (visited.size !== Object.keys(doc.nodes).length) return null
    // Keep every user-editable field; ignore only generated identities and timestamps.
    const content = Object.fromEntries(Object.entries(doc).filter(([key]) => !['id', 'rootId', 'nodes', 'createdAt', 'updatedAt'].includes(key)))
    return JSON.stringify(sorted({ ...content, root }))
  } catch { return null }
}

const latestTemplate = buildDoc(findTpl('welcome'))
const latestContent = tutorialContent(latestTemplate)

export function isUnmodifiedLatestTutorial(doc: DocData): boolean {
  if (!doc || !doc.nodes || typeof doc.nodes !== 'object' || Array.isArray(doc.nodes)) return false
  return Object.keys(doc.nodes ?? {}).length === Object.keys(latestTemplate.nodes).length
    && latestContent !== null && tutorialContent(doc) === latestContent
}

const liveDocument = (id: string): DocData | undefined => {
  const state = useDoc.getState()
  return state.doc.id === id ? state.doc : state.sessions[id]?.doc
}

/** Serialize lookup/create across browser tabs; deleted tutorials are never restored. */
export async function getOrCreateLatestTutorial(): Promise<DocData> {
  return db.transaction('rw', [db.docs, db.sources, db.blobs, db.trash, db.documentTombstones], async () => {
    const rows = await db.docs.toArray()
    for (const row of rows) {
      if (row.title !== latestTemplate.title || await db.trash.get(row.id) || await db.documentTombstones.get(row.id)) continue
      let doc: DocData
      try { doc = JSON.parse(row.payload) as DocData } catch { continue }
      if (!doc || doc.id !== row.id || !isUnmodifiedLatestTutorial(doc)) continue
      const live = liveDocument(row.id)
      if (live && !isUnmodifiedLatestTutorial(live)) continue
      if (await db.sources.where('docId').equals(row.id).first() || await db.blobs.where('docId').equals(row.id).first()) continue
      return live ?? doc
    }
    const doc = buildDoc(findTpl('welcome'))
    if (await db.docs.get(doc.id) || await db.trash.get(doc.id) || await db.documentTombstones.get(doc.id)) {
      throw new Error('tutorial_identity_conflict')
    }
    await db.docs.put({ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, payload: JSON.stringify(doc) })
    return doc
  })
}

let openPromise: Promise<void> | null = null

export function openLatestTutorial(): Promise<void> {
  if (openPromise) return openPromise
  openPromise = getOrCreateLatestTutorial().then((doc) => {
    useDoc.getState().openDoc(doc)
    useSettings.getState().setView('mind')
    emitDocsChanged()
    requestAnimationFrame(() => window.dispatchEvent(new Event('msz:fit')))
  }).finally(() => { openPromise = null })
  return openPromise
}

export function requestLatestTutorial(): void {
  void openLatestTutorial().catch(() => window.alert('使用教程未能打开。请检查浏览器是否允许本地存储，再点击「使用教程」重试；现有文档不会被替换。'))
}
