import { describe, expect, it } from 'vitest'
import { cleanPdfPageText, pdfItemsToText } from './pdfExtractor'

describe('PDF 文本重建', () => {
  it('根据坐标和换行标记恢复文本行', () => {
    expect(pdfItemsToText([
      { str: '第一章', transform: [1, 0, 0, 1, 10, 100] },
      { str: '基础', transform: [1, 0, 0, 1, 80, 100], hasEOL: true },
      { str: '正文', transform: [1, 0, 0, 1, 10, 80] },
    ])).toBe('第一章 基础\n正文')
  })

  it('只移除页边缘页码，保留正文数字', () => {
    expect(cleanPdfPageText('Page 2 / 8\n2026 年计划\n数字 42 应保留\n2'))
      .toBe('2026 年计划\n数字 42 应保留')
  })
})
