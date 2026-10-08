import { describe, expect, it } from 'vitest'
import {
  sanitizeFileName,
  toMarkdown,
  parseMarkdown,
  parseOPML,
  toGanttCSV,
  toOPML,
} from './openFormats'
import { buildFixture } from '../test/fixture'
import type { DocData } from '../types'

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
          task: {
            start: '2026-09-01',
            end: '2026-09-05',
            progress: 0.5,
            priority: 2,
            owner: '张三',
            note: '备注内容',
            deps: [{ from: 'placeholder', type: 'FS' }],
          },
        },
        { text: '里程碑', task: { milestone: true, priority: 3 } },
      ],
    })
    // fixture 深拷贝 task，from 不变；这里手动把 from 指向第一个子节点
    const root = doc.nodes[doc.rootId]
    const firstChildId = root.children[0]
    doc.nodes[root.children[1]].task!.deps![0].from = firstChildId

    const csv = toGanttCSV(doc)
    expect(csv.startsWith('\ufeff')).toBe(true)
    const lines = csv.replace('\ufeff', '').split('\r\n')
    expect(lines[0]).toBe('层级,任务,开始,结束,进度%,里程碑,优先级,负责人,备注,前置任务')
    expect(lines[1]).toBe('0,根,,,,,,,,')
    expect(lines[2]).toBe('1,前置任务,,,,,,,,')
    expect(lines[3]).toBe('1,后续任务,2026-09-01,2026-09-05,50,,中,张三,备注内容,前置任务')
    expect(lines[4]).toBe('1,里程碑,,,,是,高,,,') // 里程碑列「是」
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
      version: 3,
      id: 'empty',
      title: '空',
      rootId: 'nope',
      layout: 'logic',
      nodes: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const csv = toGanttCSV(doc)
    expect(csv.replace('\ufeff', '').trim()).toBe(
      '层级,任务,开始,结束,进度%,里程碑,优先级,负责人,备注,前置任务',
    )
  })
})

