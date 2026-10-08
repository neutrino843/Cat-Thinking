import { describe, expect, it } from 'vitest'
import { jpegToPdf } from './pdf'

/** 字节 → latin1 字符串（1 字节 1 字符，偏移量与原数组一一对应） */
function toBinaryString(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

describe('jpegToPdf 最小 PDF 生成器', () => {
  // 构造一段确定性「JPEG」（生成器不校验码流合法性，仅原样嵌入）
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])
  const bytes = jpegToPdf({ jpeg, pxW: 800, pxH: 600, ptW: 400, ptH: 300 })
  const s = toBinaryString(bytes)

  it('以 %PDF-1.4 头开始、%%EOF 结束', () => {
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('含 5 个对象、JPEG 以 DCTDecode 声明，尺寸写入字典与 MediaBox', () => {
    for (let n = 1; n <= 5; n++) expect(s).toContain(`${n} 0 obj`)
    expect(s).toContain('/Type /Catalog /Pages 2 0 R')
    expect(s).toContain('/MediaBox [0 0 400 300]')
    expect(s).toContain('/Width 800 /Height 600')
    expect(s).toContain('/Filter /DCTDecode')
    expect(s).toContain(`/Length ${jpeg.length}`)
    // 内容流把图片铺满整页
    expect(s).toContain('q 400 0 0 300 0 0 cm /Im0 Do Q')
  })

  it('xref 表偏移量与对象实际字节位置逐一精确对应', () => {
    const m = s.match(/startxref\n(\d+)\n%%EOF\n?$/)
    expect(m).not.toBeNull()
    const xrefOffset = Number(m![1])
    expect(s.indexOf('xref', xrefOffset)).toBe(xrefOffset)

    const xrefBlock = s.slice(xrefOffset)
    const lines = xrefBlock.split('\n')
    expect(lines[0]).toBe('xref')
    expect(lines[1]).toBe('0 6') // 1 个自由头 + 5 个对象
    const entries = lines.slice(2, 8)
    expect(entries.length).toBe(6)

    entries.forEach((line, i) => {
      // 每条目固定 20 字节：10 偏移 + 空格 + 5 代 + 空格 + f/n + CRLF
      expect(line.endsWith('\r')).toBe(true)
      const off = Number(line.slice(0, 10))
      const gen = line.slice(11, 16)
      const kind = line.slice(17, 18)
      if (i === 0) {
        // 自由表头：偏移 0、最大代 65535、类型 f
        expect(kind).toBe('f')
        expect(off).toBe(0)
        expect(gen).toBe('65535')
      } else {
        expect(kind).toBe('n')
        expect(gen).toBe('00000')
        // 该偏移处必须正好是对应对象定义
        expect(s.indexOf(`${i} 0 obj`, off)).toBe(off)
      }
    })

    expect(s).toContain('trailer << /Size 6 /Root 1 0 R >>')
  })

  it('JPEG 二进制原样嵌入 stream（字节级一致，不被文本编码破坏）', () => {
    const obj4 = s.indexOf('4 0 obj')
    const streamStart = s.indexOf('stream\n', obj4) + 'stream\n'.length
    for (let i = 0; i < jpeg.length; i++) {
      expect(s.charCodeAt(streamStart + i) & 0xff).toBe(jpeg[i])
    }
    // 紧接 \nendstream
    expect(s.slice(streamStart + jpeg.length, streamStart + jpeg.length + 10)).toBe('\nendstream')
  })

  it('总字节数与声明一致（startxref 指向真实 xref）', () => {
    const xrefOffset = Number(s.match(/startxref\n(\d+)/)![1])
    const xrefHeader = 'xref\n0 6\n'.length
    // 6 条目 ×20 字节
    const entriesBytes = 6 * 20
    const trailerStart = xrefOffset + xrefHeader + entriesBytes
    expect(s.slice(trailerStart, trailerStart + 'trailer'.length)).toBe('trailer')
  })
})
