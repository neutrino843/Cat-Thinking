import type { DocData } from '../types'
import { computeLayout } from './layout'
import { getTheme } from './theme'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { ganttHolder, worldHolder } from '../store/refs'

export function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}

export function exportJSON(doc: DocData) {
  download(`猫思之-${doc.title}.json`, new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
}

interface ExportInput {
  worldHTML: string
  doc: DocData
  dark: boolean
}

function buildSVG({ worldHTML, doc, dark }: ExportInput): { svg: string; w: number; h: number } {
  const theme = getTheme(dark)
  const b = computeLayout(doc).bounds
  const M = 48
  const x = b.x - M
  const y = b.y - M
  const w = Math.max(1, b.w + M * 2)
  const h = Math.max(1, b.h + M * 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.paper}"/>` +
    worldHTML +
    `</svg>`
  return { svg, w, h }
}

export function exportSVG(input: ExportInput) {
  const { svg } = buildSVG(input)
  download(`猫思之-${input.doc.title}.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
}

export async function exportPNG(input: ExportInput, scale = 2) {
  const { svg, w, h } = buildSVG(input)
  const img = new Image()
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('SVG 渲染失败'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) download(`猫思之-${input.doc.title}.png`, blob)
}

export function parseImported(text: string): DocData {
  const d = JSON.parse(text) as DocData
  if (!d || typeof d !== 'object' || !d.rootId || !d.nodes || !d.nodes[d.rootId]) {
    throw new Error('不是有效的猫思之文档')
  }
  return { ...d, version: 1 }
}

/** 从当前应用状态导出（先取消选择以获得干净画面） */
export async function exportCurrent(kind: 'json' | 'svg' | 'png') {
  const doc = useDoc.getState().doc
  if (kind === 'json') {
    exportJSON(doc)
    return
  }
  useDoc.getState().clearSel()
  await new Promise((r) => setTimeout(r, 80))
  if (useSettings.getState().view === 'gantt' && ganttHolder.current) {
    const svg = new XMLSerializer().serializeToString(ganttHolder.current)
    if (kind === 'svg') {
      download(`猫思之-${doc.title}-甘特.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    } else {
      await rasterize(svg, ganttHolder.current.width.baseVal.value, ganttHolder.current.height.baseVal.value, `${doc.title}-甘特`)
    }
    return
  }
  const worldHTML = worldHolder.current?.innerHTML ?? ''
  const input: ExportInput = { worldHTML, doc, dark: useSettings.getState().dark }
  if (kind === 'svg') exportSVG(input)
  else await exportPNG(input)
}

async function rasterize(svg: string, w: number, h: number, name: string) {
  const img = new Image()
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('SVG 渲染失败'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) download(`猫思之-${name}.png`, blob)
}
