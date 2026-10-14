import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { docxXmlToStructuredText, extractDocx } from './docxExtractor'
import { unzipOoxml } from './ooxmlShared'

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

  it('缺少outlineLvl不会把Normal正文样式误判为一级标题', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>普通正文。</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>小节标题</w:t></w:r></w:p>'
      + '</w:body></w:document>'
    const styles = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
      + '</w:styles>'
    expect(docxXmlToStructuredText(xml, styles)).toBe('普通正文。\n\n## 小节标题')
  })

  it('有明确outlineLvl或继承的Heading样式时保持真实层级', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>子知识标题</w:t></w:r></w:p>'
      + '</w:body></w:document>'
    const styles = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:style w:type="paragraph" w:styleId="Custom"><w:basedOn w:val="Base"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>'
      + '</w:styles>'
    expect(docxXmlToStructuredText(xml, styles)).toBe('### 子知识标题')
  })

  it('拒绝 XML 实体声明', () => {
    expect(() => docxXmlToStructuredText('<!DOCTYPE x [<!ENTITY y "bad">]><document/>'))
      .toThrow(/实体声明/)
  })

  it('解压前拒绝路径穿越条目', async () => {
    const bytes = docxBytes({ '../outside.xml': strToU8('blocked') })
    await expect(unzipOoxml(bytes, 'DOCX', ['word/document.xml'])).rejects.toThrow(/不安全路径/)
  })

  it('拒绝缺少正文的伪 DOCX', async () => {
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>') })
    await expect(unzipOoxml(bytes, 'DOCX', ['word/document.xml'])).rejects.toThrow(/word\/document\.xml/)
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
    expect(result.extractor).toBe('cat-docx-ooxml-v2')
    expect(result.text).toContain('# 课程标题')
  })
})
