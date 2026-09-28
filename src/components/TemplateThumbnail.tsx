import { useMemo } from 'react'
import type { DocData } from '../types'
import { computeLayout, type LaidEdge } from '../lib/layout'
import { getTheme } from '../lib/theme'

/** M7-P5：与 Canvas TAG_COLORS 一致的标签色板（缩略图用，避免跨组件导入） */
const TAG_COLORS: Record<string, string> = {
  red: '#e53935',
  orange: '#fb8c00',
  amber: '#fdd835',
  green: '#43a047',
  teal: '#00897b',
  blue: '#1e88e5',
  violet: '#8e24aa',
  gray: '#9e9e9e',
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * M7-P5：把 8 数字三次贝塞尔 points 退化为两端点直线（缩略图不用抖动曲线）。
 * 取 p[0],p[1] → p[6],p[7]。
 */
function straightD(e: LaidEdge): string {
  const p = e.points
  return `M ${p[0]} ${p[1]} L ${p[6]} ${p[7]}`
}

interface Props {
  doc: DocData
  dark: boolean
  w?: number
  h?: number
}

/**
 * M7-P5：模板缩略图——用 computeLayout 结果渲染静态 SVG。
 * 无事件、无动画、无手绘抖动；仅展示节点结构、文字（截断）与标签色点。
 * 等比缩放到 (w,h) 内居中。
 */
export default function TemplateThumbnail({ doc, dark, w = 140, h = 100 }: Props) {
  const theme = getTheme(dark)
  const layout = useMemo(() => computeLayout(doc), [doc])

  const b = layout.bounds
  const pad = 6
  const scale = Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h)
  const ox = (w - b.w * scale) / 2 - b.x * scale
  const oy = (h - b.h * scale) / 2 - b.y * scale

  return (
    <svg
      width={w}
      height={h}
      style={{ background: theme.paper, borderRadius: 6, display: 'block' }}
      aria-hidden="true"
    >
      <g transform={`translate(${ox},${oy}) scale(${scale})`}>
        {layout.edges.map((e) => (
          <path
            key={e.from + '>' + e.to}
            d={straightD(e)}
            fill="none"
            stroke={e.level <= 1 ? theme.ink : theme.inkSoft}
            strokeWidth={1 / scale}
            strokeLinecap="round"
            opacity={0.6}
          />
        ))}
        {[...layout.nodes.values()].map((n) => {
          const node = doc.nodes[n.id]
          const tags = node?.tags ?? []
          return (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={n.level === 0 ? 8 : 5}
                fill={n.level === 0 ? theme.rootFill : theme.nodeFill}
                stroke={n.level <= 1 ? theme.ink : theme.inkSoft}
                strokeWidth={1 / scale}
              />
              <text
                x={n.x + 6}
                y={n.y + n.h / 2}
                fontSize={9 / scale}
                fontFamily="system-ui, sans-serif"
                fill={n.level === 0 ? theme.rootText : theme.ink}
                dominantBaseline="central"
                style={{ pointerEvents: 'none' }}
              >
                {truncate(node?.text ?? '', 8)}
              </text>
              {tags.slice(0, 3).map((t, i) => (
                <circle
                  key={t.id + i}
                  cx={n.x + n.w - 5 - i * (7 / scale)}
                  cy={n.y + n.h / 2}
                  r={2.2 / scale}
                  fill={TAG_COLORS[t.color] ?? TAG_COLORS.gray}
                />
              ))}
            </g>
          )
        })}
      </g>
    </svg>
  )
}
