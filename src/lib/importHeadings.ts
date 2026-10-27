export interface PlainHeading { level: number; headingKey?: string; parentHeadingKey?: string }

function chapterNumber(value: string): string | undefined {
  if (/^\d+$/.test(value)) return String(Number(value))
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (digits[value]) return String(digits[value])
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, units] = value.split('十')
    return String((digits[tens] ?? 1) * 10 + (digits[units] ?? 0))
  }
  return undefined
}

export function explicitPlainHeading(text: string): PlainHeading | null {
  const value = text.trim()
  if (!value || value.length > 60 || /[。！？.!?；;：:]$/.test(value)) return null
  const chapter = value.match(/^第([0-9一二三四五六七八九十百千]+)([章节篇部卷])(?:\s|[^0-9])/)
  if (chapter) return { level: chapter[2] === '节' ? 2 : 1,
    ...(chapter[2] === '章' && chapterNumber(chapter[1]) ? { headingKey: chapterNumber(chapter[1]) } : {}) }
  const numbered = value.match(/^([1-9][0-9]{0,2}(?:[.．][1-9][0-9]{0,2}){0,5})[.．、)）]?[ \t\u3000]+\S/)
  if (!numbered) return null
  const parts = numbered[1].split(/[.．]/)
  return { level: parts.length, headingKey: parts.join('.'), ...(parts.length > 1 ? { parentHeadingKey: parts.slice(0, -1).join('.') } : {}) }
}

export function numberedHeadingContext(candidates: readonly PlainHeading[]): (heading: PlainHeading) => boolean {
  const keys = new Set(candidates.map((heading) => heading.headingKey).filter(Boolean))
  const children = new Map<string, Set<string>>()
  for (const heading of candidates) if (heading.parentHeadingKey && heading.headingKey) {
    const siblings = children.get(heading.parentHeadingKey) ?? new Set<string>()
    siblings.add(heading.headingKey); children.set(heading.parentHeadingKey, siblings)
  }
  return (heading) => !heading.parentHeadingKey || keys.has(heading.parentHeadingKey)
    || (children.get(heading.parentHeadingKey)?.size ?? 0) > 1
    || !!heading.headingKey && (children.get(heading.headingKey)?.size ?? 0) > 0
}
