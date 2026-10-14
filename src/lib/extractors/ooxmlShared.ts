import { strFromU8, unzip } from 'fflate'

/**
 * DOCX/PPTX 共用的 OOXML 基建：
 * - ZIP 中央目录安全检查（zip bomb、加密包、路径穿越、异常条目）
 * - Web Worker 化解压，测试环境或 Worker 不可用时回退主线程
 * - 命名空间无关的 XML 解析工具
 */

export const MAX_ZIP_ENTRIES = 5_000
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024
export const MAX_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024
export const MAX_COMPRESSION_RATIO = 200

export interface ZipEntryMeta {
  name: string
  compressedSize: number
  uncompressedSize: number
}

export interface OoxmlInspectOptions {
  /** 用户可读的格式名，用于错误文案（DOCX、PPTX）。 */
  label: string
  /** 归档必须包含的条目；缺失时报「不是有效的 XX」。 */
  requiredEntries: string[]
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

export function safeArchivePath(name: string): boolean {
  const normalized = name.replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  return !normalized.split('/').some((part) => part === '..')
}

/**
 * 解压前读取 ZIP 中央目录，阻断路径穿越、加密包、异常条目数和 zip bomb。
 * OOXML 内容只在内存中读取，从不把归档路径写入文件系统。
 */
export function inspectOoxmlArchive(bytes: Uint8Array, options: OoxmlInspectOptions): ZipEntryMeta[] {
  const { label, requiredEntries } = options
  if (bytes.length < 22) throw new Error(`${label} 文件结构不完整`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minOffset = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (u32(view, offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error(`${label} 缺少 ZIP 中央目录`)
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) throw new Error(`不支持分卷 ${label}`)

  const entryCount = u16(view, eocd + 10)
  const directorySize = u32(view, eocd + 12)
  const directoryOffset = u32(view, eocd + 16)
  if (entryCount === 0 || entryCount > MAX_ZIP_ENTRIES) throw new Error(`${label} 归档条目数量异常`)
  if (directoryOffset + directorySize > eocd) throw new Error(`${label} 中央目录范围非法`)

  const entries: ZipEntryMeta[] = []
  let offset = directoryOffset
  let expandedTotal = 0
  let compressedTotal = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || u32(view, offset) !== 0x02014b50) throw new Error(`${label} 中央目录条目损坏`)
    const flags = u16(view, offset + 8)
    const method = u16(view, offset + 10)
    const compressedSize = u32(view, offset + 20)
    const uncompressedSize = u32(view, offset + 24)
    const nameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > eocd) throw new Error(`${label} 中央目录路径范围非法`)
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (!safeArchivePath(name)) throw new Error(`${label} 包含不安全路径：${name || '(empty)'}`)
    if ((flags & 1) !== 0) throw new Error(`不支持加密 ${label}`)
    if (method !== 0 && method !== 8) throw new Error(`${label} 使用了不支持的压缩方式：${method}`)
    if (uncompressedSize > MAX_SINGLE_ENTRY_BYTES) throw new Error(`${label} 条目过大：${name}`)
    expandedTotal += uncompressedSize
    compressedTotal += compressedSize
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new Error(`${label} 解压后内容超过 32MB 安全限制`)
    entries.push({ name, compressedSize, uncompressedSize })
    offset = next
  }
  for (const required of requiredEntries) {
    if (!entries.some((entry) => entry.name === required)) {
      throw new Error(`不是有效的 ${label}：缺少 ${required}`)
    }
  }
  if (compressedTotal > 0 && expandedTotal / compressedTotal > MAX_COMPRESSION_RATIO) {
    throw new Error(`${label} 压缩比异常，已阻止可能的 zip bomb`)
  }
  return entries
}

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => {
      if (error) reject(new Error(`OOXML 解压失败：${error.message}`))
      else resolve(data)
    })
  })
}

/* ---- Worker 化解压 ---- */

interface OoxmlZipRequest {
  id: number
  bytes: ArrayBuffer
}

interface OoxmlZipSuccess {
  id: number
  ok: true
  files: { name: string; data: Uint8Array }[]
}

interface OoxmlZipFailure {
  id: number
  ok: false
  error: string
}

type OoxmlZipResponse = OoxmlZipSuccess | OoxmlZipFailure

