const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Preview eligibility is deliberately narrower than the set of downloadable attachments. */
export function canPreviewAttachment(mime: string): boolean {
  return RASTER_TYPES.has(mime.split(';', 1)[0].trim().toLowerCase())
}

const beginsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte)

/** Never navigate to an executable or sniffable imported Blob, even when metadata says “image”. */
export async function createAttachmentPreviewBlob(blob: Blob): Promise<Blob | null> {
  const mime = blob.type.split(';', 1)[0].trim().toLowerCase()
  if (!canPreviewAttachment(mime)) return null
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const valid = mime === 'image/png' ? beginsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
    : mime === 'image/jpeg' ? beginsWith(bytes, [255, 216, 255])
    : mime === 'image/gif' ? beginsWith(bytes, [71, 73, 70, 56, 55, 97]) || beginsWith(bytes, [71, 73, 70, 56, 57, 97])
    : beginsWith(bytes, [82, 73, 70, 70]) && beginsWith(bytes.subarray(8), [87, 69, 66, 80])
  return valid ? blob.slice(0, blob.size, mime) : null
}
