import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocData } from '../types'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { worldHolder } from '../store/refs'
import { computeLayout, type LaidEdge, type LaidNode } from '../lib/layout'
import { getTheme, FONT_HAND, FONT_BODY, type Theme } from '../lib/theme'
import { cubicPts, hashSeed, roundedRectPts, sketchPath } from '../lib/sketch'
import { buildSlides, presentDoc } from '../lib/presentation'

const JT = [0, 1.4, 2.6]
const PS = [1, 2, 2]

interface View {
  tx: number
  ty: number
  k: number
}

interface DragState {
  subs: Set<string>
  dx: number
  dy: number
}

function collectSubIds(nodes: DocData['nodes'], id: string, out: Set<string>) {
  out.add(id)
  for (const c of nodes[id]?.children ?? []) collectSubIds(nodes, c, out)
}

/* ---------------- Edge ---------------- */

interface EdgeProps {
  e: LaidEdge
  theme: Theme
  sketch: 0 | 1 | 2
  trans: boolean
  dx: number
  dy: number
}

const EdgeView = memo(function EdgeView({ e, theme, sketch, trans, dx, dy }: EdgeProps) {
  const d = useMemo(() => {
    const p = e.points
    const pts = cubicPts(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7])
    return sketchPath(pts, { seed: hashSeed(e.from + '>' + e.to), jitter: JT[sketch], passes: PS[sketch] })
  }, [e, sketch])
  const colorHex = e.color
    ? theme.branch[Number(e.color.slice(1))] ?? theme.ink
    : e.level <= 1
      ? theme.ink
      : theme.inkSoft
  return (
    <path
      className="msz-edge-in"
      d={d}
      transform={trans ? `translate(${dx},${dy})` : undefined}
      fill="none"
      stroke={colorHex}
      strokeWidth={e.level === 1 ? 2.2 : 1.5}
      strokeLinecap="round"
      opacity={e.level <= 1 ? 0.9 : 0.75}
    />
  )
})

/* ---------------- Node ---------------- */

interface NodeProps {
  n: LaidNode
  text: string
  note: string | undefined
  theme: Theme
  sketch: 0 | 1 | 2
  selected: boolean
  match: boolean
  hovered: boolean
  dx: number
  dy: number
  focusable: boolean
  onDown: (id: string, e: React.PointerEvent) => void
  onEdit: (id: string) => void
}

const NodeView = memo(function NodeView({
  n, text, note, theme, sketch, selected, match, hovered, dx, dy, focusable, onDown, onEdit,
}: NodeProps) {
  const seed = hashSeed(n.id)
  const d = useMemo(
    () =>
      sketchPath(roundedRectPts(n.x, n.y, n.w, n.h, n.level === 0 ? 14 : 9), {
        seed,
        jitter: JT[sketch],
        passes: PS[sketch],
      }) + 'Z',
    [n.x, n.y, n.w, n.h, n.level, seed, sketch],
  )
  const colorHex = n.color ? theme.branch[Number(n.color.slice(1))] ?? theme.ink : theme.ink
  const fill = n.level === 0 ? theme.rootFill : match ? theme.searchFill : theme.nodeFill
  const stroke = n.level === 0 ? theme.accent : n.level === 1 ? colorHex : theme.inkSoft
  const sw = n.level === 0 ? 2.6 : n.level === 1 ? 2.2 : 1.5
  const inSub = dx !== 0 || dy !== 0
  const badgeX = n.side === 1 ? n.x + n.w + 11 : n.x - 11
  return (
    <g
      transform={inSub ? `translate(${dx},${dy})` : undefined}
      style={{ cursor: 'grab' }}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={
        n.hasChildren
          ? `${text || '未命名'}，${n.collapsed ? `已折叠，含 ${n.hidden} 个后代` : '已展开'}`
          : text || '未命名'
      }
      aria-expanded={n.hasChildren ? !n.collapsed : undefined}
      onPointerDown={(e) => onDown(n.id, e)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEdit(n.id)
      }}
    >
      <g className="msz-node-in">
        <path d={d} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
        {selected && (
          <rect
            x={n.x - 4.5} y={n.y - 4.5} width={n.w + 9} height={n.h + 9} rx={n.level === 0 ? 16 : 11}
            fill="none" stroke={theme.selStroke} strokeWidth={1.6} strokeDasharray="5 4" opacity={0.9}
          />
        )}
        {hovered && (
          <rect
            x={n.x - 6} y={n.y - 6} width={n.w + 12} height={n.h + 12} rx={14}
            fill="none" stroke={theme.hoverStroke} strokeWidth={2.2} strokeDasharray="8 5"
          />
        )}
        <text
          x={n.x + 13} y={n.y + n.h / 2} dominantBaseline="central"
          fontSize={n.fontSize}
          fontFamily={n.level === 0 ? FONT_HAND : FONT_BODY}
          fill={n.level === 0 ? theme.rootText : theme.ink}
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {text || ' '}
        </text>
        {note && (
          <text
            x={n.x + n.w - 12} y={n.y + n.h / 2} dominantBaseline="central" textAnchor="end"
            fontSize={11} fill={n.level === 0 ? theme.rootText : theme.inkSoft} style={{ pointerEvents: 'none' }}
          >
            ✎
          </text>
        )}
        {n.hasChildren && n.collapsed && (
          <g
            transform={`translate(${badgeX},${n.y + n.h / 2})`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              useDoc.getState().toggleCollapse(n.id)
            }}
          >
            <circle r={10} fill={theme.nodeFill} stroke={colorHex} strokeWidth={1.5} strokeDasharray="3 2" />
            <text textAnchor="middle" dominantBaseline="central" fontSize={9.5} fill={theme.ink} style={{ pointerEvents: 'none' }}>
              {n.hidden > 99 ? '99+' : n.hidden}
            </text>
          </g>
        )}
      </g>
    </g>
  )
})

