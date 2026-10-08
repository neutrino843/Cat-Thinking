/**
 * M10：单文件 .msz 模式（PRD 4.3 P1）——File System Access API 直接读写磁盘文件。
 *
 * 设计要点：
 * - .msz 本质就是 JSON 全量导出载荷（含 _blobs 自包含），与「导出 JSON」同结构，
 *   区别仅在扩展名与「句柄绑定后可原地覆写」；
 * - IndexedDB 自动保存仍是崩溃恢复生命线（≤1s 防抖），.msz 写入只由显式动作触发
 *   （菜单另存 / Ctrl+S），避免编辑时频繁弹权限与大文件同步写盘；
 * - 句柄双重记忆：当页内存 Map（同会话零延迟）+ Dexie fileHandles 表（跨会话，
 *   重开需在用户手势内 requestPermission 重新授权，浏览器安全模型要求）；
 * - 不支持 File System Access API 的浏览器（Firefox/Safari）由 isFileHandleSupported
 *   检测，UI 降级提示使用普通「导入文件 / 导出」。
 */
import type { DocData } from '../types'
import { getFSA, type MSZFileHandle } from './fsaTypes'
import { buildExportPayload, markBackupNow, parseImported } from './exporters'
import { sanitizeFileName } from './openFormats'
import {
  bindFileHandle,
  getFileHandle,
  putBlob,
  saveDoc,
  touchFileHandle,
} from '../store/db'
import { useDoc } from '../store/docStore'
import { emitDocsChanged } from './tabs'

/** 保存成功事件（detail.name 为文件名）；Toolbar 监听后显示轻提示 */
export const FILE_SAVED_EVENT = 'msz:file-saved'

/** .msz 文件选择器类型描述（内容是 JSON，扩展名 .msz） */
const MSZ_PICKER_TYPE = {
  description: '猫思之文档（.msz）',
  accept: { 'application/json': ['.msz'] },
}

/** 当页内存绑定（另存后同会话 Ctrl+S 立即生效，无需等 IDB 事务/重查） */
const memoryBindings = new Map<string, MSZFileHandle>()

/** 浏览器是否支持 File System Access API */
export function isFileHandleSupported(): boolean {
  return getFSA() !== null
}

/**
 * 确保句柄有 readwrite 权限。跨会话持久化的句柄首次写入时浏览器要求在
 * 用户手势内重新授权；用户拒绝或关闭授权弹窗 → 抛中文 Error（含 AbortError）。
 */
async function ensureWritable(handle: MSZFileHandle): Promise<void> {
  const mode = { mode: 'readwrite' } as const
  let state: PermissionState = 'prompt'
  try {
    state = await handle.queryPermission(mode)
  } catch {
    /* 某些实现无 query，直接走 request */
  }
  if (state === 'granted') return
  const req = await handle.requestPermission(mode)
  if (req !== 'granted') throw new Error('未获得文件写入权限，无法保存到该 .msz 文件')
}

/** 把自包含 JSON 载荷覆盖写入句柄指向的文件 */
async function writeDocToHandle(handle: MSZFileHandle, doc: DocData): Promise<void> {
  const payload = await buildExportPayload(doc)
  const writable = await handle.createWritable()
  try {
    await writable.write(payload)
  } finally {
    await writable.close()
  }
}

/** 记忆绑定：内存立即生效；IDB 持久化 best-effort（失败不影响文件已保存的事实） */
async function rememberBinding(docId: string, handle: MSZFileHandle): Promise<void> {
  memoryBindings.set(docId, handle)
  try {
    await bindFileHandle(docId, handle)
  } catch (e) {
    console.warn('[猫思之] .msz 句柄持久化失败（本次保存仍有效）', e)
  }
}

/** 取文档当前绑定的句柄：内存优先，其次 Dexie（回填内存） */
export async function getBoundHandle(docId: string): Promise<MSZFileHandle | undefined> {
  const mem = memoryBindings.get(docId)
  if (mem) return mem
  const persisted = await getFileHandle(docId).catch(() => undefined)
  if (persisted) memoryBindings.set(docId, persisted)
  return persisted
}

/**
 * 「另存为 .msz」：弹系统保存框 → 写入 → 绑定句柄。
 * @returns 保存成功返回句柄；用户取消返回 null；浏览器不支持返回 undefined
 */
