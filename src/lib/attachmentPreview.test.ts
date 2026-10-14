import { describe, expect, it } from 'vitest'
import { canPreviewAttachment, createAttachmentPreviewBlob } from './attachmentPreview'

describe('attachment preview execution boundary', () => {
  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'application/octet-stream', '', 'image/x-unknown'])('keeps %s downloadable without creating a preview Blob', async (mime) => {
    expect(canPreviewAttachment(mime)).toBe(false)
    expect(await createAttachmentPreviewBlob(new Blob(['<script>indexedDB.open("maosizhi")</script>'], { type: mime }))).toBeNull()
  })

  it.each([
    ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
    ['image/jpeg', [255, 216, 255, 224]],
    ['image/gif', [71, 73, 70, 56, 55, 97]],
    ['image/gif', [71, 73, 70, 56, 57, 97]],
    ['image/webp', [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ] as const)('copies recognizable %s bytes into an immutable canonical preview', async (mime, signature) => {
    const source = new Blob([new Uint8Array(signature)], { type: mime })
    const preview = await createAttachmentPreviewBlob(source)
    expect(canPreviewAttachment(mime)).toBe(true)
    expect(preview).not.toBe(source)
    expect(preview?.type).toBe(mime)
    expect(await preview!.arrayBuffer()).toEqual(await source.arrayBuffer())
  })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('rejects active bytes under a forged %s MIME', async (mime) => {
    expect(await createAttachmentPreviewBlob(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>indexedDB.open("maosizhi")</script></svg>'], { type: mime }))).toBeNull()
    expect(await createAttachmentPreviewBlob(new Blob([], { type: mime }))).toBeNull()
  })

  it('normalizes MIME parameters without using attacker-supplied attachment metadata', async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'IMAGE/PNG;charset=binary' })
    expect(canPreviewAttachment(' IMAGE/PNG;charset=binary')).toBe(true)
    expect((await createAttachmentPreviewBlob(blob))?.type).toBe('image/png')
    expect(await createAttachmentPreviewBlob(new Blob([await blob.arrayBuffer()], { type: 'image/jpeg' }))).toBeNull()
  })
})
