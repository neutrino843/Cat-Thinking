import { describe, expect, it } from 'vitest'
import { prepareDocumentImport, prepareSavedSourceImport } from './documentImport'
import { canMoveImportNode, moveImportNode } from './importTree'
import { layoutNodeText } from './nodeTextLayout'
import { computeLayout } from './layout'
import { buildFixture } from '../test/fixture'
import { executeNodeCommand, nodeCommandForKey } from './nodeKeyboard'
import { useDoc } from '../store/docStore'
import { pdfPageStructure } from './extractors/pdfStructure'

describe('学习导图结构与编辑约定', () => {
  it('教师元信息保留在原文，不能成为课程候选或知识分支', async () => {
    for (const teacher of ['授课教师：张老师', '王老师']) {
      const draft = await prepareDocumentImport(new File([`${teacher}\n\n这是没有标题的正文。`], '高级密码学.txt'))
      expect(draft.doc.title).toBe('高级密码学')
      expect(Object.values(draft.doc.nodes).some((node) => node.text.includes('老师'))).toBe(false)
      expect(draft.source.text).toContain(teacher)
    }
  })

  it('嵌套列表保持并列与包含，公式下标不被Markdown清洗删除', async () => {
    const draft = await prepareDocumentImport(new File(['# IBE\n- BF\n  - 配对 e(g_1, g_2)\n- BB\n  - Setup'], '方案.md'))
    const find = (text: string) => Object.values(draft.doc.nodes).find((node) => node.text === text)!
    expect(find('配对 e(g_1, g_2)').parent).toBe(find('BF').id)
    expect(find('Setup').parent).toBe(find('BB').id)
    expect(find('BB').parent).toBe(find('BF').parent)
    for (const anchor of draft.source.anchors) expect(draft.source.text.slice(anchor.start, anchor.end)).toContain(draft.doc.nodes[anchor.nodeId].text)
  })

  it('预览重挂父节点保持ID/原文引用，拒绝根移动和环', async () => {
    const draft = await prepareDocumentImport(new File(['# 章节\n- A\n  - A1\n- B'], '结构.md'))
    const find = (text: string) => Object.values(draft.doc.nodes).find((node) => node.text === text)!
    expect(canMoveImportNode(draft.doc, find('A').id, find('A1').id)).toBe(false)
    expect(canMoveImportNode(draft.doc, draft.doc.rootId, find('B').id)).toBe(false)
    const changed = moveImportNode(draft.doc, find('A1').id, find('B').id)
    expect(changed.nodes[find('A1').id].parent).toBe(find('B').id)
    expect(draft.doc.nodes[find('A1').id].parent).toBe(find('A').id)
    expect(draft.source.anchors.some((anchor) => anchor.nodeId === find('A1').id)).toBe(true)
  })

  it('旧原文重整生成独立身份，不重写旧图和备注', async () => {
    const first = await prepareDocumentImport(new File(['# 课程\n\n原文内容。'], '旧图.md'))
    first.doc.nodes[first.doc.rootId].note = '我的推导'
    const original = JSON.stringify(first)
    const copy = prepareSavedSourceImport(first.source)
    expect(copy.doc.id).not.toBe(first.doc.id)
    expect(copy.source.id).not.toBe(first.source.id)
    expect(copy.source.text).toBe(first.source.text)
    expect(copy.source.anchors.every((anchor) => !!copy.doc.nodes[anchor.nodeId])).toBe(true)
    expect(JSON.stringify(first)).toBe(original)
  })

  it('换行保留完整字形、显式换行与全文，长英文词可折行', () => {
    const text = '定义 👩‍🔬 e(g_1,g_2)\n' + 'LongCryptographyWord'.repeat(6)
    const layout = layoutNodeText(text, 16)
    expect(layout.width).toBeLessThanOrEqual(320)
    expect(layout.lines.length).toBeGreaterThan(2)
    expect(layout.lines.join('')).toBe(text.replaceAll('\n', ''))
    expect(layout.lines.some((line) => line.includes('👩‍🔬'))).toBe(true)
  })

  for (const kind of ['logic', 'tree', 'org', 'fishbone', 'timeline'] as const) it(`${kind}：长标题与多级分支无节点重叠`, () => {
    const doc = buildFixture({ text: '根'.repeat(30), children: Array.from({ length: 4 }, (_, i) => ({ text: `分支${i}`.repeat(30), children: [{ text: '长子节点'.repeat(40), children: [{ text: '推导'.repeat(30) }] }, { text: '并列'.repeat(35) }] })) }, kind)
    const nodes = [...computeLayout(doc).nodes.values()]
    for (const node of nodes) {
      expect(node.w).toBeLessThanOrEqual(364)
      expect(node.textLines?.join('')).toBe(doc.nodes[node.id].text)
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]; const b = nodes[j]
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
    }
  })

  it('结构快捷键忽略组合输入与修饰键，Shift+Tab为退一级', () => {
    const key = { key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }
    expect(nodeCommandForKey(key, true)).toBe('child')
    expect(nodeCommandForKey({ ...key, isComposing: true })).toBeNull()
    expect(nodeCommandForKey({ ...key, keyCode: 229 })).toBeNull()
    expect(nodeCommandForKey({ ...key, ctrlKey: true })).toBeNull()
    expect(nodeCommandForKey({ ...key, repeat: true })).toBeNull()
    expect(nodeCommandForKey({ ...key, shiftKey: true })).toBe('outdent')
    expect(nodeCommandForKey({ ...key, key: 'Enter' }, true)).toBeNull()
  })

  it('大纲退一级会重新建立编辑焦点会话，不产生新节点', () => {
    const doc = buildFixture({ text: 'root', children: [{ text: 'parent', children: [{ text: 'child' }] }] })
    useDoc.getState().loadDoc(doc)
    useDoc.getState().setEditing({ id: 'n2', source: 'outline' })
    const editing = useDoc.getState().editing
    executeNodeCommand('outdent', 'n2', 'outline')
    expect(Object.keys(useDoc.getState().doc.nodes)).toHaveLength(3)
    expect(useDoc.getState().doc.nodes.n2.parent).toBe(doc.rootId)
    expect(useDoc.getState().editing).not.toBe(editing)
    expect(useDoc.getState().editing).toEqual({ id: 'n2', source: 'outline' })
  })

  it('PDF编号层级依编号深度，日期/IP/小数不被当成标题', () => {
    const lines = ['1 机制', '1.1 初始化', '1.1.1 状态', '正文说明。', '2026.10.12 日期', '127.0.0.1 地址', '3.14 圆周率']
    const result = pdfPageStructure(lines.map((str, i) => ({ str, width: 120, height: 12, transform: [12, 0, 0, 12, 40, 700 - i * 22] })))
    expect(result.blocks.filter((block) => block.kind === 'heading').map((block) => block.level)).toEqual([1, 2, 3])
    for (const block of result.blocks) expect(result.text.slice(block.start, block.end).trim()).not.toBe('')
  })
})
