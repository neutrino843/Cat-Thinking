/**
 * M10：自研最小 PDF 生成器（零第三方依赖，PRD 4.3 P1）。
 *
 * 原理：JPEG 是 PDF 原生支持的 DCTDecode 过滤器数据，可原样嵌入无需解码重编码，
 * 因此单页整图 PDF 只需 5 个对象（Catalog/Pages/Page/Image/Content）+ xref 表，
 * 约 100 行即可产出字节合法的 PDF。替代引入 jsPDF（gzip 后约 90KB），
 * 延续项目「只借思路、自研轻量实现」的约定（参见 ADR-3 手绘路径生成器）。
 *
 * 定位：导图/甘特归档单页位图 PDF（PRD 场景：周会会后导出 PDF 归档）。
 * 不做文本可选/多页排版——需要可检索文本请用 SVG/Markdown。
 */

export interface PdfImageInput {
  /** JPEG 二进制（DCT 编码码流，由 canvas.toBlob('image/jpeg') 产出） */
  jpeg: Uint8Array
  /** 图像像素宽（JPEG 实际像素，写 /Width） */
  pxW: number
  /** 图像像素高（JPEG 实际像素，写 /Height） */
  pxH: number
  /** 页面宽（PDF point = 1/72 英寸）；通常传画布 CSS 像素尺寸（1px≈1pt @72dpi） */
  ptW: number
  /** 页面高（PDF point） */
  ptH: number
}

/**
 * 把单张 JPEG 包成单页 PDF，返回完整文件字节。
 * 调用方负责用 new Blob([bytes], { type: 'application/pdf' }) 落盘。
 */
export function jpegToPdf({ jpeg, pxW, pxH, ptW, ptH }: PdfImageInput): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  let offset = 0
  const offsets: number[] = []

  const pushText = (s: string) => {
    const b = enc.encode(s)
    chunks.push(b)
    offset += b.length
  }
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b)
    offset += b.length
  }

  pushText('%PDF-1.4\n')
  // 二进制注释行：让传输工具/查看器识别这是含二进制的文件（PDF 规范建议）
  pushText('%\xFF\xD8\xFF\xD9\n')

  const beginObj = (n: number) => {
    offsets[n - 1] = offset
    pushText(`${n} 0 obj\n`)
  }

  // 1 Catalog
  beginObj(1)
  pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  // 2 Pages
  beginObj(2)
  pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')

  // 3 Page（MediaBox 用 point；图片 XObject 填满整页）
  beginObj(3)
  pushText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  )

  // 4 Image XObject（DCTDecode = 原样 JPEG 码流）
  beginObj(4)
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\n`,
  )
  pushText('stream\n')
  pushBytes(jpeg)
  pushText('\nendstream\nendobj\n')

  // 5 Content：q 保存状态 → 矩阵把单位正方形映射到整页 → 绘图 → Q 恢复
  beginObj(5)
  const content = `q ${ptW} 0 0 ${ptH} 0 0 cm /Im0 Do Q\n`
  pushText(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`)

  // xref 表（每条目必须精确 20 字节：10 位偏移 + 空格 + 5 位代 + 空格 + f/n + CRLF）
  const xrefStart = offset
  pushText('xref\n')
  pushText(`0 ${offsets.length + 1}\n`)
  pushText('0000000000 65535 f\r\n')
  for (const off of offsets) {
    pushText(String(off).padStart(10, '0') + ' 00000 n\r\n')
  }
  pushText(
    `trailer << /Size ${offsets.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  )

  // 拼接为单一 Uint8Array（jpeg 是二进制，不能走字符串）
  const out = new Uint8Array(offset)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}
