/**
 * 内置手绘图标库（M7-P1）。
 * 每个图标是自研 SVG path，手绘风格（线条粗细 2、圆角端点）。
 * 渲染方式：在 SVG <g> 内插入 <path d={icon.path}>。
 * 零依赖：不引外部图标库，不增加包体。
 */

export interface HandIcon {
  id: string
  /** SVG path data（viewBox 0 0 24 24，stroke=currentColor，fill=none） */
  path: string
  /** 人类可读名（供编辑面板列表） */
  label: string
}

export const ICONS: HandIcon[] = [
  { id: 'flag', label: '旗帜', path: 'M6 3v18 M6 4l12 2-12 4' },
  { id: 'star', label: '星', path: 'M12 3l2.5 6 6.5.5-5 4.5 1.5 6.5-5.5-3.5L6 20.5l1.5-6.5-5-4.5 6.5-.5z' },
  { id: 'check', label: '对勾', path: 'M4 12l5 5 11-11' },
  { id: 'question', label: '疑问', path: 'M9 8a3 3 0 1 1 4 2.5c-1 .5-1 1.5-1 2.5 M12 18v.5' },
  { id: 'person', label: '人', path: 'M12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 20c0-3 3-5 6-5s6 2 6 5' },
  { id: 'lightbulb', label: '灯泡', path: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10z' },
  { id: 'fire', label: '火', path: 'M12 3c-1 3-4 5-4 9a4 4 0 0 0 8 0c0-2-1-3-1-5-2 1-3 3-3-4z' },
  { id: 'calendar', label: '日历', path: 'M4 5h16v15H4z M4 9h16 M8 3v4 M16 3v4' },
  { id: 'target', label: '靶心', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z' },
  { id: 'rocket', label: '火箭', path: 'M12 3c4 2 6 6 6 10l-3 3h-6L6 13c0-4 2-8 6-10z M12 16v5 M9 19l3 2 3-2' },
  { id: 'heart', label: '心', path: 'M12 20S4 14 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5-8 11-8 11z' },
  { id: 'warning', label: '警告', path: 'M12 4l9 16H3z M12 10v4 M12 17v.5' },
  { id: 'idea', label: '想法', path: 'M9 17h6 M10 20h4 M12 4a5 5 0 0 0-3 9c1 1 1 2 1 3h4c0-1 0-2 1-3a5 5 0 0 0-3-9z' },
  { id: 'bookmark', label: '书签', path: 'M6 3h12v18l-6-4-6 4z' },
  { id: 'clock', label: '时钟', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 3' },
  { id: 'tag', label: '标签', path: 'M3 12l9-9 9 9-9 9z M9 6l6 6' },
  { id: 'puzzle', label: '拼图', path: 'M4 4h6v2a2 2 0 1 1 4 0V4h6v6h-2a2 2 0 1 0 0 4h2v6H4v-6h2a2 2 0 1 0 0-4H4z' },
  { id: 'shield', label: '盾牌', path: 'M12 3l8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6z' },
  { id: 'globe', label: '地球', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18' },
  { id: 'mail', label: '邮件', path: 'M3 5h18v14H3z M3 7l9 6 9-6' },
  { id: 'phone', label: '电话', path: 'M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z' },
]

/** id → HandIcon 查找表 */
const ICON_MAP = new Map(ICONS.map((i) => [i.id, i]))

/** 取图标 path data；不存在返回 null */
export function getIcon(id: string): HandIcon | null {
  return ICON_MAP.get(id) ?? null
}

/** 渲染图标 SVG path 片段（供 Canvas/Outline 内联） */
export function renderIconPath(id: string): string | null {
  const icon = ICON_MAP.get(id)
  return icon ? icon.path : null
}