describe('toOPML', () => {
  it('包含 XML 头/opml 版本/head 标题', () => {
    const xml = toOPML(buildFixture({ text: '根' }))
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<opml version="2.0">')
    expect(xml).toContain('<title>测试文档</title>')
  })

  it('根节点为 body 下唯一顶层 outline，嵌套表达层级', () => {
    const doc = buildFixture({
      text: '根',
      children: [{ text: 'a', children: [{ text: 'a1' }] }, { text: 'b' }],
    })
    const xml = toOPML(doc)
    // body 下只有一个顶层 <outline（根），其子树闭合后紧跟 </body>
    const body = xml.slice(xml.indexOf('<body>'), xml.indexOf('</body>'))
    const topCount = (body.match(/<outline /g) ?? []).length
    expect(topCount).toBe(4) // 根 + a + a1 + b，共 4 个 outline
    expect(xml).toContain('<outline text="根">')
    expect(xml).toContain('<outline text="a">')
    expect(xml).toContain('<outline text="a1"/>')
    expect(xml).toContain('<outline text="b"/>')
    // a1 的缩进应深于 a
    const lineA = xml.split('\n').find((l) => l.includes('text="a"'))!
    const lineA1 = xml.split('\n').find((l) => l.includes('text="a1"'))!
    expect(lineA1.indexOf('<outline')).toBeGreaterThan(lineA.indexOf('<outline'))
  })

  it('文本与标题中的 XML 特殊字符被转义', () => {
    const doc = buildFixture({
      text: '根',
      children: [{ text: '<脚本> & "引号"' }],
    })
    const xml = toOPML(doc)
    expect(xml).toContain('text="&lt;脚本&gt; &amp; &quot;引号&quot;"')
    expect(xml).not.toContain('<脚本>')
  })

  it('备注写入 _note 属性（富文本先降级纯文本）', () => {
    const doc = buildFixture({
      text: '根',
      children: [{ text: 'a', note: '纯文本备注' }],
    })
    const xml = toOPML(doc)
    expect(xml).toContain('_note="纯文本备注"')
  })

  it('空节点树（缺根）输出空 body 不崩', () => {
    const doc: DocData = {
      version: 3,
      id: 'x',
      title: '空',
      rootId: 'missing',
      layout: 'logic',
      nodes: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const xml = toOPML(doc)
    expect(xml).toContain('<body/>')
  })
})

describe('parseOPML', () => {
  it('标准往返：toOPML → parseOPML 节点数/层级/根文本/备注一致', () => {
    const src = buildFixture({
      text: '根',
      children: [
        { text: 'a', note: '备注A', children: [{ text: 'a1' }] },
        { text: 'b' },
      ],
    })
    const back = parseOPML(toOPML(src), '兜底')
    expect(back.title).toBe('测试文档')
    expect(Object.keys(back.nodes).length).toBe(4)
    const root = back.nodes[back.rootId]
    expect(root.text).toBe('根')
    expect(root.parent).toBeNull()
    expect(root.children.length).toBe(2)
    const a = back.nodes[root.children[0]]
    expect(a.text).toBe('a')
    expect(a.note).toBe('备注A')
    expect(a.children.length).toBe(1)
    expect(back.nodes[a.children[0]].text).toBe('a1')
    expect(back.nodes[root.children[1]].text).toBe('b')
  })

  it('多个顶层 outline 时建标题包裹根', () => {
    const xml =
      '<?xml version="1.0"?><opml version="2.0"><head><title>合集</title></head>' +
      '<body><outline text="x"/><outline text="y"/></body></opml>'
    const doc = parseOPML(xml, '兜底')
    const root = doc.nodes[doc.rootId]
    expect(root.text).toBe('合集')
    expect(root.children.length).toBe(2)
    expect(doc.nodes[root.children[0]].text).toBe('x')
    expect(doc.nodes[root.children[1]].text).toBe('y')
  })

  it('body 为空时仅生成标题根节点', () => {
    const xml = '<?xml version="1.0"?><opml version="2.0"><head/><body/></opml>'
    const doc = parseOPML(xml, '我的兜底')
    expect(doc.title).toBe('我的兜底')
    expect(Object.keys(doc.nodes).length).toBe(1)
    expect(doc.nodes[doc.rootId].text).toBe('我的兜底')
  })

  it('head 缺标题时用 fallback；text 缺省退 title 属性，再退 (空)', () => {
    // 单个顶层 outline 即根；根用 title 属性，子节点无任何文本属性 → (空)
    const xml =
      '<?xml version="1.0"?><opml version="2.0"><body>' +
      '<outline title="标题属性"><outline/></outline></body></opml>'
    const doc = parseOPML(xml, '兜底标题')
    expect(doc.title).toBe('兜底标题')
    const root = doc.nodes[doc.rootId]
    expect(root.text).toBe('标题属性')
    expect(root.children.length).toBe(1)
    expect(doc.nodes[root.children[0]].text).toBe('(空)')
  })

  it('单引号属性与数字字符引用可解析', () => {
    const xml = "<opml><body><outline text='A&#65;B&#x41;C'/></body></opml>"
    const doc = parseOPML(xml, 't')
    expect(doc.nodes[doc.rootId].text).toBe('AABAC')
  })

  it('空内容抛中文 Error', () => {
    expect(() => parseOPML('', 'x')).toThrow(/为空/)
    expect(() => parseOPML('   \n ', 'x')).toThrow(/为空/)
  })

  it('XML 格式错误抛中文 Error', () => {
    expect(() => parseOPML('<opml><body><outline text="未闭合"></opml>', 'x')).toThrow(/XML 格式错误/)
  })

  it('缺 opml 根元素抛中文 Error', () => {
    expect(() => parseOPML('<?xml version="1.0"?><html><body/></html>', 'x')).toThrow(/<opml>/)
  })

  it('注入样例不产生可执行结构（文本按数据解析，标签被当作节点文本的一部分也不执行）', () => {
    const xml =
      '<?xml version="1.0"?><opml><body><outline text="&lt;script&gt;alert(1)&lt;/script&gt;"/>' +
      '<outline><script>alert(2)</script></outline></body></opml>'
    const doc = parseOPML(xml, 't')
    const allText = Object.values(doc.nodes).map((n) => n.text)
    expect(allText).toContain('<script>alert(1)</script>')
    // 非法 script 子元素不会被当作 outline 节点（第二个顶层 outline 文本为空）
    const root = doc.nodes[doc.rootId]
    expect(root.children.length).toBe(2)
  })
})