export async function saveMSZAs(doc: DocData): Promise<MSZFileHandle | null | undefined> {
  const fsa = getFSA()
  if (!fsa) return undefined
  let handle: MSZFileHandle
  try {
    handle = await fsa.showSaveFilePicker({
      suggestedName: `${sanitizeFileName('猫思之-' + doc.title)}.msz`,
      types: [MSZ_PICKER_TYPE],
    })
  } catch (e) {
    // 用户点取消：AbortError，静默返回 null
    if ((e as Error)?.name === 'AbortError') return null
    throw new Error('无法创建 .msz 文件：' + (e as Error).message, { cause: e })
  }
  await writeDocToHandle(handle, doc)
  await rememberBinding(doc.id, handle)
  markBackupNow()
  window.dispatchEvent(new CustomEvent(FILE_SAVED_EVENT, { detail: { name: handle.name } }))
  return handle
}

/**
 * 「保存到文件」（Ctrl+S）：向已绑定句柄原地覆写。
 * @returns 'saved' 成功；'unbound' 未绑定（调用方应改走另存为）；
 *          'unsupported' 浏览器不支持
 */
export async function saveMSZBound(doc: DocData): Promise<'saved' | 'unbound' | 'unsupported'> {
  if (!isFileHandleSupported()) return 'unsupported'
  const handle = await getBoundHandle(doc.id)
  if (!handle) return 'unbound'
  await ensureWritable(handle)
  await writeDocToHandle(handle, doc)
  await touchFileHandle(doc.id).catch(() => {})
  markBackupNow()
  window.dispatchEvent(new CustomEvent(FILE_SAVED_EVENT, { detail: { name: handle.name } }))
  return 'saved'
}

/**
 * 「打开 .msz 文件」：弹系统打开框 → 读取解析 → 入库（含 blob 还原）→ 绑定句柄。
 * @returns 成功返回新文档；用户取消返回 null；浏览器不支持返回 undefined。
 * 调用方拿到 doc 后负责 useDoc.getState().loadDoc(doc) 与列表刷新。
 */
export async function openMSZFile(): Promise<DocData | null | undefined> {
  const fsa = getFSA()
  if (!fsa) return undefined
  let handles: MSZFileHandle[]
  try {
    handles = await fsa.showOpenFilePicker({
      multiple: false,
      types: [MSZ_PICKER_TYPE],
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return null
    throw new Error('无法打开 .msz 文件：' + (e as Error).message, { cause: e })
  }
  const handle = handles[0]
  if (!handle) return null

  const file = await handle.getFile()
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error('无法读取该 .msz 文件')
  }
  // parseImported 按扩展名分流：.msz 走 JSON + validateDoc 严格结构校验
  const { doc, blobs } = parseImported(text, file.name || '未命名导图.msz')

  await saveDoc(doc)
  // 还原内嵌 blob（与 Sidebar.importFile 同流程）
  for (const [blobId, meta] of Object.entries(blobs)) {
    try {
      const res = await fetch(meta.dataURL)
      const blob = await res.blob()
      await putBlob(blobId, doc.id, blob)
    } catch {
      /* 单个 blob 还原失败不阻断打开 */
    }
  }
  await rememberBinding(doc.id, handle)
  return doc
}

/* ---------------- UI 统一编排（Toolbar 菜单 / Palette / Ctrl+S 共用） ---------------- */

export type FileActionResult = 'done' | 'cancelled' | 'unsupported'

/** 打开 .msz 并载入当前工作区（M11：以新标签打开并通知文档列表刷新） */
export async function openMSZCurrent(): Promise<FileActionResult> {
  if (!isFileHandleSupported()) return 'unsupported'
  const doc = await openMSZFile()
  if (doc === undefined) return 'unsupported'
  if (doc === null) return 'cancelled'
  // 同 id 重开（文件在外部被改后重新载入）：走 loadDoc 完整替换内容并重置会话；
  // 否则 openDoc 会把它当作「切到已打开标签」早返回，外部改动进不来。
  const st = useDoc.getState()
  if (st.doc.id === doc.id) st.loadDoc(doc)
  else st.openDoc(doc)
  emitDocsChanged()
  return 'done'
}

/**
 * 快速保存（Ctrl+S）：已绑定 → 原地覆写；未绑定 → 走「另存为」首次选文件。
 * 成功提示通过 FILE_SAVED_EVENT 由 Toolbar 统一展示。
 */
export async function quickSaveCurrent(): Promise<FileActionResult> {
  if (!isFileHandleSupported()) return 'unsupported'
  const doc = useDoc.getState().doc
  const bound = await saveMSZBound(doc)
  if (bound === 'saved') return 'done'
  if (bound === 'unsupported') return 'unsupported'
  const h = await saveMSZAs(doc)
  if (h === undefined) return 'unsupported'
  return h === null ? 'cancelled' : 'done'
}