/* ---------------- Canvas ---------------- */

export default function Canvas({ query }: { query: string }) {
  const doc = useDoc((s) => s.doc)
  const selection = useDoc((s) => s.selection)
  const editing = useDoc((s) => s.editing)
  const dark = useSettings((s) => s.dark)
  const sketch = useSettings((s) => s.sketch)
  const presenting = useSettings((s) => s.presenting)
  const slide = useSettings((s) => s.slide)
  const reduceMotion = useSettings((s) => s.reduceMotion)
  const theme = getTheme(dark)

  const wrapRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const [view, setView] = useState<View>({ tx: 80, ty: 80, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const hoverRef = useRef<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  /* 组件存活标记：拖拽进行中若切视图/卸载，命令式 window 监听据此自我清理（修 F-8） */
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  const matches = useMemo(() => {
    const set = new Set<string>()
    const q = query.trim()
    if (!q) return set
    for (const n of Object.values(doc.nodes)) if (n.text.includes(q)) set.add(n.id)
    return set
  }, [doc, query])

  /* 搜索时临时展开含命中后代的折叠节点（仅视图，不改状态） */
  const viewDoc = useMemo(() => {
    if (!matches.size) return doc
    const nodes = doc.nodes
    const needOpen = new Set<string>()
    for (const id of matches) {
      let p = nodes[id]?.parent ?? null
      while (p) {
        if (nodes[p]?.collapsed) needOpen.add(p)
        p = nodes[p]?.parent ?? null
      }
    }
    if (!needOpen.size) return doc
    const next = { ...doc, nodes: { ...nodes } }
    for (const id of needOpen) next.nodes[id] = { ...nodes[id], collapsed: false }
    return next
  }, [doc, matches])

  /* 演示模式：派生裁剪文档，绝不可写回 store。
   * 优先级（L-5）：presenting → presentDoc 裁剪；否则 viewDoc（搜索临时展开）。
   * msz:fit 等基于 layoutRef 的操作作用于此 renderDoc，与 store.doc 区分。 */
  const slides = useMemo(() => buildSlides(doc), [doc])
  const renderDoc = useMemo(
    () => (presenting ? presentDoc(doc, Math.min(slide, slides.length - 1)) : viewDoc),
    [presenting, doc, slide, slides.length, viewDoc],
  )

  const layoutRes = useMemo(() => computeLayout(renderDoc), [renderDoc])
  const layoutRef = useRef(layoutRes)
  layoutRef.current = layoutRes

  useEffect(() => {
    worldHolder.current = worldRef.current
  })

  /* 缩放（以光标为中心） */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (useSettings.getState().presenting) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView((v) => {
        const k = Math.min(3, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0012)))
        const s = k / v.k
        return { k, tx: mx - (mx - v.tx) * s, ty: my - (my - v.ty) * s }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const fitView = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const b = layoutRef.current.bounds
    const cw = el.clientWidth
    const ch = el.clientHeight
    if (b.w <= 0 || b.h <= 0) return
    const k = Math.min(1.2, Math.max(0.15, Math.min((cw - 80) / b.w, (ch - 80) / b.h)))
    setView({
      k,
      tx: (cw - b.w * k) / 2 - b.x * k,
      ty: (ch - b.h * k) / 2 - b.y * k,
    })
  }, [])

  useEffect(() => {
    fitView()
  }, [doc.id, fitView])

  useEffect(() => {
    const h = () => fitView()
    window.addEventListener('msz:fit', h)
    return () => window.removeEventListener('msz:fit', h)
  }, [fitView])

  /* 演示模式：每页把「已揭示内容」整体居中适配（rAF 等 layoutRef 刷新） */
  useEffect(() => {
    if (!presenting) return
    const raf = requestAnimationFrame(() => {
      const el = wrapRef.current
      const b = layoutRef.current.bounds
      if (!el || b.w <= 0 || b.h <= 0) return
      const cw = el.clientWidth
      const ch = el.clientHeight
      const k = Math.min(1.4, Math.max(0.3, Math.min((cw - 220) / b.w, (ch - 240) / b.h)))
      setView({
        k,
        tx: (cw - b.w * k) / 2 - b.x * k,
        ty: (ch - b.h * k) / 2 - b.y * k - 8,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [presenting, slide])

  /* 搜索跳转：居中指定节点 */
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      const n = layoutRef.current.nodes.get(id)
      const el = wrapRef.current
      if (!n || !el) return
      setView((v) => ({
        k: v.k,
        tx: el.clientWidth / 2 - (n.x + n.w / 2) * v.k,
        ty: el.clientHeight / 2 - (n.y + n.h / 2) * v.k,
      }))
    }
    window.addEventListener('msz:center', h)
    return () => window.removeEventListener('msz:center', h)
  }, [])

  const toWorld = useCallback((cx: number, cy: number): [number, number] => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return [(cx - rect.left - v.tx) / v.k, (cy - rect.top - v.ty) / v.k]
  }, [])

  /* 平移 */
  const startPan = useCallback((e: React.PointerEvent) => {
    if (useSettings.getState().presenting) return
    const target = e.target as Element
    if (!target.hasAttribute('data-bg') && e.button !== 1) return
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const v0 = viewRef.current
    const onMove = (ev: PointerEvent) => {
      // 修 F-8：组件已卸载则自我清理，不再 setState
      if (!aliveRef.current) {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        return
      }
      setView({ ...v0, tx: v0.tx + ev.clientX - sx, ty: v0.ty + ev.clientY - sy })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const beginEditAt = useCallback((id: string) => {
    const s = useDoc.getState()
    s.beginEdit()
    s.setEditing({ id, source: 'canvas' })
  }, [])

  /* 节点拖拽换父 + 点击选择/进入编辑 */
  const onNodeDown = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      if (useSettings.getState().presenting) return
      // 修 F-6：区分 additive（shift/ctrl/meta）选择，抬起时不进入编辑
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      const st = useDoc.getState()
      if (additive) st.select([id], true)
      else if (!st.selection.includes(id)) st.select([id])

      const subs = new Set<string>()
      collectSubIds(st.doc.nodes, id, subs)
      const sx = e.clientX
      const sy = e.clientY
      let moved = false
      let dx = 0
      let dy = 0

      const onMove = (ev: PointerEvent) => {
        // 修 F-8：卸载后自我清理
        if (!aliveRef.current) {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          return
        }
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) moved = true
        if (!moved) return
        const k = viewRef.current.k
        dx = (ev.clientX - sx) / k
        dy = (ev.clientY - sy) / k
        setDrag({ subs, dx, dy })
        const [wx, wy] = toWorld(ev.clientX, ev.clientY)
        let best: string | null = null
        let bestArea = Infinity
        for (const n of layoutRef.current.nodes.values()) {
          if (subs.has(n.id)) continue
          if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
            const area = n.w * n.h
            if (area < bestArea) {
              bestArea = area
              best = n.id
            }
          }
        }
        hoverRef.current = best
        setHover(best)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        // 关键：先取命中目标再清空（旧代码先置 null 后读取，reparent 永不触发）
        const target = hoverRef.current
        setDrag(null)
        setHover(null)
        hoverRef.current = null
        if (moved) {
          if (target) useDoc.getState().reparent(id, target)
        } else if (!additive) {
          // 修 F-6：additive 选择不进入编辑
          const s2 = useDoc.getState()
          if (s2.selection.length === 1 && s2.selection[0] === id) beginEditAt(id)
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [beginEditAt, toWorld],
  )

  /* 文本编辑浮层 */
  const [editVal, setEditVal] = useState('')
  useEffect(() => {
    if (editing && editing.source === 'canvas') {
      setEditVal(useDoc.getState().doc.nodes[editing.id]?.text ?? '')
    }
  }, [editing])
  const commitEdit = useCallback(
    (cancel = false) => {
      if (!editing) return
      const s = useDoc.getState()
      if (!cancel) s.setText(editing.id, editVal.replace(/\n+/g, ' '))
      s.setEditing(null)
    },
    [editing, editVal],
  )

  const editingNode = editing && editing.source === 'canvas' ? layoutRes.nodes.get(editing.id) : null
  const sub = drag?.subs

  return (
    <div className={'canvas-wrap' + (presenting ? ' presenting' : '')} ref={wrapRef}>
      <svg
        className="canvas-svg"
        role="application"
        aria-label={presenting ? '演示中的思维导图' : '思维导图画布'}
        onPointerDown={startPan}
      >
        <defs>
          <pattern id="msz-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M 28 0 L 0 0 0 28" fill="none" stroke={theme.grid} strokeWidth="1" />
          </pattern>
        </defs>
        <g
          transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}
          style={presenting && !reduceMotion ? { transition: 'transform 0.28s ease' } : undefined}
        >
          <rect data-bg="1" x={-50000} y={-50000} width={100000} height={100000} fill={`url(#msz-grid)`} />
          <g id="world" ref={worldRef}>
            {layoutRes.edges.map((e) => (
              <EdgeView
                key={e.from + '>' + e.to}
                e={e}
                theme={theme}
                sketch={sketch}
                trans={!!sub?.has(e.to)}
                dx={drag?.dx ?? 0}
                dy={drag?.dy ?? 0}
              />
            ))}
            {[...layoutRes.nodes.values()].map((n) => (
              <NodeView
                key={n.id}
                n={n}
                text={doc.nodes[n.id]?.text ?? ''}
                note={doc.nodes[n.id]?.note}
                theme={theme}
                sketch={sketch}
                selected={selection.includes(n.id)}
                match={presenting ? false : matches.has(n.id)}
                hovered={hover === n.id}
                dx={sub?.has(n.id) ? drag!.dx : 0}
                dy={sub?.has(n.id) ? drag!.dy : 0}
                focusable={!presenting && selection.includes(n.id)}
                onDown={onNodeDown}
                onEdit={beginEditAt}
              />
            ))}
          </g>
        </g>
      </svg>
      <div className="paper-noise" aria-hidden="true" />
      {editingNode && (
        <textarea
          className="node-editor"
          autoFocus
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={() => commitEdit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              commitEdit(true)
            }
          }}
          style={{
            left: editingNode.x * view.k + view.tx,
            top: editingNode.y * view.k + view.ty,
            width: Math.max(80, editingNode.w * view.k),
            height: Math.max(30, editingNode.h * view.k),
            fontSize: editingNode.fontSize * view.k,
            color: theme.ink,
            background: theme.nodeFill,
            borderColor: theme.selStroke,
            zIndex: 5,
          }}
        />
      )}
    </div>
  )
}
