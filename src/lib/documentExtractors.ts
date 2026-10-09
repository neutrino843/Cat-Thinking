import type { SourceKind } from '../types'

export const MAX_SOURCE_BYTES = 5 * 1024 * 1024
export const MAX_SOURCE_CHARS = 2_000_000

export interface SourcePageSpan {
  page: number
  start: number
  end: number
}

export interface ExtractedDocument {
  kind: SourceKind
  /** 提取文本是否带 Markdown 标题标记；只影响结构识别，不改变来源文件类型。 */
  structure: 'text' | 'markdown'
  text: string
  extractor: string
  /** 解析器可靠识别到的标题提示；缺失时使用结构标题或文件名。 */
  titleHint?: string
  pageSpans: SourcePageSpan[]
  warnings: string[]
}

type Extractor = (file: File) => Promise<ExtractedDocument>

export function normalizeSourceText(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // 保留换行和 Tab，剔除会破坏渲染/序列化的其余 C0 控制字符。
    // eslint-disable-next-line no-control-regex -- 有意清理来源文档控制字符
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? ''
}

export function detectSourceKind(file: Pick<File, 'name' | 'type'>): SourceKind {
  const ext = extensionOf(file.name)
  if (ext === 'md' || ext === 'markdown' || file.type === 'text/markdown') return 'markdown'
  if (ext === 'txt' || ext === 'text' || file.type === 'text/plain') return 'text'
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf'
  if (
    ext === 'docx' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx'
  throw new Error('当前支持 TXT、Markdown、PDF 和 DOCX 文档')
}

async function extractText(file: File, kind: 'text' | 'markdown'): Promise<ExtractedDocument> {
  const text = normalizeSourceText(await file.text())
  return {
    kind,
    structure: kind,
    text,
    extractor: kind === 'markdown' ? 'browser-markdown-v2' : 'browser-text-v2',
    pageSpans: [],
    warnings: [],
  }
}

const extractors: Record<SourceKind, Extractor> = {
  text: (file) => extractText(file, 'text'),
  markdown: (file) => extractText(file, 'markdown'),
  // 重型格式按需加载；首屏和普通导图编辑不下载解析器代码。
  pdf: async (file) => (await import('./extractors/pdfExtractor')).extractPdf(file),
  docx: async (file) => (await import('./extractors/docxExtractor')).extractDocx(file),
}

/** Cat-Thinking 内建解析入口；不依赖外部进程、固定端口或绝对路径。 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`文档大小不能超过 ${MAX_SOURCE_BYTES / 1024 / 1024}MB`)
  }
  const kind = detectSourceKind(file)
  const result = await extractors[kind](file)
  if (!result.text) throw new Error('文档内容为空，无法生成导图')
  if (result.text.length > MAX_SOURCE_CHARS) {
    throw new Error(`文档文本超过 ${MAX_SOURCE_CHARS.toLocaleString('zh-CN')} 字符，请拆分后导入`)
  }
  return result
}
