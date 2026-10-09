import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  docxXmlToStructuredText,
  extractDocx,
  inspectDocxArchive,
} from './docxExtractor'

const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>课程标题</w:t></w:r></w:p>
    <w:p><w:r><w:t>第一段正文</w:t><w:tab/><w:t>补充</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>术语</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>解释</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>`

const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`

function docxBytes(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
    ...extra,
  })
}

describe('DOCX 内建提取器', () => {
  it('保留标题层级、段落和表格文本', () => {
    const text = docxXmlToStructuredText(documentXml, stylesXml)
    expect(text).toContain('# 课程标题')
    expect(text).toContain('第一段正文 补充')
    expect(text).toContain('术语 | 解释')
  })

  it('拒绝 XML 实体声明', () => {
    expect(() => docxXmlToStructuredText('<!DOCTYPE x [<!ENTITY y "bad">]><document/>'))
      .toThrow(/实体声明/)
  })

  it('解压前拒绝路径穿越条目', () => {
    const bytes = docxBytes({ '../outside.xml': strToU8('blocked') })
    expect(() => inspectDocxArchive(bytes)).toThrow(/不安全路径/)
  })

  it('拒绝缺少正文的伪 DOCX', () => {
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>') })
    expect(() => inspectDocxArchive(bytes)).toThrow(/word\/document\.xml/)
  })

  it('从 DOCX File 生成结构化来源', async () => {
    const bytes = docxBytes()
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    const file = new File([buffer], '课程.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const result = await extractDocx(file)
    expect(result.kind).toBe('docx')
    expect(result.structure).toBe('markdown')
    expect(result.extractor).toBe('cat-docx-ooxml-v1')
    expect(result.text).toContain('# 课程标题')
  })
})
