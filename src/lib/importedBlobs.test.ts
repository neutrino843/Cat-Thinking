import { describe, expect, it, vi } from 'vitest'
import { decodeImportedBlobs } from './importedBlobs'

vi.mock('../store/db', () => ({ BLOB_QUOTA_BYTES: 64 }))

describe('inline native backup attachments', () => {
  it('decodes base64 and percent-encoded content without fetching a URL', async () => {
    const decoded = decodeImportedBlobs({ binary: { dataURL: 'data:application/octet-stream;base64,AQID' }, text: { dataURL: 'data:text/plain,%E4%B8%AD%E6%96%87' } })
    expect([...new Uint8Array(await decoded.get('binary')!.arrayBuffer())]).toEqual([1, 2, 3])
    expect(await decoded.get('text')!.text()).toBe('中文')
    expect(decoded.get('text')!.type).toBe('text/plain')
    expect(decodeImportedBlobs({})).toEqual(new Map())
    expect(decodeImportedBlobs({ empty: { dataURL: 'data:,plain' } }).get('empty')?.type).toBe('application/octet-stream')
  })

  it.each([null, [], 'invalid', { item: null }, { item: [] }, { item: 'invalid' }, { item: {} }, { '': { dataURL: 'data:,x' } }])('rejects malformed metadata %j', (input) => {
    expect(() => decodeImportedBlobs(input)).toThrow(/格式/)
  })

  it.each(['https://external.invalid/private', 'http://external.invalid/private', 'file:///private/file', 'data:text/plain;base64,not valid!', 'data:text/plain,%XX'])('rejects remote URLs or malformed encodings %s', (dataURL) => {
    expect(() => decodeImportedBlobs({ item: { dataURL } })).toThrow(/data URL|编码/)
  })

  it('bounds encoded input and total decoded attachment bytes before a document write', () => {
    expect(() => decodeImportedBlobs({ item: { dataURL: 'data:,' + 'x'.repeat(130) } })).toThrow(/大小/)
    const dataURL = 'data:;base64,' + btoa('x'.repeat(40))
    expect(() => decodeImportedBlobs({ first: { dataURL }, second: { dataURL } })).toThrow(/总量/)
  })

  it('round-trips exported MIME parameters and treats unknown parameters as inline metadata', async () => {
    const decoded = decodeImportedBlobs({
      base64: { dataURL: 'data:text/plain;charset=utf-8;base64,5Lit5paH' },
      percent: { dataURL: 'data:text/plain;charset=utf-8,%E4%B8%AD%E6%96%87' },
      parameter: { dataURL: 'data:text/plain;x-custom=metadata;BASE64,aW5saW5l' },
    })
    expect(await decoded.get('base64')!.text()).toBe('中文')
    expect(await decoded.get('percent')!.text()).toBe('中文')
    expect(decoded.get('base64')!.type).toBe('text/plain;charset=utf-8')
    expect(decoded.get('percent')!.type).toBe('text/plain;charset=utf-8')
    expect(await decoded.get('parameter')!.text()).toBe('inline')
    expect(decoded.get('parameter')!.type).toBe('text/plain;x-custom=metadata')
  })

  it('preserves raw non-UTF8 percent bytes and percent-escaped base64 characters exactly', async () => {
    const blobs = decodeImportedBlobs({
      binary: { dataURL: 'data:application/octet-stream,%89%FF%00PNG%0D%0A' },
      latin: { dataURL: 'data:text/plain;charset=iso-8859-1,%E9' },
      base64: { dataURL: 'data:application/octet-stream;base64,%2Fw%3D%3D' },
      mixed: { dataURL: 'data:text/plain,文%FF😀%00' },
    })
    expect([...new Uint8Array(await blobs.get('binary')!.arrayBuffer())]).toEqual([137, 255, 0, 80, 78, 71, 13, 10])
    expect([...new Uint8Array(await blobs.get('latin')!.arrayBuffer())]).toEqual([233])
    expect([...new Uint8Array(await blobs.get('base64')!.arrayBuffer())]).toEqual([255])
    expect([...new Uint8Array(await blobs.get('mixed')!.arrayBuffer())]).toEqual([...new TextEncoder().encode('文'), 255, ...new TextEncoder().encode('😀'), 0])
  })

  it('enforces the decoded-byte quota for percent input and rejects incomplete escapes', () => {
    expect(() => decodeImportedBlobs({ first: { dataURL: 'data:,' + 'x'.repeat(50) }, second: { dataURL: 'data:,' + '%FF'.repeat(20) } })).toThrow(/总量/)
    expect(() => decodeImportedBlobs({ first: { dataURL: 'data:,' + 'x'.repeat(50) }, second: { dataURL: 'data:,' + 'x'.repeat(20) } })).toThrow(/总量/)
    expect(() => decodeImportedBlobs({ incomplete: { dataURL: 'data:,%A' } })).toThrow(/编码/)
    expect(() => decodeImportedBlobs({ incomplete: { dataURL: 'data:;base64,YQ%3' } })).toThrow(/编码/)
  })
})
