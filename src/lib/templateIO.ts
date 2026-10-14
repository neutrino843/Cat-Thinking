import type { DocData, SourceDocument } from '../types'
import {
  blobToDataURL,
  collectBlobIds,
  download,
  parseImported,
  pruneSourceAnchors,
} from './exporters'
import { sanitizeFileName } from './openFormats'
import { getBlob, listSourcesByDoc, saveTemplate } from '../store/db'
import { decodeImportedBlobs } from './importedBlobs'

/** M7-P5：.msz-tpl 文件中 blob 的 dataURL 结构（与 exportJSON 的 _blobs 一致） */
interface BlobMeta {
  dataURL: string
  type: string
  name?: string
}

/** M7-P5：模板文件结构 */
export interface MszTemplateFile {
  name: string
  doc: DocData
  _blobs?: Record<string, BlobMeta>
  _sources?: SourceDocument[]
}

/** M7-P5：blob → dataURL 内嵌的尺寸上限（与 exporters 一致，>2MB 不内嵌） */
const DATAURL_MAX_BYTES = 2 * 1024 * 1024

/**
 * M7-P5：导出模板为 .msz-tpl 文件。
 * 把 doc 中引用的 blob 内嵌为 dataURL（≤2MB），使模板文件自包含可跨设备分享。
 */
export async function exportTemplate(name: string, doc: DocData): Promise<void> {
  const _blobs: Record<string, BlobMeta> = {}
  for (const blobId of collectBlobIds(doc)) {
    const blob = await getBlob(blobId)
    if (!blob || blob.size > DATAURL_MAX_BYTES) continue
    _blobs[blobId] = { dataURL: await blobToDataURL(blob), type: blob.type }
  }
  const payload: MszTemplateFile = {
    name,
    doc,
    ...(Object.keys(_blobs).length ? { _blobs } : {}),
  }
  const sources = pruneSourceAnchors(doc, await listSourcesByDoc(doc.id))
  if (sources.length) payload._sources = sources
  download(
    `${sanitizeFileName(name)}.msz-tpl`,
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  )
}

/**
 * M7-P5：导入 .msz-tpl 文件到「我的模板」。
 * 流程：JSON 解析 → 校验 name+doc → validateDoc 结构校验 → blob 还原 → saveTemplate 克隆入库。
 * saveTemplate 内部 cloneFromTemplate 会重映射所有 id/blobId/links，并 cloneDocBlobs 落盘。
 */
export async function importTemplateFile(file: File): Promise<void> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error('无法读取模板文件')
  }
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new Error('不是有效的模板文件：' + (e as Error).message, { cause: e })
  }
  if (!obj || typeof obj !== 'object') throw new Error('不是有效的模板文件')
  const o = obj as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) throw new Error('模板缺少名称')
  if (!o.doc) throw new Error('模板文件缺少文档内容')

  const imported = parseImported(JSON.stringify({ ...(o.doc as object), _sources: o._sources ?? [], _blobs: o._blobs ?? {} }))
  const name = o.name.trim()
  // Write remapped attachments directly into the template transaction, never into the imported identity.
  await saveTemplate(name, imported.doc, imported.sources, decodeImportedBlobs(imported.blobs))
}
