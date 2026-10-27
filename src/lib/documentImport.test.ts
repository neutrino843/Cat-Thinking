import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  MAX_DRAFT_NODES,
  MAX_SOURCE_BYTES,
  normalizeSourceText,
  prepareDocumentImport,
} from './documentImport'

function sourceFile(name: string, text: string, type = 'text/plain'): File {
  return new File([text], name, { type, lastModified: 1_760_000_000_000 })
}

describe('文档导入与内容提取', () => {
  it('规范化 BOM、换行和危险控制字符', () => {
    expect(normalizeSourceText('\uFEFFA\r\nB\u0000\r\n\r\n\r\n\r\nC  ')).toBe('A\nB\n\n\nC')
  })

  it('Markdown 标题层级转为可编辑节点，并保存来源锚点', async () => {
    const draft = await prepareDocumentImport(sourceFile(
      '课程.md',
      '# 操作系统\n\n导言内容。\n\n## 进程\n\n进程是资源分配单位。\n\n### 调度\n\n先来先服务。',
      'text/markdown',
    ))

    expect(draft.doc.version).toBe(3)
    expect(draft.doc.title).toBe('操作系统')
    expect(draft.source.text).toContain('进程是资源分配单位')
    expect(draft.source.docId).toBe(draft.doc.id)
    expect(draft.source.anchors.length).toBe(Object.keys(draft.doc.nodes).length)

    const root = draft.doc.nodes[draft.doc.rootId]
    const intro = draft.doc.nodes[root.children[0]]
    const process = draft.doc.nodes[root.children[1]]
    const scheduling = draft.doc.nodes[process.children[1]]
    expect(intro.text).toBe('导言内容。')
    expect(process.text).toBe('进程')
    expect(scheduling.text).toBe('调度')
  })

  it('长段落使用完整首句作标题，原文保存在来源且不占用个人备注', async () => {
    const long = '这是一个用于验证长段落处理的正文。'.repeat(12)
    const draft = await prepareDocumentImport(sourceFile('学习笔记.txt', `第一章 基础\n\n${long}`))
    const root = draft.doc.nodes[draft.doc.rootId]
    const paragraph = draft.doc.nodes[root.children[0]]
    expect(draft.doc.title).toBe('第一章 基础')
    expect(paragraph.text).toBe('这是一个用于验证长段落处理的正文。')
    expect(paragraph.note).toBeUndefined()
    expect(draft.source.text).toContain(long)
  })

  it('连续编号标题保留概念父子层级与原文定位，不要求标题之间空行', async () => {
    const text = '算法课程\n\n1 机制\n1.1 初始化\n1.1.1 状态数组\n状态数组保存中间状态。\n1.2 输出\n输出由状态计算。\n2 评估\n2.1 指标\n指标比较输出表现。'
    const draft = await prepareDocumentImport(sourceFile('算法.txt', text))
    const find = (label: string) => Object.values(draft.doc.nodes).find(({ text: value }) => value === label)!
    expect(find('1.1 初始化').parent).toBe(find('1 机制').id)
    expect(find('1.1.1 状态数组').parent).toBe(find('1.1 初始化').id)
    expect(find('状态数组保存中间状态。').parent).toBe(find('1.1.1 状态数组').id)
    expect(find('1.2 输出').parent).toBe(find('1 机制').id)
    expect(find('2.1 指标').parent).toBe(find('2 评估').id)
    const entry = draft.source.locators!.find(({ start }) => start === draft.source.text.indexOf('状态数组保存中间状态。'))!
    expect(entry.titlePath).toEqual(['1 机制', '1.1 初始化', '1.1.1 状态数组'])
    expect(draft.source.text.slice(entry.start, entry.end)).toBe('状态数组保存中间状态。')
    for (const anchor of draft.source.anchors) {
      expect(draft.source.text.slice(anchor.start, anchor.end).trim()).toContain(draft.doc.nodes[anchor.nodeId]!.text)
    }
  })

  it('章与节的关系保留下来，并在切换章节时结束旧子知识', async () => {
    const draft = await prepareDocumentImport(sourceFile('章节.txt', '课程\n\n第一章 机制\n第一节 初始化\n初始化建立状态。\n第二节 输出\n输出使用状态。\n第二章 评估\n第一节 指标\n指标测量表现。'))
    const find = (label: string) => Object.values(draft.doc.nodes).find(({ text: value }) => value === label)!
    expect(find('第一节 初始化').parent).toBe(find('第一章 机制').id)
    expect(find('第二节 输出').parent).toBe(find('第一章 机制').id)
    expect(find('第一节 指标').parent).toBe(find('第二章 评估').id)
    expect(find('指标测量表现。').parent).toBe(find('第一节 指标').id)
  })

  it('编号祖先缺失时不把其他章节的小节误挂到当前章节', async () => {
    const draft = await prepareDocumentImport(sourceFile('缺章.txt', '课程\n\n1 原理\n1.1 基础\n基础说明。\n2.1 评估\n2.1.1 指标\n指标说明。'))
    const find = (label: string) => Object.values(draft.doc.nodes).find(({ text: value }) => value === label)!
    expect(find('2.1 评估').parent).toBe(draft.doc.rootId)
    expect(find('2.1.1 指标').parent).toBe(find('2.1 评估').id)
    expect(draft.source.locators!.find(({ start }) => start === draft.source.text.indexOf('2.1 评估'))!.titlePath).toEqual(['2.1 评估'])
  })

  it('句子、日期和正文数字不会被补成知识层级，Markdown列表仍按原格式解析', async () => {
    const text = '1.1 这是一个完整的正文句子。\n\n2026.10.12 记录日期\n\n127.0.0.1 本地地址\n\n3.14 圆周率'
    const draft = await prepareDocumentImport(sourceFile('正文.txt', text))
    expect(draft.stats.sectionCount).toBe(0)
    expect(draft.stats.paragraphCount).toBe(4)
    const markdown = await prepareDocumentImport(sourceFile('列表.md', '# 清单\n\n1. 第一项\n2. 第二项', 'text/markdown'))
    expect(markdown.stats.sectionCount).toBe(0)
    expect(markdown.stats.paragraphCount).toBe(2)
  })

  it('无标题样式的DOCX仍识别明确编号，引用offset保持提取原文位置', async () => {
    const paragraphs = ['算法课程', '1 算法机制', '1.1 初始化', '1.1.1 状态数组', '状态数组保存中间状态。', '1.2 输出', '输出取自状态。']
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + paragraphs.map((value) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>'
    const bytes = zipSync({ 'word/document.xml': strToU8(xml) })
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    const draft = await prepareDocumentImport(new File([buffer], '算法.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }))
    const find = (label: string) => Object.values(draft.doc.nodes).find(({ text: value }) => value === label)!
    expect(find('1.1 初始化').parent).toBe(find('1 算法机制').id)
    expect(find('1.1.1 状态数组').parent).toBe(find('1.1 初始化').id)
    expect(find('输出取自状态。').parent).toBe(find('1.2 输出').id)
    const sourcePosition = draft.source.text.indexOf('状态数组保存中间状态。')
    const locator = draft.source.locators!.find(({ start }) => start === sourcePosition)!
    expect(locator.titlePath).toEqual(['1 算法机制', '1.1 初始化', '1.1.1 状态数组'])
    expect(draft.source.text.slice(locator.start, locator.end)).toBe('状态数组保存中间状态。')
  })

  it('空文档、超限文档及伪造 PDF 给出明确错误', async () => {
    await expect(prepareDocumentImport(sourceFile('empty.txt', ' \n '))).rejects.toThrow(/为空/)
    const huge = new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], 'huge.txt', { type: 'text/plain' })
    await expect(prepareDocumentImport(huge)).rejects.toThrow(/25MB/)
    await expect(prepareDocumentImport(sourceFile('paper.pdf', 'fake', 'application/pdf'))).rejects.toThrow(/签名无效/)
  })

  it('草稿节点截断但完整原文仍保留', async () => {
    const text = Array.from({ length: MAX_DRAFT_NODES + 20 }, (_, index) => `第${index + 1}节 标题\n\n正文 ${index + 1}`).join('\n\n')
    const draft = await prepareDocumentImport(sourceFile('大文档.txt', text))
    expect(Object.keys(draft.doc.nodes)).toHaveLength(MAX_DRAFT_NODES)
    expect(draft.source.text).toBe(normalizeSourceText(text))
    expect(draft.warnings.join('')).toMatch(/完整原文仍已保存/)
    expect(draft.source.anchors.every((anchor) => (
      !!draft.doc.nodes[anchor.nodeId] && anchor.start >= 0 && anchor.end <= draft.source.text.length
    ))).toBe(true)
    expect(draft.source.anchors.length).toBeLessThan(draft.source.locators?.length ?? 0)
    expect(draft.source.locators?.at(-1)?.end).toBe(draft.source.text.length)
  })
})
