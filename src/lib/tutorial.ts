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

/** 复用/新建的创建去重：并发调用共享同一次 getOrCreateLatestTutorial，避免竞态创建两份教程 */
let creatingPromise: Promise<DocData> | null = null
/** 在途的「打开+落地」promise 按 to 缓存：同入口重复点击复用同一 promise，结束后清除 */
const openPromises = new Map<'home' | 'editor', Promise<DocData>>()

/**
 * 打开（复用/新建）最新版欢迎教程。
 * - to:'editor'（默认）：编辑器内入口——切到思维导图视图并触发 fit，停留在编辑器；
 * - to:'home'：学习首页入口——仅准备好教程文档（标签/会话就位），随后派发 msz:open-home
 *   让 App 切回学习首页；调用方可拿返回的 doc 自行挂「查看教程导图」。
 * 文档创建全局去重；落地动作按各调用方自己的 to 分发，并发时后到者的目标不会被忽略。
 */
export function openLatestTutorial(options: { to?: 'home' | 'editor' } = {}): Promise<DocData> {
  const to = options.to ?? 'editor'
  const cached = openPromises.get(to)
  if (cached) return cached
  if (!creatingPromise) creatingPromise = getOrCreateLatestTutorial().finally(() => { creatingPromise = null })
  const open: Promise<DocData> = creatingPromise.then((doc) => {
    useDoc.getState().openDoc(doc)
    emitDocsChanged()
    if (to === 'home') {
      window.dispatchEvent(new Event('msz:open-home'))
    } else {
      useSettings.getState().setView('mind')
      requestAnimationFrame(() => window.dispatchEvent(new Event('msz:fit')))
    }
    return doc
  }).finally(() => { if (openPromises.get(to) === open) openPromises.delete(to) })
  openPromises.set(to, open)
  return open
}

export function requestLatestTutorial(to: 'home' | 'editor' = 'editor'): void {
  void openLatestTutorial({ to }).catch(() => window.alert('使用教程未能打开。请检查浏览器是否允许本地存储，再点击「使用教程」重试；现有文档不会被替换。'))
}
