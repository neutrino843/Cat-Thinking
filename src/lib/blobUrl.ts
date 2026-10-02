import { getBlob } from '../store/db'

/** blobId → objectURL 内存缓存，避免重复 createObjectURL 与内存泄漏 */
const urlCache = new Map<string, string>()

/** 正在进行的 getBlob Promise 缓存，防并发重复请求 */
const inflight = new Map<string, Promise<string>>()

/**
 * 获取 blob 对应的 objectURL，命中缓存直接返回；否则从 IndexedDB 取出并创建。
 * 调用方不主动 revoke，由 revokeBlobURL / revokeAllBlobURLs 统一管理生命周期。
 */
export function getBlobURL(blobId: string): Promise<string> {
  const cached = urlCache.get(blobId)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(blobId)
  if (pending) return pending
  const p = (async () => {
    const blob = await getBlob(blobId)
    if (!blob) throw new Error('blob not found: ' + blobId)
    const url = URL.createObjectURL(blob)
    urlCache.set(blobId, url)
    return url
  })()
  inflight.set(blobId, p)
  // 修审计 M-2：成功或失败都清掉 inflight——旧实现失败时缓存 rejected promise，
  // 后续调用永远拿到同一个 rejection，无法重试
  p.then(
    () => inflight.delete(blobId),
    () => inflight.delete(blobId),
  )
  return p
}

/** 同步查询缓存中已有的 objectURL（导出时用于 blob→dataURL 替换，未命中返回 undefined） */
export function getCachedBlobURL(blobId: string): string | undefined {
  return urlCache.get(blobId)
}

/** 释放单个 blob 的 objectURL（删除图片/附件时调用） */
export function revokeBlobURL(blobId: string) {
  const url = urlCache.get(blobId)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(blobId)
  }
}

/** 切换文档或卸载时释放全部缓存 URL */
export function revokeAllBlobURLs() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  inflight.clear()
}
