import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedContent {
  readonly keyId: string
  readonly iv: Buffer
  readonly authTag: Buffer
  readonly ciphertext: Buffer
}

export interface ContentCipher {
  encrypt(plaintext: string, context: string): EncryptedContent
  decrypt(content: EncryptedContent, context: string): string
}

const ALGORITHM = 'aes-256-gcm'
const KEY_ID = 'primary-v1'

export class AesGcmContentCipher implements ContentCipher {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.byteLength !== 32) throw new TypeError('content encryption key must be 32 bytes')
    this.key = Buffer.from(key)
  }

  encrypt(plaintext: string, context: string): EncryptedContent {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    cipher.setAAD(Buffer.from(context, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return { keyId: KEY_ID, iv, authTag: cipher.getAuthTag(), ciphertext }
  }

  decrypt(content: EncryptedContent, context: string): string {
    if (content.keyId !== KEY_ID) throw new Error('unknown content encryption key id')
    const decipher = createDecipheriv(ALGORITHM, this.key, content.iv)
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(content.authTag)
    return Buffer.concat([decipher.update(content.ciphertext), decipher.final()]).toString('utf8')
  }
}

export const decodeContentEncryptionKey = (encoded: string): Buffer => {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new TypeError('content encryption key must be canonical base64 for exactly 32 bytes')
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== encoded) {
    throw new TypeError('content encryption key must be canonical base64 for exactly 32 bytes')
  }
  return key
}

export const sourcePartEncryptionContext = (
  tenantId: string,
  runId: string,
  sourceId: string,
  partIndex: number,
): string => `cat-analysis-source-v1:${tenantId}:${runId}:${sourceId}:${partIndex}`
