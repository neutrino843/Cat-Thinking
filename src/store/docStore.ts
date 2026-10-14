import { create } from 'zustand'
import type { BoundaryBox, DocData, LayoutKind, MindNodeData, NodeTag, Relation, Summary, TaskData } from '../types'
import { wouldCreateCycle } from '../lib/gantt'
import { clampRange } from '../lib/date'
import { revokeAllBlobURLs, revokeBlobURL } from '../lib/blobUrl'
import { emptyFilter, type NodeFilter } from '../lib/filter'

/**
 * M11（PRD 4.4 P1）：多文档标签页会话。
 * 当前活动文档的 past/future/clipboard 仍是顶层 state（全部既有动作零改动）；
 * 非活动标签的历史栈存于 sessions，切换时换入/换出，实现每文档独立的
 * 撤销重做与剪贴板。
 */
interface Session {
  /** 切走时的活动文档快照（含未落盘编辑；切回时优先于 IndexedDB 副本） */
  doc: DocData
  past: Snap[]
  future: Snap[]
  clipboard: Clip | null
}

/** 已打开标签 id 列表（持久化于 localStorage，重开浏览器恢复标签条） */
const TABS_KEY = 'msz.openTabs'

function saveTabs(tabs: string[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

export function loadSavedTabs(): string[] {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 工作区无文档时的占位（初始态 / 活动标签关闭到载入新文档之间的瞬态） */
export const EMPTY_DOC: DocData = {
  version: 3,
  id: '',
  title: '',
  rootId: '',
  layout: 'logic',
  nodes: {},
  createdAt: 0,
  updatedAt: 0,
}

export interface Clip {
  nodes: Record<string, MindNodeData>
  roots: string[]
}

export interface Editing {
  id: string
  source: 'canvas' | 'outline'
}

interface Snap {
  nodes: Record<string, MindNodeData>
  rootId: string
  title: string
  /** M9：关系表达快照（撤销重做覆盖） */
  relations?: Relation[]
  summaries?: Summary[]
  boundaryBoxes?: BoundaryBox[]
}

interface DocState {
  doc: DocData
  selection: string[]
  editing: Editing | null
  clipboard: Clip | null
  past: Snap[]
  future: Snap[]

  /* ---- M11 多文档标签页 ---- */
  /** 已打开标签的 docId（有序、唯一） */
  tabs: string[]
  /** 非活动标签的会话（撤销/重做栈 + 剪贴板），按 docId 存 */
  sessions: Record<string, Session>
  /**
   * 打开/切换到文档（标签页）：自动暂存旧会话、换入目标会话、重置过滤。
   * opts.tabs 仅初始化恢复时使用（一次性注入完整标签列表）。
   */
  openDoc: (d: DocData, opts?: { tabs?: string[] }) => void
  /**
   * 摘除一个标签及其会话。关闭的是非活动标签时工作区不变；
   * 关闭的是活动标签时清空工作区，调用方须紧接着 openDoc 邻居/新建文档。
   */
  closeTab: (id: string) => void

  /* ---- M11 过滤（PRD 4.1.7 P1，视图态，切文档自动重置）---- */
  filter: NodeFilter
  setFilter: (patch: Partial<NodeFilter>) => void
  clearFilter: () => void

  /* ---- M11 批量操作（PRD 4.4 P1，单次撤销快照）---- */
  batchUpdate: (ids: string[], apply: (n: MindNodeData) => MindNodeData) => void
  /** 批量改分支配色；color 为 'b0'..'b5'，'' 表示清除自定义色（恢复轮转默认） */
  batchColor: (ids: string[], color: string) => void
  /** 批量加标签（按文本去重：同文本已存在的节点不重复添加） */
  batchAddTag: (ids: string[], text: string, color: string) => void

  loadDoc: (d: DocData) => void
  setTitle: (t: string) => void
  setLayout: (k: LayoutKind) => void

  addChild: (parentId: string, source?: 'canvas' | 'outline') => string
  addSibling: (id: string, source?: 'canvas' | 'outline') => void
  removeNodes: (ids: string[]) => void
  setText: (id: string, text: string) => void
  setNode: (id: string, patch: Partial<MindNodeData>, commit?: boolean) => void
  toggleCollapse: (id: string) => void
  reparent: (id: string, targetId: string) => void
  moveOrder: (id: string, dir: -1 | 1) => void
  /**
   * M12：将节点 id 移到 targetParent 的第 index 个孩子位置。
   * - targetParent 可为 null：仅在同父内排序时使用（不换父）；
   * - 不允许把节点移到自己后代下；根节点不可移动；
   * - index 越界时 clamp 到 [0, targetParent.children.length]。
   */
  reparentAt: (id: string, targetParent: string | null, index: number) => void

  setTask: (id: string, patch: Partial<TaskData>, commit?: boolean) => void
  addDep: (from: string, to: string) => boolean
  removeDep: (from: string, to: string) => void
  clearTask: (id: string) => void

  copySel: () => void
  paste: (targetId?: string) => void

  select: (ids: string[], additive?: boolean) => void
  clearSel: () => void
  setEditing: (e: Editing | null) => void
  /** 文本编辑开始时打一次历史快照（文本输入期间不再打快照） */
  beginEdit: () => void

  undo: () => void
  redo: () => void

  /* ---- M9 关系表达（PRD 4.1.5 P1）---- */
  /** 在两节点间添加关系线；from===to 或任一节点不存在则拒绝 */
  addRelation: (from: string, to: string, label?: string) => string
  /** 更新关系线文字/颜色（patch 合并） */
  updateRelation: (id: string, patch: Partial<Pick<Relation, 'label' | 'color'>>) => void
  removeRelation: (id: string) => void

  /** 框选兄弟组创建概要 */
  addSummary: (members: string[], label?: string) => string
  updateSummary: (id: string, patch: Partial<Pick<Summary, 'label' | 'color' | 'members'>>) => void
  removeSummary: (id: string) => void

  /** 框选任意节点创建边界框 */
  addBoundaryBox: (members: string[], label?: string) => string
  updateBoundaryBox: (id: string, patch: Partial<Pick<BoundaryBox, 'label' | 'color' | 'members'>>) => void
  removeBoundaryBox: (id: string) => void
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

function snap(doc: DocData): Snap {
  return {
    nodes: doc.nodes,
    rootId: doc.rootId,
    title: doc.title,
    relations: doc.relations,
    summaries: doc.summaries,
    boundaryBoxes: doc.boundaryBoxes,
  }
}

function collectSub(nodes: DocData['nodes'], id: string, out: string[] = []): string[] {
  out.push(id)
  for (const c of nodes[id]?.children ?? []) collectSub(nodes, c, out)
  return out
}

function isDescendant(nodes: DocData['nodes'], maybeChild: string, ancestor: string): boolean {
  let cur = nodes[maybeChild]?.parent ?? null
  while (cur) {
    if (cur === ancestor) return true
    cur = nodes[cur]?.parent ?? null
  }
  return false
}

export const useDoc = create<DocState>((set, get) => {
  /**
   * M8-P1（P-1）：文本输入草稿表。
   * 旧实现 setText 每次按键都整表浅拷贝 nodes（O(n)，千节点卡顿）。改为每个编辑会话
   * 惰性建立一张草稿表：首键 O(n) 复制一次表、此后每键只替换被编辑节点引用（O(1)）；
   * 未编辑节点引用跨按键保持不变（结构共享），为渲染层按节点 memo 跳过提供前提。
   * 草稿表是历史快照的「分叉」：beginEdit 推入的快照仍指向旧表，撤销语义不受影响。
   */
  let draftNodes: Record<string, MindNodeData> | null = null
  let draftId: string | null = null
  const dropDraft = () => {
    draftNodes = null
    draftId = null
  }

  /** 通用更新：先打快照（commit=false 时不打，用于连续文本输入/甘特拖拽） */
  const upd = (
    nodes: Record<string, MindNodeData>,
    extra: Partial<DocState> = {},
    opts: { commit?: boolean } = {},
  ) => {
    // 任何走 upd 的变更都携带全新构建的表，文本草稿必然已分叉失效
    dropDraft()
    set((s) => ({
      past: opts.commit === false ? s.past : [...s.past.slice(-199), snap(s.doc)],
      // commit:false＝连续拖拽输入：保留 redo 链（beginEdit 已在编辑开始时清 future），
      // 修 F-7：撤销后直接输入不再误丢 future
      future: opts.commit === false ? s.future : [],
      doc: { ...s.doc, nodes, updatedAt: Date.now() },
      ...extra,
    }))
  }

  /**
   * M9：关系表达更新（关系线/概要/边界框）。
   * 与 upd 同快照语义（push past、清 future），但只改 doc 级 overlay 数组。
   */
  const setOverlay = (
    patch: Partial<Pick<DocData, 'relations' | 'summaries' | 'boundaryBoxes'>>,
  ) => {
    dropDraft()
    set((s) => ({
      past: [...s.past.slice(-199), snap(s.doc)],
      future: [],
      doc: { ...s.doc, ...patch, updatedAt: Date.now() },
    }))
  }

  return {
    doc: EMPTY_DOC,
    selection: [],
    editing: null,
    clipboard: null,
    past: [],
    future: [],

    /* M11 标签页 */
    tabs: [],
    sessions: {},

    openDoc: (d, opts) => {
      const s = get()
      // 已是当前活动文档：仅确保标签存在，不重建会话
      if (s.doc.id === d.id) {
        if (!s.tabs.includes(d.id)) {
          const tabs = [...s.tabs, d.id]
          saveTabs(tabs)
          set({ tabs })
        }
        return
      }
      revokeAllBlobURLs()
      dropDraft()
      // 暂存旧活动会话（连同活动文档，保住未落盘编辑）；换入目标会话
      const sessions = { ...s.sessions }
      if (s.doc.id) {
        sessions[s.doc.id] = { doc: s.doc, past: s.past, future: s.future, clipboard: s.clipboard }
      }
      const sess = sessions[d.id]
      delete sessions[d.id]
      const tabs = opts?.tabs ?? (s.tabs.includes(d.id) ? s.tabs : [...s.tabs, d.id])
      saveTabs(tabs)
      set({
        // 会话中的文档是最近活副本（可能含防抖窗口内未落盘编辑），优先于传入的库副本
        doc: sess?.doc ?? d,
        selection: [],
        editing: null,
        past: sess?.past ?? [],
        future: sess?.future ?? [],
        clipboard: sess?.clipboard ?? null,
        sessions,
        tabs,
        filter: emptyFilter,
      })
    },

    closeTab: (id) => {
      const s = get()
      const tabs = s.tabs.filter((t) => t !== id)
      saveTabs(tabs)
      const sessions = { ...s.sessions }
      delete sessions[id]
      if (s.doc.id !== id) {
        // 关闭后台标签：工作区不动（其会话只存在于 sessions 中）
        set({ tabs, sessions })
        return
      }
      // 关闭活动标签：清空工作区；异步邻居加载由调用方（lib/tabs）紧接着完成
      revokeAllBlobURLs()
      dropDraft()
      set({
        doc: EMPTY_DOC,
        tabs,
        sessions,
        selection: [],
        editing: null,
        past: [],
        future: [],
        clipboard: null,
        filter: emptyFilter,
      })
    },

    filter: emptyFilter,
    setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
    clearFilter: () => set({ filter: emptyFilter }),

    batchUpdate: (ids, apply) => {
      const s = get()
      const valid = ids.filter((id) => !!s.doc.nodes[id])
      if (!valid.length) return
      const nodes = { ...s.doc.nodes }
      for (const id of valid) nodes[id] = apply(nodes[id])
      upd(nodes)
    },

    batchColor: (ids, color) =>
      get().batchUpdate(ids, (n) => ({ ...n, color: color || undefined })),

    batchAddTag: (ids, text, color) => {
      const t = text.trim()
      if (!t) return
      get().batchUpdate(ids, (n) => {
        if ((n.tags ?? []).some((tag) => tag.text === t)) return n
        const tag: NodeTag = { id: uid(), text: t, color }
        return { ...n, tags: [...(n.tags ?? []), tag] }
      })
    },

    loadDoc: (d) => {
      revokeAllBlobURLs()
      dropDraft()
      set({ doc: d, selection: [], editing: null, past: [], future: [], filter: emptyFilter })
    },

    setTitle: (t) =>
      set((s) => ({ doc: { ...s.doc, title: t, updatedAt: Date.now() } })),

    setLayout: (k) =>
      set((s) => ({ doc: { ...s.doc, layout: k, updatedAt: Date.now() } })),

    addChild: (parentId, source = 'canvas') => {
      const s = get()
      const p = s.doc.nodes[parentId]
      if (!p) return ''
      const id = uid()
      const node: MindNodeData = { id, parent: parentId, children: [], text: '' }
      const nodes = {
        ...s.doc.nodes,
        [id]: node,
        [parentId]: { ...p, children: [...p.children, id], collapsed: false },
      }
      upd(nodes, { selection: [id], editing: { id, source } })
      return id
    },

    addSibling: (id, source = 'canvas') => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n || !n.parent) return
      const p = s.doc.nodes[n.parent]
      if (!p) return
      const nid = uid()
      const idx = p.children.indexOf(id) + 1
      const children = [...p.children]
      children.splice(idx, 0, nid)
      const nodes = {
        ...s.doc.nodes,
        [nid]: { id: nid, parent: p.id, children: [], text: '' },
        [p.id]: { ...p, children },
      }
      upd(nodes, { selection: [nid], editing: { id: nid, source } })
    },

    removeNodes: (ids) => {
      const s = get()
      const kill = new Set<string>()
      for (const id of ids) {
        if (id === s.doc.rootId || !s.doc.nodes[id]) continue
        collectSub(s.doc.nodes, id).forEach((x) => kill.add(x))
      }
      if (!kill.size) return
      // M7-P3：收集被删除节点的 blobId（基于删除前快照），删除后释放其 objectURL 缓存。
      // 注意：blob 本体保留于 IndexedDB 以支持撤销恢复。
      const revokeIds: string[] = []
      for (const id of kill) {
        const kn = s.doc.nodes[id]
        if (!kn) continue
        if (kn.images) for (const im of kn.images) revokeIds.push(im.blobId)
        if (kn.attachments) for (const at of kn.attachments) revokeIds.push(at.blobId)
      }
      const nodes = { ...s.doc.nodes }
      const parents = new Set(
        [...kill].map((i) => nodes[i]?.parent).filter((p): p is string => !!p && !kill.has(p)),
      )
      for (const p of parents) {
        const pn = nodes[p]
        if (pn) nodes[p] = { ...pn, children: pn.children.filter((c) => !kill.has(c)) }
      }
      for (const k of kill) delete nodes[k]
      for (const bid of revokeIds) revokeBlobURL(bid)
      // M9：清理被删节点在关系表达中的悬挂引用（孤儿关系线/概要/边界框）
      const overlay: Partial<Pick<DocData, 'relations' | 'summaries' | 'boundaryBoxes'>> = {}
      if (s.doc.relations?.length) {
        const kept = s.doc.relations.filter((r) => !kill.has(r.from) && !kill.has(r.to))
        if (kept.length !== s.doc.relations.length) overlay.relations = kept
      }
      if (s.doc.summaries?.length) {
        const orig = s.doc.summaries
        const kept = orig
          .map((sm) => ({ ...sm, members: sm.members.filter((m) => !kill.has(m)) }))
          .filter((sm) => sm.members.length > 0)
        const changed = kept.length !== orig.length || kept.some((sm, i) => sm.members.length !== orig[i].members.length)
        if (changed) overlay.summaries = kept
      }
      if (s.doc.boundaryBoxes?.length) {
        const orig = s.doc.boundaryBoxes
        const kept = orig
          .map((b) => ({ ...b, members: b.members.filter((m) => !kill.has(m)) }))
          .filter((b) => b.members.length > 0)
        const changed = kept.length !== orig.length || kept.some((b, i) => b.members.length !== orig[i].members.length)
        if (changed) overlay.boundaryBoxes = kept
      }
      upd(nodes, { selection: [], editing: null })
      // 若有 overlay 变更，在 upd 之后立即应用（upd 已打快照含旧 overlay，此处增量更新 doc）
      if (Object.keys(overlay).length) {
        set((st) => ({ doc: { ...st.doc, ...overlay } }))
      }
    },

    setText: (id, text) => {
      const s = get()
      if (!s.doc.nodes[id]) return
      // 草稿失效条件：无草稿 / 切换了编辑节点 / 底层表已被其它动作（undo/load/upd）替换。
      // 命中复用分支时不再 O(n) 整表拷贝，只换一个节点引用。
      if (!draftNodes || draftId !== id || s.doc.nodes !== draftNodes) {
        draftNodes = { ...s.doc.nodes }
        draftId = id
      }
      const nodes = draftNodes
      nodes[id] = { ...nodes[id], text }
      // commit:false 语义：不动 past/future（beginEdit 已打快照）
      set((st) => ({ doc: { ...st.doc, nodes, updatedAt: Date.now() } }))
    },

    setNode: (id, patch, commit = true) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n) return
      upd({ ...s.doc.nodes, [id]: { ...n, ...patch } }, {}, { commit })
    },

    toggleCollapse: (id) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n || !n.children.length) return
      upd({ ...s.doc.nodes, [id]: { ...n, collapsed: !n.collapsed } })
    },

    reparent: (id, targetId) => {
      const s = get()
      const { nodes: N, rootId } = s.doc
      if (id === rootId || id === targetId || !N[id] || !N[targetId]) return
      if (isDescendant(N, targetId, id)) return
      const old = N[id].parent
      const nodes = { ...N }
      if (old && nodes[old]) {
        nodes[old] = { ...nodes[old], children: nodes[old].children.filter((c) => c !== id) }
      }
      const t = nodes[targetId]
      nodes[targetId] = { ...t, children: [...t.children, id], collapsed: false }
      nodes[id] = { ...nodes[id], parent: targetId }
      upd(nodes, { selection: [id], editing: null })
    },

    moveOrder: (id, dir) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n || !n.parent) return
      const p = s.doc.nodes[n.parent]
      const idx = p.children.indexOf(id)
      const to = idx + dir
      if (to < 0 || to >= p.children.length) return
      const children = [...p.children]
      children.splice(idx, 1)
      children.splice(to, 0, id)
      upd({ ...s.doc.nodes, [p.id]: { ...p, children } })
    },

    reparentAt: (id, targetParent, index) => {
      const s = get()
      const { nodes: N, rootId } = s.doc
      if (id === rootId || !N[id]) return
      if (targetParent !== null && !N[targetParent]) return
      // 不允许移到自己后代下（含自身）
      if (targetParent !== null && isDescendant(N, targetParent, id)) return

      const oldParent = N[id].parent
      const nodes = { ...N }
      // 从旧父摘除
      if (oldParent && nodes[oldParent]) {
        const oldChildren = nodes[oldParent].children.filter((c) => c !== id)
        nodes[oldParent] = { ...nodes[oldParent], children: oldChildren }
      }
      // 目标父（null 表示不换父，用旧父）
      const destId = targetParent ?? oldParent
      if (!destId) return
      const dest = nodes[destId]
      const destChildren = dest.children.filter((c) => c !== id)
      const clamped = Math.max(0, Math.min(index, destChildren.length))
      const next = [...destChildren]
      next.splice(clamped, 0, id)
      nodes[destId] = { ...dest, children: next, collapsed: false }
      nodes[id] = { ...nodes[id], parent: destId }
      upd(nodes, { selection: [id], editing: null })
    },

    setTask: (id, patch, commit = true) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n) return
      const cur: TaskData = n.task ?? {}
      let next: TaskData = { ...cur, ...patch }
      // 里程碑只保留开始日；普通任务规范化日期区间
      if (next.milestone) {
        next = {
          milestone: true,
          start: next.start ?? cur.start,
          progress: next.progress,
          deps: next.deps,
          priority: next.priority,
          owner: next.owner,
          note: next.note,
        }
      } else if (next.start || next.end) {
        const r = clampRange(next.start ?? cur.start, next.end ?? cur.end)
        if (r) {
          next.start = r.start
          next.end = r.end
        }
      }
      next.progress = next.progress === undefined ? undefined : Math.min(1, Math.max(0, next.progress))
      const empty = !next.start && !next.milestone && !next.priority && !next.owner && !next.note
      upd(
        { ...s.doc.nodes, [id]: { ...n, ...(empty ? { task: undefined } : { task: next }) } },
        {},
        { commit },
      )
    },

    addDep: (from, to) => {
      const s = get()
      if (!s.doc.nodes[from] || !s.doc.nodes[to]) return false
      if (wouldCreateCycle(s.doc.nodes, from, to)) return false
      const n = s.doc.nodes[to]
      const t: TaskData = n.task ?? { start: undefined }
      const deps = [...(t.deps ?? []), { from, type: 'FS' as const }]
      upd({ ...s.doc.nodes, [to]: { ...n, task: { ...t, deps } } })
      return true
    },

    removeDep: (from, to) => {
      const s = get()
      const n = s.doc.nodes[to]
      const deps = n?.task?.deps
      if (!n?.task || !deps) return
      const t = n.task
      upd({ ...s.doc.nodes, [to]: { ...n, task: { ...t, deps: deps.filter((d) => d.from !== from) } } })
    },

    clearTask: (id) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n?.task) return
      upd({ ...s.doc.nodes, [id]: { ...n, task: undefined } })
    },

    copySel: () => {
      const s = get()
      if (!s.selection.length) return
      // 去掉被其他选中节点祖先包含的节点
      const roots = s.selection.filter(
        (id) => !s.selection.some((other) => other !== id && isDescendant(s.doc.nodes, id, other)),
      )
      const nodes: Record<string, MindNodeData> = {}
      for (const r of roots) collectSub(s.doc.nodes, r).forEach((i) => (nodes[i] = { ...s.doc.nodes[i] }))
      set({ clipboard: { nodes, roots } })
    },

    paste: (targetId) => {
      const s = get()
      const clip = s.clipboard
      if (!clip) return
      const target = targetId ?? s.selection[0] ?? s.doc.rootId
      if (!s.doc.nodes[target]) return
      const idMap = new Map<string, string>()
      for (const oldId of Object.keys(clip.nodes)) idMap.set(oldId, uid())
      const nodes = { ...s.doc.nodes }
      for (const [oldId, n] of Object.entries(clip.nodes)) {
        const id = idMap.get(oldId)
        if (!id) throw new Error(`剪贴板节点 ${oldId} 缺少 ID 映射`)
        nodes[id] = {
          ...n,
          id,
          parent: n.parent ? (idMap.get(n.parent) ?? null) : null,
          children: n.children.map((c) => idMap.get(c)).filter((c): c is string => !!c),
        }
      }
      const t = nodes[target]
      const newRoots = clip.roots
        .map((r) => idMap.get(r))
        .filter((r): r is string => r !== undefined)
      nodes[target] = { ...t, children: [...t.children, ...newRoots], collapsed: false }
      for (const r of newRoots) {
        const root = nodes[r]
        if (root) nodes[r] = { ...root, parent: target }
      }
      upd(nodes, { selection: newRoots, editing: null })
    },

    select: (ids, additive) =>
      set((s) => ({ selection: additive ? [...new Set([...s.selection, ...ids])] : ids })),
    clearSel: () => set({ selection: [] }),
    setEditing: (e) => {
      // 编辑会话结束：草稿不再复用，下次输入重建
      dropDraft()
      set({ editing: e })
    },

    beginEdit: () => {
      // 新的聚焦＝新的编辑会话，旧草稿作废（防跨节点/跨焦点误用）
      dropDraft()
      set((s) => ({ past: [...s.past.slice(-199), snap(s.doc)], future: [] }))
    },

    undo: () => {
      const s = get()
      const p = s.past[s.past.length - 1]
      if (!p) return
      dropDraft()
      set({
        past: s.past.slice(0, -1),
        future: [...s.future, snap(s.doc)],
        doc: {
          ...s.doc,
          nodes: p.nodes,
          rootId: p.rootId,
          title: p.title,
          // M9：关系表达随快照恢复
          relations: p.relations,
          summaries: p.summaries,
          boundaryBoxes: p.boundaryBoxes,
          updatedAt: Date.now(),
        },
        selection: [],
        editing: null,
      })
    },

    redo: () => {
      const s = get()
      const f = s.future[s.future.length - 1]
      if (!f) return
      dropDraft()
      set({
        future: s.future.slice(0, -1),
        past: [...s.past, snap(s.doc)],
        doc: {
          ...s.doc,
          nodes: f.nodes,
          rootId: f.rootId,
          title: f.title,
          relations: f.relations,
          summaries: f.summaries,
          boundaryBoxes: f.boundaryBoxes,
          updatedAt: Date.now(),
        },
        selection: [],
        editing: null,
      })
    },

    /* ---- M9 关系表达（PRD 4.1.5 P1）---- */

    addRelation: (from, to, label) => {
      const s = get()
      if (from === to || !s.doc.nodes[from] || !s.doc.nodes[to]) return ''
      const id = uid()
      const rel: Relation = { id, from, to, ...(label ? { label } : {}) }
      setOverlay({ relations: [...(s.doc.relations ?? []), rel] })
      return id
    },

    updateRelation: (id, patch) => {
      const s = get()
      if (!s.doc.relations) return
      const next = s.doc.relations.map((r) => (r.id === id ? { ...r, ...patch } : r))
      setOverlay({ relations: next })
    },

    removeRelation: (id) => {
      const s = get()
      if (!s.doc.relations) return
      setOverlay({ relations: s.doc.relations.filter((r) => r.id !== id) })
    },

    addSummary: (members, label) => {
      const s = get()
      const valid = members.filter((m) => s.doc.nodes[m])
      if (!valid.length) return ''
      const id = uid()
      const sm: Summary = { id, members: valid, ...(label ? { label } : {}) }
      setOverlay({ summaries: [...(s.doc.summaries ?? []), sm] })
      return id
    },

    updateSummary: (id, patch) => {
      const s = get()
      if (!s.doc.summaries) return
      const next = s.doc.summaries.map((sm) => (sm.id === id ? { ...sm, ...patch } : sm))
      setOverlay({ summaries: next })
    },

    removeSummary: (id) => {
      const s = get()
      if (!s.doc.summaries) return
      setOverlay({ summaries: s.doc.summaries.filter((sm) => sm.id !== id) })
    },

    addBoundaryBox: (members, label) => {
      const s = get()
      const valid = members.filter((m) => s.doc.nodes[m])
      if (!valid.length) return ''
      const id = uid()
      const b: BoundaryBox = { id, members: valid, ...(label ? { label } : {}) }
      setOverlay({ boundaryBoxes: [...(s.doc.boundaryBoxes ?? []), b] })
      return id
    },

    updateBoundaryBox: (id, patch) => {
      const s = get()
      if (!s.doc.boundaryBoxes) return
      const next = s.doc.boundaryBoxes.map((b) => (b.id === id ? { ...b, ...patch } : b))
      setOverlay({ boundaryBoxes: next })
    },

    removeBoundaryBox: (id) => {
      const s = get()
      if (!s.doc.boundaryBoxes) return
      setOverlay({ boundaryBoxes: s.doc.boundaryBoxes.filter((b) => b.id !== id) })
    },
  }
})

/** 选中节点的导航目标（↑↓ 兄弟、← 父、→ 首子） */
export function navigate(nodes: Record<string, MindNodeData>, id: string, dir: 'up' | 'down' | 'left' | 'right'): string | null {
  const n = nodes[id]
  if (!n) return null
  if (dir === 'left') return n.parent
  if (dir === 'right') return n.children[0] ?? null
  if (!n.parent) return null
  const siblings = nodes[n.parent].children
  const i = siblings.indexOf(id)
  const j = dir === 'up' ? i - 1 : i + 1
  return siblings[j] ?? null
}
