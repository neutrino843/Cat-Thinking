/**
 * M11（PRD 4.4 P1）：多文档标签页 UI 编排层。
 * docStore 只做同步会话换入/换出；涉及 IndexedDB 读取、新建落盘、
 * 关闭活动标签后选邻居等异步逻辑统一放这里，供 Tabs/Sidebar/App 复用。
 */
import { loadSavedTabs, useDoc } from '../store/docStore'
import { listDocs, loadDoc, saveDoc } from '../store/db'
import { buildDoc, findTpl } from '../data/templates'

/** 文档列表可能变化（新建/删除/重命名/导入/打开 .msz）时派发，Tabs 监听刷新标题 */
export const DOCS_CHANGED_EVENT = 'msz:docs-changed'

export function emitDocsChanged(): void {
  window.dispatchEvent(new Event(DOCS_CHANGED_EVENT))
}

/** 打开库里的某篇文档（点击侧栏条目/标签条） */
export async function openDocById(id: string): Promise<void> {
  const d = await loadDoc(id)
  if (d) {
    useDoc.getState().openDoc(d)
    emitDocsChanged()
  }
}

/** 新建文档并以新标签打开 */
export async function createDocTab(tplId = 'blank'): Promise<void> {
  const d = buildDoc(findTpl(tplId))
  await saveDoc(d)
  useDoc.getState().openDoc(d)
  emitDocsChanged()
}

/**
 * 关闭标签：
 * - 后台标签：直接摘除，工作区不动；
 * - 活动标签：优先切到右侧邻居（无则左侧），邻居在库中已不存在时兜底新建空白文档。
 */
export async function closeDocTab(id: string): Promise<void> {
  const st = useDoc.getState()
  const wasActive = st.doc.id === id
  // 仅关活动标签时才需要选邻居；后台标签摘除不动工作区
  let neighbor: string | null = null
  if (wasActive) {
    const idx = st.tabs.indexOf(id)
    neighbor = st.tabs[idx + 1] ?? st.tabs[idx - 1] ?? null
  }
  st.closeTab(id)
  if (!wasActive) {
    emitDocsChanged()
    return
  }
  if (neighbor === null) {
    // 关的是最后一个标签：兜底新建空白文档（保持工作区始终有一篇文档）
    await createDocTab('blank')
    return
  }
  const d = await loadDoc(neighbor).catch(() => null)
  if (d) {
    useDoc.getState().openDoc(d)
    emitDocsChanged()
    return
  }
  await createDocTab('blank')
}

/**
 * 启动时恢复标签条：校验已保存 id 仍存在于库，返回有效 id 列表（有序）。
 */
export async function restoreTabIds(): Promise<string[]> {
  const saved = loadSavedTabs()
  if (!saved.length) return []
  const metas = await listDocs().catch(() => [])
  const live = new Set(metas.map((m) => m.id))
  return saved.filter((id) => live.has(id))
}
