import type { SourceKind } from '../types'
import { recordAnalysisPerf } from '../analysis/perfEvents'

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024
export const MAX_SOURCE_CHARS = 2_000_000

/** 解析进度：reading（读文件）→ parsing（解压/逐页解析）→ structuring（生成导图结构）。 */
export interface ImportProgress {
  phase: 'reading' | 'parsing' | 'structuring'
  /** 0-1，同 phase 内单调递增。 */
  ratio: number
  /** 用户可读的进度说明，如「第 3/20 页」。 */
  detail?: string
}

export type ImportProgressListener = (progress: ImportProgress) => void

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
  /** Ranges refer to this exact normalized text, never to a rewritten copy. */
  blocks?: SourceStructureBlock[]
}

export interface SourceStructureBlock {
  kind: 'heading' | 'paragraph' | 'list'
  level: number
  start: number
  end: number
  label?: string
  edge?: 'top' | 'bottom'
  position?: number
}

type Extractor = (file: File, onProgress?: ImportProgressListener) => Promise<ExtractedDocument>

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
  // 旧版二进制 PPT 与启用宏的 PPTM 均不支持，提前给出可操作的引导。
  if (ext === 'ppt' || ext === 'pptm') {
    throw new Error('旧版 .ppt/.pptm 不受支持，请在 PowerPoint 中另存为 .pptx 后导入')
  }
  if (
    ext === 'pptx' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) return 'pptx'
  if (
    ext === 'docx' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx'
  throw new Error('当前支持 TXT、Markdown、PDF、DOCX 和 PPTX 文档')
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
  pdf: async (file, onProgress) => (await import('./extractors/pdfExtractor')).extractPdf(file, onProgress),
  docx: async (file, onProgress) => (await import('./extractors/docxExtractor')).extractDocx(file, onProgress),
  pptx: async (file, onProgress) => (await import('./extractors/pptxExtractor')).extractPptx(file, onProgress),
}

/** Cat-Thinking 内建解析入口；不依赖外部进程、固定端口或绝对路径。 */
/** 解析入口（C3 埋点：成功解析耗时与格式、字节数；失败路径不记，避免噪声） */
export async function extractDocument(
  file: File,
  onProgress?: ImportProgressListener,
): Promise<ExtractedDocument> {
  const startedAt = performance.now()
  const result = await extractDocumentInner(file, onProgress)
  recordAnalysisPerf({ stage: 'doc-parse', ms: Math.round(performance.now() - startedAt), kind: result.kind, bytes: file.size })
  return result
}

async function extractDocumentInner(
  file: File,
  onProgress?: ImportProgressListener,
): Promise<ExtractedDocument> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`文档大小不能超过 ${MAX_SOURCE_BYTES / 1024 / 1024}MB`)
  }
  onProgress?.({ phase: 'reading', ratio: 0.1, detail: file.name })
  const kind = detectSourceKind(file)
  const result = await extractors[kind](file, onProgress)
  if (!result.text) throw new Error('文档内容为空，无法生成导图')
  if (result.text.length > MAX_SOURCE_CHARS) {
    throw new Error(`文档文本超过 ${MAX_SOURCE_CHARS.toLocaleString('zh-CN')} 字符，请拆分后导入`)
  }
  onProgress?.({ phase: 'structuring', ratio: 0.9 })
  return result
}
