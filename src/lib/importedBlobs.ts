import { BLOB_QUOTA_BYTES } from '../store/db'

class ImportedBlobQuotaError extends Error {
  constructor() { super('文档附件总量超过 64MB。') }
}

/** Percent escapes represent bytes, not Unicode code points or an assumed charset. */
function decodePercentBytes(payload: string, limit: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(Math.min(payload.length * 3, limit + 1))
  const encoder = new TextEncoder()
  let written = 0
  for (let index = 0; index < payload.length;) {
    if (payload[index] === '%') {
      const hex = payload.slice(index + 1, index + 3)
      if (!/^[\da-f]{2}$/i.test(hex)) throw new URIError('Invalid percent escape')
      output[written++] = Number.parseInt(hex, 16)
      index += 3
    } else {
      const next = payload.indexOf('%', index)
      const end = next === -1 ? payload.length : next
      const encoded = encoder.encodeInto(payload.slice(index, end), output.subarray(written))
      written += encoded.written
      if (encoded.read !== end - index) throw new ImportedBlobQuotaError()
      index = end
    }
    if (written > limit) throw new ImportedBlobQuotaError()
  }
  return output.subarray(0, written)
}

/** Native backups contain inline data only. Import never fetches a supplied URL. */
export function decodeImportedBlobs(input: unknown): Map<string, Blob> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('附件备份格式无效。')
  const result = new Map<string, Blob>()
  let total = 0
  for (const [id, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('附件备份格式无效。')
    const meta = value as Record<string, unknown>
    if (!id || typeof meta.dataURL !== 'string' || meta.dataURL.length > BLOB_QUOTA_BYTES * 2) throw new Error('附件备份格式或大小无效。')
    const match = /^data:([^,]*),([\s\S]*)$/.exec(meta.dataURL)
    if (!match) throw new Error('附件备份只能包含内嵌 data URL。')
    const base64 = /;base64$/i.test(match[1])
    const mediaType = base64 ? match[1].slice(0, -';base64'.length) : match[1]
    let bytes: Uint8Array<ArrayBuffer>
    try {
      if (base64) {
        const encoded = match[2].replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        const binary = atob(encoded)
        if (binary.length > BLOB_QUOTA_BYTES - total) throw new ImportedBlobQuotaError()
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      } else bytes = decodePercentBytes(match[2], BLOB_QUOTA_BYTES - total)
    } catch (error) {
      if (error instanceof ImportedBlobQuotaError) throw error
      throw new Error('附件备份编码无效。', { cause: error })
    }
    total += bytes.byteLength
    if (total > BLOB_QUOTA_BYTES) throw new Error('文档附件总量超过 64MB。')
    result.set(id, new Blob([bytes], { type: mediaType || 'application/octet-stream' }))
  }
  return result
}
