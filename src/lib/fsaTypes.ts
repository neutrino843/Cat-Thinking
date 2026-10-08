/**
 * M10：File System Access API 最小类型子集（PRD 4.3 单文件 .msz 模式）。
 *
 * TS 5.5 的 lib.dom 未完整包含 showSaveFilePicker / FileSystemFileHandle 的
 * 权限与 createWritable 签名，这里只声明本项目实际用到的成员（结构化类型，
 * Playwright 注入的 mock 句柄只需形状匹配即可）。
 * 参考：https://developer.mozilla.org/docs/Web/API/File_System_Access_API
 */

export interface MSZFileSystemWritable {
  write(data: string | Blob | BufferSource): Promise<void>
  close(): Promise<void>
}

export interface MSZFileHandle {
  kind: 'file'
  name: string
  /** 读取文件内容（打开 .msz） */
  getFile(): Promise<File>
  /** 创建可写流（覆盖保存 .msz） */
  createWritable(): Promise<MSZFileSystemWritable>
  /** 查询句柄权限（持久化句柄重开页面后可能为 'prompt'） */
  queryPermission(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  /** 请求授权；必须在用户手势（如 Ctrl+S 点击）内调用 */
  requestPermission(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

export interface MSZFilePickerType {
  description?: string
  accept: Record<string, string[]>
}

interface FSA {
  showSaveFilePicker: (opts?: {
    suggestedName?: string
    types?: MSZFilePickerType[]
  }) => Promise<MSZFileHandle>
  showOpenFilePicker: (opts?: {
    multiple?: boolean
    types?: MSZFilePickerType[]
  }) => Promise<MSZFileHandle[]>
}

/**
 * 取浏览器的 File System Access API；不支持（Firefox/Safari 旧版）或非窗口环境
 * 返回 null，调用方降级到普通「导入/导出文件」流程。
 */
export function getFSA(): FSA | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    showSaveFilePicker?: unknown
    showOpenFilePicker?: unknown
  }
  if (typeof w.showSaveFilePicker !== 'function' || typeof w.showOpenFilePicker !== 'function') {
    return null
  }
  return {
    showSaveFilePicker: (w.showSaveFilePicker as FSA['showSaveFilePicker']).bind(window),
    showOpenFilePicker: (w.showOpenFilePicker as FSA['showOpenFilePicker']).bind(window),
  }
}
