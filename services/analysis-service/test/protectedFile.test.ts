import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const modulePath = pathToFileURL(resolve('scripts/protected-file.mjs')).href
const { writeProtectedJson } = await import(modulePath) as { writeProtectedJson(path: string, value: unknown): Promise<void> }
const pathModule = pathToFileURL(resolve('scripts/protected-path-identity.mjs')).href
const { isOutsideCheckout, protectedPathIdentity } = await import(pathModule) as {
  isOutsideCheckout(checkout: string, path: string): boolean
  protectedPathIdentity(path: string, platform?: string): string
}
const owned: string[] = []
afterEach(async () => {
  for (const path of owned.splice(0)) {
    if (!path.startsWith(join(tmpdir(), 'cat-protected-file-'))) throw new Error('unexpected_test_cleanup_path')
    await rm(path, { recursive: true, force: true })
  }
})
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'cat-protected-file-'))
  owned.push(path)
  return path
}

describe('protected checkpoint publication', () => {
  it('rejects dot-prefixed checkout children and normalizes protected path aliases', () => {
    const root = resolve(tmpdir(), 'synthetic-checkout')
    for (const path of [root, join(root, 'keys'), join(root, '..keys', 'private.pem'), join(root, 'sub', '..', 'private.pem')]) {
      expect(isOutsideCheckout(root, path)).toBe(false)
    }
    expect(isOutsideCheckout(root, resolve(root, '..', 'external-private.pem'))).toBe(true)
    expect(protectedPathIdentity(join(root, 'sub', '..', 'key.pem'))).toBe(protectedPathIdentity(join(root, 'key.pem')))
    expect(protectedPathIdentity(join(root, 'KEY.PEM'), 'win32')).toBe(protectedPathIdentity(join(root, 'key.pem'), 'win32'))
  })
  it('publishes and replaces a complete parseable checkpoint without temporary remnants', async () => {
    const root = await directory()
    const path = join(root, 'checkpoint.json')
    await writeProtectedJson(path, { version: 1, execution: 'synthetic', phase: 'validated' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, execution: 'synthetic', phase: 'validated' })
    await writeProtectedJson(path, { version: 1, execution: 'synthetic', phase: 'cleaned' })
    expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('cleaned')
    expect(await readdir(root)).toEqual(['checkpoint.json'])
  })
  it('leaves an existing checkpoint intact when serialization fails', async () => {
    const root = await directory()
    const path = join(root, 'checkpoint.json')
    await writeProtectedJson(path, { prior: true })
    const circular: Record<string, unknown> = {}; circular.self = circular
    await expect(writeProtectedJson(path, circular)).rejects.toThrow()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ prior: true })
    expect(await readdir(root)).toEqual(['checkpoint.json'])
  })
  it('cleans its own temporary output on failed publication', async () => {
    const root = await directory()
    const path = join(root, 'occupied')
    await mkdir(path)
    await expect(writeProtectedJson(path, { synthetic: true })).rejects.toThrow()
    expect(await readdir(root)).toEqual(['occupied'])
    await expect(writeProtectedJson('relative.json', {})).rejects.toThrow('protected_output_path_invalid')
  })
})
