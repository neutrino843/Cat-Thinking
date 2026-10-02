import type { DocData } from '../types'
import {
  blobToDataURL,
  collectBlobIds,
  download,
  validateDoc,
} from './exporters'
import { sanitizeFileName } from './openFormats'
import { getBlob, putBlob, saveTemplate } from '../store/db'

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

  const doc = validateDoc(o.doc)
  const name = o.name.trim()
  const blobs = (o._blobs as Record<string, BlobMeta> | undefined) ?? {}

  // 把 _blobs 中的 dataURL 还原为 Blob，按原 blobId 写入 doc.id 下（saveTemplate 会克隆重映射）
  for (const [blobId, meta] of Object.entries(blobs)) {
    try {
      const res = await fetch(meta.dataURL)
      const blob = await res.blob()
      await putBlob(blobId, doc.id, blob)
    } catch {
      /* 单个 blob 还原失败不阻断导入（图片/附件可能缺失，不影响结构） */
    }
  }

  await saveTemplate(name, doc)
}
