import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AesGcmContentCipher,
  decodeContentEncryptionKey,
  sourcePartEncryptionContext,
} from '../src/infrastructure/contentCipher.js'

describe('source content encryption', () => {
  it('round-trips UTF-8 content with authenticated context and random IVs', () => {
    const cipher = new AesGcmContentCipher(randomBytes(32))
    const context = sourcePartEncryptionContext('tenant-1', 'run-1', 'source-1', 0)
    const first = cipher.encrypt('机密🌱正文', context)
    const second = cipher.encrypt('机密🌱正文', context)

    expect(cipher.decrypt(first, context)).toBe('机密🌱正文')
    expect(first.ciphertext.equals(Buffer.from('机密🌱正文', 'utf8'))).toBe(false)
    expect(first.iv.equals(second.iv)).toBe(false)
    expect(() => cipher.decrypt(first, `${context}:wrong`)).toThrow()
  })

  it('accepts only canonical base64 encoding of exactly 32 bytes', () => {
    const encoded = Buffer.alloc(32, 7).toString('base64')
    expect(decodeContentEncryptionKey(encoded)).toHaveLength(32)
    expect(() => decodeContentEncryptionKey('not-base64')).toThrow(/canonical base64/)
    expect(() => decodeContentEncryptionKey(Buffer.alloc(31).toString('base64'))).toThrow(/canonical base64/)
  })

  it('rejects invalid constructor keys and unknown key identifiers', () => {
    expect(() => new AesGcmContentCipher(Buffer.alloc(31))).toThrow(/32 bytes/)
    const cipher = new AesGcmContentCipher(Buffer.alloc(32, 3))
    const encrypted = cipher.encrypt('content', 'context')
    expect(() => cipher.decrypt({ ...encrypted, keyId: 'retired-key' }, 'context')).toThrow(/unknown/)
  })
})
