import { describe, expect, it } from 'vitest'
import { sanitizeFileName, toMarkdown, parseMarkdown, toGanttCSV } from './openFormats'
import { buildFixture } from '../test/fixture'
import type { DocData, MindNodeData } from '../types'

describe('sanitizeFileName', () => {
  it('去除非法字符与控制字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    expect(sanitizeFileName('a\x00b\x1fc')).toBe('abc')
    expect(sanitizeFileName('  空白  ')).toBe('空白')
  })
  it('空名回退未命名导图', () => {
    expect(sanitizeFileName('')).toBe('未命名导图')
    expect(sanitizeFileName('///')).toBe('未命名导图')
    expect(sanitizeFileName('   ')).toBe('未命名导图')
  })
})

describe('toMarkdown', () => {
  it('标题 + 层级缩进（根不输出，子节点为顶层列表项）', () => {
    const doc = buildFixture({
      text: 'root',
      children: [{ text: 'a', children: [{ text: 'a1' }] }, { text: 'b' }],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('# 测试文档')
    expect(md).not.toContain('- root')
    expect(md).toContain('- a')
    expect(md).toContain('  - a1')
    expect(md).toContain('- b')
  })

  it('备注转引用行', () => {
    const doc = buildFixture({
      text: 'root',
      children: [{ text: 'a', note: '行1\n行2' }],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('- a')
    expect(md).toContain('  > 行1')
    expect(md).toContain('  > 行2')
  })

  it('任务信息行尾反引号块 + 里程碑前缀', () => {
    const doc = buildFixture({
      text: 'root',
      children: [
        { text: '任务', task: { start: '2026-09-01', end: '2026-09-05', progress: 40 } },
        { text: '里程碑', task: { milestone: true } },
      ],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('- 任务 `2026-09-01 → 2026-09-05 · 40%`')
    expect(md).toContain('- ◇ 里程碑')
  })

  it('超链接行尾', () => {
    const doc = buildFixture({
      text: 'root',
      children: [{ text: '链接', href: 'https://example.com' }],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('- 链接 [🔗](https://example.com)')
  })

  it('折叠状态不影响导出（完整树）', () => {
    const doc = buildFixture({
      text: 'root',
      collapsed: true,
      children: [{ text: 'a', children: [{ text: 'a1' }] }],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('- a')
    expect(md).toContain('  - a1')
  })

  it('仅 start / 仅 end 也能输出', () => {
    const doc = buildFixture({
      text: 'root',
      children: [
        { text: 's', task: { start: '2026-09-01' } },
        { text: 'e', task: { end: '2026-09-05' } },
      ],
    })
    const md = toMarkdown(doc)
    expect(md).toContain('`2026-09-01 →`')
    expect(md).toContain('`→ 2026-09-05`')
  })
})

describe('parseMarkdown 往返', () => {
  const src = buildFixture({
    text: '根',
    children: [
      { text: '任务', task: { start: '2026-09-01', end: '2026-09-05', progress: 40 } },
      { text: '里程碑', task: { milestone: true } },
      { text: '链接', href: 'https://x.io', note: '备注行1\n备注行2' },
    ],
  })

  it('toMarkdown → parseMarkdown 节点数/层级/字段一致（不含 deps）', () => {
    const md = toMarkdown(src)
    const back = parseMarkdown(md, '兜底')
    expect(back.title).toBe('测试文档')
    // 根 + 3 子 = 4 节点
    expect(Object.keys(back.nodes).length).toBe(4)
    const root = back.nodes[back.rootId]
    // root.text 往返后归一为 title（Markdown 仅 H1 承载标题，root.text 与 title 差异不保留）
    expect(root.text).toBe('测试文档')
    expect(root.children.length).toBe(3)
    const task = back.nodes[root.children[0]]
    expect(task.text).toBe('任务')
    expect(task.task?.start).toBe('2026-09-01')
    expect(task.task?.end).toBe('2026-09-05')
    expect(task.task?.progress).toBe(40)
    const ms = back.nodes[root.children[1]]
    expect(ms.task?.milestone).toBe(true)
    const link = back.nodes[root.children[2]]
    expect(link.href).toBe('https://x.io')
    expect(link.note).toBe('备注行1\n备注行2')
  })

  it('支持 4 空格缩进', () => {
    const md = '# T\n\n- a\n    - a1\n- b\n'
    const doc = parseMarkdown(md, '兜底')
    const root = doc.nodes[doc.rootId]
    expect(root.children.length).toBe(2)
    const a = doc.nodes[root.children[0]]
    expect(a.text).toBe('a')
    expect(a.children.length).toBe(1)
    expect(doc.nodes[a.children[0]].text).toBe('a1')
  })

  it('支持 Tab 缩进', () => {
    const md = '# T\n\n- a\n\t- a1\n'
    const doc = parseMarkdown(md, '兜底')
    const root = doc.nodes[doc.rootId]
    const a = doc.nodes[root.children[0]]
    expect(doc.nodes[a.children[0]].text).toBe('a1')
  })

  it('支持 * 和 + 列表标记', () => {
    const md = '# T\n\n* a\n+ b\n'
    const doc = parseMarkdown(md, '兜底')
    const root = doc.nodes[doc.rootId]
    expect(root.children.length).toBe(2)
  })

  it('无 H1 用 fallbackTitle', () => {
    const md = '- a\n- b\n'
    const doc = parseMarkdown(md, '我的标题')
    expect(doc.title).toBe('我的标题')
  })

  it('空内容抛中文 Error', () => {
    expect(() => parseMarkdown('', 'x')).toThrow(/为空/)
    expect(() => parseMarkdown('   \n  \n', 'x')).toThrow(/为空/)
  })

  it('仅 start / 仅 end 任务行解析', () => {
    const md = '- s `2026-09-01 →`\n- e `→ 2026-09-05`\n'
    const doc = parseMarkdown(md, 't')
    const root = doc.nodes[doc.rootId]
    expect(doc.nodes[root.children[0]].task?.start).toBe('2026-09-01')
    expect(doc.nodes[root.children[1]].task?.end).toBe('2026-09-05')
  })

  it('无法识别的行不崩（兜底跳过）', () => {
    const md = '# T\n\n一些不是列表的文本\n- a\n```\ncode block\n```\n- b\n'
    const doc = parseMarkdown(md, 't')
    const root = doc.nodes[doc.rootId]
    expect(root.children.length).toBe(2)
  })
})

describe('toGanttCSV', () => {
  it('表头 + BOM + 层级与字段', () => {
    const doc = buildFixture({
      text: '根',
      children: [
        { text: '前置任务' },
        {
          text: '后续任务',
          task: { start: '2026-09-01', end: '2026-09-05', progress: 50, deps: [{ from: 'placeholder', type: 'FS' }] },
        },
        { text: '里程碑', task: { milestone: true } },
      ],
    })
    // fixture 深拷贝 task，from 不变；这里手动把 from 指向第一个子节点
    const root = doc.nodes[doc.rootId]
    const firstChildId = root.children[0]
    doc.nodes[root.children[1]].task!.deps![0].from = firstChildId

    const csv = toGanttCSV(doc)
    expect(csv.startsWith('\ufeff')).toBe(true)
    const lines = csv.replace('\ufeff', '').split('\r\n')
    expect(lines[0]).toBe('层级,任务,开始,结束,进度%,里程碑,前置任务')
    expect(lines[1]).toBe('0,根,,,,,')
    expect(lines[2]).toBe('1,前置任务,,,,,')
    expect(lines[3]).toBe('1,后续任务,2026-09-01,2026-09-05,50,,前置任务')
    expect(lines[4]).toBe('1,里程碑,,,,是,') // 里程碑列「是」
  })

  it('字段含逗号引号做转义', () => {
    const doc = buildFixture({
      text: '根',
      children: [{ text: 'hello, "world"' }],
    })
    const csv = toGanttCSV(doc)
    expect(csv).toContain('"hello, ""world"""')
  })

  it('空文档不崩（仅表头）', () => {
    const doc: DocData = {
      version: 2,
      id: 'empty',
      title: '空',
      rootId: 'nope',
      layout: 'logic',
      nodes: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const csv = toGanttCSV(doc)
    expect(csv.replace('\ufeff', '').trim()).toBe('层级,任务,开始,结束,进度%,里程碑,前置任务')
  })
})
