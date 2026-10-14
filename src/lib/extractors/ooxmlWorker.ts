import { unzipSync } from 'fflate'
import { inspectOoxmlArchive } from './ooxmlShared'

/**
 * OOXML 解压 Worker：安全检查与 CPU 重的解压都移出主线程。
 * XML 结构化解析仍回主线程（DOMParser 在 Worker 中不可用），传输的只是解压后的 XML 字符串源字节。
 */

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

const workerScope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<OoxmlZipRequest>) => void): void
  postMessage(message: OoxmlZipSuccess | OoxmlZipFailure, transfer?: Transferable[]): void
}

workerScope.addEventListener('message', (event) => {
  const { id, bytes } = event.data
  try {
    const view = new Uint8Array(bytes)
    // 归档完整性已在主线程检查过；Worker 侧复查以防御非受信调用方。
    inspectOoxmlArchive(view, { label: 'OOXML', requiredEntries: [] })
    const entries = unzipSync(view)
    const transfer: ArrayBuffer[] = []
    const seen = new Set<ArrayBuffer>()
    const files = Object.entries(entries).map(([name, data]) => {
      const buffer = data.buffer as ArrayBuffer
      if (seen.has(buffer)) return { name, data: new Uint8Array(data) }
      seen.add(buffer)
      transfer.push(buffer)
      return { name, data }
    })
    workerScope.postMessage({ id, ok: true, files }, transfer)
  } catch (reason) {
    workerScope.postMessage({
      id,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    })
  }
})
