/** 全部按本地时区处理的日期工具，输入输出均为 'YYYY-MM-DD' */

export function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayISO(): string {
  return toISO(new Date())
}

export function addDays(s: string, n: number): string {
  const d = parseISO(s)
  d.setDate(d.getDate() + n)
  return toISO(d)
}

/** b - a 的整天数（同日为 0） */
export function diffDays(a: string, b: string): number {
  const ms = parseISO(b).getTime() - parseISO(a).getTime()
  return Math.round(ms / 86400000)
}

/** 0=周日 … 6=周六 */
export function weekday(s: string): number {
  return parseISO(s).getDay()
}

export function isWeekend(s: string): boolean {
  const w = weekday(s)
  return w === 0 || w === 6
}

/** 取 s 所在周（周一开始）的周一 */
export function weekStart(s: string): string {
  const w = weekday(s)
  return addDays(s, w === 0 ? -6 : 1 - w)
}

/** 月份 'YYYY-MM' */
export function monthKey(s: string): string {
  return s.slice(0, 7)
}

export function clampRange(start?: string, end?: string): { start: string; end: string } | null {
  if (!start && !end) return null
  const s = start ?? end!
  const e = end ?? start!
  return diffDays(s, e) < 0 ? { start: e, end: s } : { start: s, end: e }
}
