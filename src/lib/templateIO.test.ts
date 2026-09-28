import { describe, expect, it, vi, beforeEach } from 'vitest'
import { exportTemplate, importTemplateFile, type MszTemplateFile } from './templateIO'
import { buildFixture } from '../test/fixture'
import * as db from '../store/db'

/** 捕获 download 调用产生的 Blob 文本 */
let capturedText = ''
vi.mock('../lib/exporters', async () => {
  const actual = await vi.importActual<typeof import('../lib/exporters')>('../lib/exporters')
  return {
    ...actual,
    download: vi.fn((_name: string, blob: Blob) => {
      blob.text().then((t) => { capturedText = t })
    }),
  }
})

vi.mock('../store/db', () => ({
  getBlob: vi.fn(async () => undefined),
  putBlob: vi.fn(async () => {}),
  saveTemplate: vi.fn(async () => 'tpl-new-id'),
}))

describe('templateIO · .msz-tpl 往返', () => {
  beforeEach(() => {
    capturedText = ''
    vi.clearAllMocks()
  })

  it('exportTemplate 产出合法的 .msz-tpl JSON（含 name + doc，无 _blobs 时省略）', async () => {
    const doc = buildFixture({
      text: 'root',
      children: [{ text: 'a' }, { text: 'b' }],
    })
    await exportTemplate('测试模板', doc)

    // download 是异步写 capturedText，等一帧
    await new Promise((r) => setTimeout(r, 10))
    const payload = JSON.parse(capturedText) as MszTemplateFile
    expect(payload.name).toBe('测试模板')
    expect(payload.doc.rootId).toBe(doc.rootId)
    expect(Object.keys(payload.doc.nodes).length).toBe(3)
    expect(payload.doc.nodes[doc.rootId].text).toBe('root')
    // 无图片/附件时不带 _blobs
    expect(payload._blobs).toBeUndefined()
  })

  it('importTemplateFile 解析合法 .msz-tpl 并调用 saveTemplate', async () => {
    const doc = buildFixture({ text: 'root', children: [{ text: 'a' }] })
    const payload: MszTemplateFile = { name: '导入模板', doc }
    const file = new File([JSON.stringify(payload)] as BlobPart[], 'tpl.msz-tpl', { type: 'application/json' })

    await importTemplateFile(file)

    expect(db.saveTemplate).toHaveBeenCalledWith('导入模板', expect.objectContaining({ rootId: doc.rootId }))
    // 无 _blobs 时 putBlob 不被调用
    expect(db.putBlob).not.toHaveBeenCalled()
  })

  it('importTemplateFile 对非法 JSON 抛错', async () => {
    const file = new File(['not json'] as BlobPart[], 'bad.msz-tpl', { type: 'application/json' })
    await expect(importTemplateFile(file)).rejects.toThrow(/不是有效的模板文件/)
  })

  it('importTemplateFile 对缺少 name 的文件抛错', async () => {
    const file = new File([JSON.stringify({ doc: buildFixture({ text: 'x' }) })] as BlobPart[], 'x.msz-tpl', { type: 'application/json' })
    await expect(importTemplateFile(file)).rejects.toThrow(/缺少名称/)
  })

  it('importTemplateFile 对结构非法 doc 抛错（validateDoc 校验）', async () => {
    // doc 缺少 rootId
    const payload = { name: '坏模板', doc: { id: 'x', title: 'x', nodes: {} } }
    const file = new File([JSON.stringify(payload)] as BlobPart[], 'x.msz-tpl', { type: 'application/json' })
    await expect(importTemplateFile(file)).rejects.toThrow()
  })
})

describe('TemplateThumbnail · 缩略图非空', () => {
  it('缩略图 SVG 渲染不为空（节点数 > 0）', async () => {
    // TemplateThumbnail 是 React 组件，用 react-dom/server renderToString 验证不抛错且产出 svg
    const React = await import('react')
    const { renderToString } = await import('react-dom/server')
    const { default: TemplateThumbnail } = await import('../components/TemplateThumbnail')
    const doc = buildFixture({ text: 'root', children: [{ text: 'a' }, { text: 'b' }] })
    const html = renderToString(React.createElement(TemplateThumbnail, { doc, dark: false }))
    // 产出含 <svg> 且含 <rect> 节点
    expect(html).toContain('<svg')
    expect(html).toContain('<rect')
    // 3 个节点 → 至少 3 个 rect
    const rectCount = (html.match(/<rect/g) || []).length
    expect(rectCount).toBeGreaterThanOrEqual(3)
  })
})
