import { describe, expect, it } from 'vitest'
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

  it('纯文本按标题和段落生成草稿，长段落正文保存在备注', async () => {
    const long = '这是一个用于验证长段落处理的正文。'.repeat(12)
    const draft = await prepareDocumentImport(sourceFile('学习笔记.txt', `第一章 基础\n\n${long}`))
    const root = draft.doc.nodes[draft.doc.rootId]
    const paragraph = draft.doc.nodes[root.children[0]]
    expect(draft.doc.title).toBe('第一章 基础')
    expect(paragraph.text.endsWith('…')).toBe(true)
    expect(paragraph.note).toBe(long)
  })

  it('空文档、超限文档及伪造 PDF 给出明确错误', async () => {
    await expect(prepareDocumentImport(sourceFile('empty.txt', ' \n '))).rejects.toThrow(/为空/)
    const huge = new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], 'huge.txt', { type: 'text/plain' })
    await expect(prepareDocumentImport(huge)).rejects.toThrow(/5MB/)
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
