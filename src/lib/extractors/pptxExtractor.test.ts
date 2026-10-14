import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { extractPptx, parsePresentationRels, pptxSlideTexts, slideOrderFromPresentation } from './pptxExtractor'
import { unzipOoxml } from './ooxmlShared'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const PRESENTATION_XML = [
  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  '<p:sldIdLst>',
  '<p:sldId id="256" r:id="rId2"/>',
  '<p:sldId id="257" r:id="rId3"/>',
  '</p:sldIdLst></p:presentation>',
].join('')

const PRESENTATION_RELS = [
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
  '</Relationships>',
].join('')

function slideXml(shapes: string): string {
  return `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`
}

function titleShape(text: string, type = 'ctrTitle'): string {
  return `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function bodyShape(lines: string[]): string {
  return `<p:sp><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
}

function buildPptx(files: Record<string, string>): File {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])))
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  return new File([buffer], '课件.pptx', { type: PPTX_MIME, lastModified: 1_760_000_000_000 })
}

const BASE_FILES = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'ppt/presentation.xml': PRESENTATION_XML,
  'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS,
}

describe('PPTX 幻灯片顺序解析', () => {
  it('解析 rels 得到 rId → 幻灯片路径映射', () => {
    const targets = parsePresentationRels(PRESENTATION_RELS)
    expect(targets.get('rId2')).toBe('slides/slide1.xml')
    expect(targets.get('rId3')).toBe('slides/slide2.xml')
    expect(parsePresentationRels()).toEqual(new Map())
  })

  it('sldIdLst 无法解析出顺序时回退 null，由提取层按文件名排序', () => {
    // happy-dom 不保留命名空间属性（r:id 被丢弃），sldIdLst 顺序在单测中必然回退；
    // 真实 sldIdLst 顺序由 e2e（真实 Chromium + 打乱顺序的 fixture）验证。
    expect(slideOrderFromPresentation(PRESENTATION_XML, PRESENTATION_RELS)).toBeNull()
    expect(slideOrderFromPresentation('<p:presentation xmlns:p="p"><p:sldIdLst></p:sldIdLst></p:presentation>')).toBeNull()
  })
})

describe('PPTX 幻灯片文本提取', () => {
  it('标题占位符转标题、正文逐行成段、备注页不参与', () => {
    const content = pptxSlideTexts(slideXml(
      titleShape('第二章 输出')
      + bodyShape(['输出由状态计算。', '状态经过管道写出。']),
    ))
    expect(content.title).toBe('第二章 输出')
    expect(content.lines).toEqual(['输出由状态计算。', '状态经过管道写出。'])
  })

  it('a:br 换行拆分为多行', () => {
    const xml = slideXml(
      `<p:sp><p:txBody><a:p><a:r><a:t>第一行</a:t></a:r><a:br/><a:r><a:t>第二行</a:t></a:r></a:p></p:txBody></p:sp>`,
    )
    expect(pptxSlideTexts(xml).lines).toEqual(['第一行', '第二行'])
  })
})

describe('PPTX 文档提取', () => {
  it('提取标题与正文，写入幻灯片页锚点且不含备注', async () => {
    const file = buildPptx({
      ...BASE_FILES,
      'ppt/slides/slide1.xml': slideXml(titleShape('第一章 机制') + bodyShape(['初始化建立状态。'])),
      'ppt/slides/slide2.xml': slideXml(titleShape('第二章 输出') + bodyShape(['输出由状态计算。'])),
      'ppt/notesSlides/notesSlide1.xml': slideXml(bodyShape(['演讲者备注不应出现在导图'])),
    })
    const extracted = await extractPptx(file)
    expect(extracted.kind).toBe('pptx')
    expect(extracted.structure).toBe('markdown')
    expect(extracted.extractor).toBe('cat-pptx-ooxml-v1')
    expect(extracted.titleHint).toBe('第一章 机制')
    expect(extracted.text).toContain('# 第一章 机制')
    expect(extracted.text.indexOf('# 第一章 机制')).toBeLessThan(extracted.text.indexOf('# 第二章 输出'))
    expect(extracted.text).not.toContain('演讲者备注')
    expect(extracted.pageSpans).toHaveLength(2)
    expect(extracted.pageSpans[0]).toMatchObject({ page: 1 })
    expect(extracted.pageSpans[1]).toMatchObject({ page: 2 })
  })

  it('rels 缺失时回退文件名顺序并给出警告', async () => {
    const file = buildPptx({
      ...BASE_FILES,
      'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/slides/slide1.xml': slideXml(titleShape('第一章 机制')),
    })
    const extracted = await extractPptx(file)
    expect(extracted.text).toContain('# 第一章 机制')
    expect(extracted.warnings.join('')).toMatch(/播放顺序/)
  })

  it('空幻灯片告警，全部为空时报友好错误', async () => {
    const withEmpty = buildPptx({
      ...BASE_FILES,
      'ppt/slides/slide1.xml': slideXml(titleShape('第一章 机制')),
      'ppt/slides/slide2.xml': slideXml(bodyShape(['   '])),
    })
    const extracted = await extractPptx(withEmpty)
    expect(extracted.warnings.join('')).toMatch(/1 张幻灯片未提取到文本/)

    const allEmpty = buildPptx({
      ...BASE_FILES,
      'ppt/slides/slide1.xml': slideXml(bodyShape(['   '])),
    })
    await expect(extractPptx(allEmpty)).rejects.toThrow(/未提取到文本/)
  })

  it('没有幻灯片时报错', async () => {
    const file = buildPptx({ ...BASE_FILES })
    await expect(extractPptx(file)).rejects.toThrow(/没有幻灯片/)
  })

  it('伪装成 PPTX 的 DOCX、路径穿越与损坏归档被拒绝', async () => {
    const docxBytes = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"/>') })
    const disguised = new File([docxBytes], '伪装.pptx', { type: PPTX_MIME })
    await expect(extractPptx(disguised)).rejects.toThrow(/不是有效的 PPTX/)

    const traversal = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8(PRESENTATION_XML),
      '../evil.txt': strToU8('boom'),
    })
    await expect(extractPptx(new File([traversal], '穿越.pptx', { type: PPTX_MIME }))).rejects.toThrow(/不安全路径/)

    const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])
    await expect(extractPptx(new File([truncated], '损坏.pptx', { type: PPTX_MIME }))).rejects.toThrow()
  })

  it('解压结果包含幻灯片与备注文件（共享安全检查通过）', async () => {
    const file = buildPptx({
      ...BASE_FILES,
      'ppt/slides/slide1.xml': slideXml(titleShape('第一章 机制')),
    })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const archive = await unzipOoxml(bytes, 'PPTX', ['[Content_Types].xml', 'ppt/presentation.xml'])
    expect(Object.keys(archive)).toContain('ppt/slides/slide1.xml')
  })
})