/** Worker 基础设施失败（如 CSP 限制）时的标记错误；调用方据此回退主线程。 */
export class OoxmlWorkerUnavailableError extends Error {
  constructor() {
    super('OOXML 解压 Worker 不可用')
    this.name = 'OoxmlWorkerUnavailableError'
  }
}

const pending = new Map<number, {
  resolve: (value: Record<string, Uint8Array>) => void
  reject: (reason: Error) => void
}>()
let sharedWorker: Worker | null | undefined
let requestSequence = 0

function workerAvailable(): boolean {
  return typeof Worker !== 'undefined' && import.meta.env.MODE !== 'test'
}

function getOoxmlWorker(): Worker | null {
  if (sharedWorker !== undefined) return sharedWorker
  sharedWorker = null
  try {
    const worker = new Worker(new URL('./ooxmlWorker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<OoxmlZipResponse>) => {
      const task = pending.get(event.data.id)
      if (!task) return
      pending.delete(event.data.id)
      if (event.data.ok) task.resolve(Object.fromEntries(event.data.files.map((file) => [file.name, file.data])))
      else task.reject(new Error(event.data.error))
    })
    worker.addEventListener('error', () => {
      // 加载失败时释放共享实例并让等待中的任务回退主线程；下次调用会重试创建。
      sharedWorker = undefined
      const waiting = [...pending.values()]
      pending.clear()
      for (const task of waiting) task.reject(new OoxmlWorkerUnavailableError())
    })
    sharedWorker = worker
  } catch {
    sharedWorker = null
  }
  return sharedWorker
}

function runInWorker(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const worker = getOoxmlWorker()
  if (!worker) return Promise.reject(new OoxmlWorkerUnavailableError())
  return new Promise((resolve, reject) => {
    const id = ++requestSequence
    pending.set(id, { resolve, reject })
    // 复制后 transfer：主线程回退路径仍需要原始 bytes 完好。
    const copy = bytes.slice()
    worker.postMessage({ id, bytes: copy.buffer } satisfies OoxmlZipRequest, [copy.buffer])
  })
}

/**
 * OOXML 统一解压入口：先做中央目录安全检查，再尽量在 Worker 中解压。
 * Worker 不可用时回退主线程；文件本身的解析错误直接透传，不做静默重试。
 */
export async function unzipOoxml(
  bytes: Uint8Array,
  label: string,
  requiredEntries: string[],
): Promise<Record<string, Uint8Array>> {
  inspectOoxmlArchive(bytes, { label, requiredEntries })
  if (workerAvailable()) {
    try {
      return await runInWorker(bytes)
    } catch (reason) {
      if (!(reason instanceof OoxmlWorkerUnavailableError)) throw reason
    }
  }
  return unzipAsync(bytes)
}

/* ---- XML 工具（主线程；DOMParser 在 Worker 中不可用） ---- */

export function localName(value: Element): string {
  return (value.localName || value.tagName).replace(/^.*:/, '')
}

export function elements(root: ParentNode, name: string): Element[] {
  const expected = name.toLowerCase()
  return Array.from(root.querySelectorAll('*')).filter((element) => localName(element).toLowerCase() === expected)
}

export function attribute(element: Element | undefined, name: string): string {
  if (!element) return ''
  const expected = name.toLowerCase()
  const found = Array.from(element.attributes).find((item) => (
    item.localName || item.name
  ).replace(/^.*:/, '').toLowerCase() === expected)
  return found?.value ?? ''
}

const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** 读取 r:id 类关系属性；sldId 同时有 id 与 r:id，必须区分开，不能取到普通 id。 */
export function relationshipId(element: Element): string {
  const found = Array.from(element.attributes).find((item) => {
    const local = (item.localName || item.name).replace(/^.*:/, '').toLowerCase()
    if (local !== 'id') return false
    // 部分运行环境（如 happy-dom）解析 XML 属性时 namespaceURI 为空，回退按前缀匹配。
    return item.namespaceURI === RELATIONSHIP_NS || /^r:id$/i.test(item.name)
  })
  return found?.value ?? ''
}

export function parseOoxmlXml(xml: string, label: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`${label} 包含不允许的 XML 实体声明`)
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (elements(document, 'parsererror').length) throw new Error(`${label} XML 已损坏`)
  return document
}
