import { create } from 'zustand'
import type { DocData, LayoutKind, MindNodeData, TaskData } from '../types'
import { wouldCreateCycle } from '../lib/gantt'
import { clampRange } from '../lib/date'

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
}

interface DocState {
  doc: DocData
  selection: string[]
  editing: Editing | null
  clipboard: Clip | null
  past: Snap[]
  future: Snap[]

  loadDoc: (d: DocData) => void
  setTitle: (t: string) => void
  setLayout: (k: LayoutKind) => void

  addChild: (parentId: string, source?: 'canvas' | 'outline') => string
  addSibling: (id: string, source?: 'canvas' | 'outline') => void
  removeNodes: (ids: string[]) => void
  setText: (id: string, text: string) => void
  setNode: (id: string, patch: Partial<MindNodeData>) => void
  toggleCollapse: (id: string) => void
  reparent: (id: string, targetId: string) => void
  moveOrder: (id: string, dir: -1 | 1) => void

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
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

function snap(doc: DocData): Snap {
  return { nodes: doc.nodes, rootId: doc.rootId, title: doc.title }
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
  /** 通用更新：先打快照（commit=false 时不打，用于连续文本输入） */
  const upd = (
    nodes: Record<string, MindNodeData>,
    extra: Partial<DocState> = {},
    opts: { commit?: boolean } = {},
  ) => {
    set((s) => ({
      past: opts.commit === false ? s.past : [...s.past.slice(-199), snap(s.doc)],
      // commit:false＝连续文本输入：保留 redo 链（beginEdit 已在编辑开始时清 future），
      // 修 F-7：撤销后直接输入不再误丢 future
      future: opts.commit === false ? s.future : [],
      doc: { ...s.doc, nodes, updatedAt: Date.now() },
      ...extra,
    }))
  }

  return {
    doc: { version: 1, id: '', title: '', rootId: '', layout: 'logic', nodes: {}, createdAt: 0, updatedAt: 0 },
    selection: [],
    editing: null,
    clipboard: null,
    past: [],
    future: [],

    loadDoc: (d) => set({ doc: d, selection: [], editing: null, past: [], future: [] }),

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
      const nodes = { ...s.doc.nodes }
      const parents = new Set(
        [...kill].map((i) => nodes[i]?.parent).filter((p): p is string => !!p && !kill.has(p)),
      )
      for (const p of parents) {
        const pn = nodes[p]
        if (pn) nodes[p] = { ...pn, children: pn.children.filter((c) => !kill.has(c)) }
      }
      for (const k of kill) delete nodes[k]
      upd(nodes, { selection: [], editing: null })
    },

    setText: (id, text) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n) return
      upd({ ...s.doc.nodes, [id]: { ...n, text } }, {}, { commit: false })
    },

    setNode: (id, patch) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n) return
      upd({ ...s.doc.nodes, [id]: { ...n, ...patch } })
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

    setTask: (id, patch, commit = true) => {
      const s = get()
      const n = s.doc.nodes[id]
      if (!n) return
      const cur: TaskData = n.task ?? {}
      let next: TaskData = { ...cur, ...patch }
      // 里程碑只保留开始日；普通任务规范化日期区间
      if (next.milestone) {
        next = { milestone: true, start: next.start ?? cur.start, progress: next.progress, deps: next.deps }
      } else if (next.start || next.end) {
        const r = clampRange(next.start ?? cur.start, next.end ?? cur.end)
        if (r) {
          next.start = r.start
          next.end = r.end
        }
      }
      next.progress = next.progress === undefined ? undefined : Math.min(1, Math.max(0, next.progress))
      const empty = !next.start && !next.milestone
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
      const t = n?.task
      if (!t?.deps) return
      upd({ ...s.doc.nodes, [to]: { ...n!, task: { ...t, deps: t.deps.filter((d) => d.from !== from) } } })
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
        nodes[idMap.get(oldId)!] = {
          ...n,
          id: idMap.get(oldId)!,
          parent: n.parent && idMap.has(n.parent) ? idMap.get(n.parent)! : null,
          children: n.children.map((c) => idMap.get(c)).filter((c): c is string => !!c),
        }
      }
      const t = nodes[target]
      const newRoots = clip.roots.map((r) => idMap.get(r)!)
      nodes[target] = { ...t, children: [...t.children, ...newRoots], collapsed: false }
      for (const r of newRoots) nodes[r] = { ...nodes[r], parent: target }
      upd(nodes, { selection: newRoots, editing: null })
    },

    select: (ids, additive) =>
      set((s) => ({ selection: additive ? [...new Set([...s.selection, ...ids])] : ids })),
    clearSel: () => set({ selection: [] }),
    setEditing: (e) => set({ editing: e }),

    beginEdit: () =>
      set((s) => ({ past: [...s.past.slice(-199), snap(s.doc)], future: [] })),

    undo: () =>
      set((s) => {
        const p = s.past[s.past.length - 1]
        if (!p) return {}
        return {
          past: s.past.slice(0, -1),
          future: [...s.future, snap(s.doc)],
          doc: { ...s.doc, nodes: p.nodes, rootId: p.rootId, title: p.title, updatedAt: Date.now() },
          selection: [],
          editing: null,
        }
      }),

    redo: () =>
      set((s) => {
        const f = s.future[s.future.length - 1]
        if (!f) return {}
        return {
          future: s.future.slice(0, -1),
          past: [...s.past, snap(s.doc)],
          doc: { ...s.doc, nodes: f.nodes, rootId: f.rootId, title: f.title, updatedAt: Date.now() },
          selection: [],
          editing: null,
        }
      }),
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
