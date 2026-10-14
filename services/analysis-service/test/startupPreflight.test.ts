// @vitest-environment node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const { describeStartup, inspectStartup, supportsLocalNodeVersion } = await import(pathToFileURL(resolve('scripts/startup-preflight.mjs')).href)

describe('safe startup diagnostics', () => {
  it('accepts the complete toolchain versions and rejects unsupported versions without pretending dependencies are missing', () => {
    for (const version of ['24.13.1', '24.13.2', '24.14.0']) expect(supportsLocalNodeVersion(version)).toBe(true)
    for (const version of ['18.20.0', '20.19.0', '22.13.0', '23.0.0', '24.13.0', '25.0.0', '26.0.0', '24.0.0-rc.1', 'invalid']) expect(supportsLocalNodeVersion(version)).toBe(false)
  })

  it('checks portable Chinese paths and declared dependencies without opening credentials or starting services', () => {
    const reads: string[] = []
    const root = resolve('中文路径', '猫思之')
    const lookup = vi.fn()
    const result = inspectStartup({ root, nodeVersion: '24.13.1', exists: () => true,
      read: (path: string) => { reads.push(path); return JSON.stringify({ dependencies: { react: '1', '@cat-thinking/analysis-contracts': '1' }, devDependencies: { typescript: '1' } }) },
      resolveDependency: lookup })
    expect(result.failures).toEqual([])
    expect(reads).toEqual([resolve(root, 'package.json'), resolve(root, 'services/analysis-service/package.json')])
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['react', 'typescript'])
    expect(describeStartup(result).join('\n')).toContain('不会启动数据库或调用 AI')
  })

  it('reports missing dependencies with manual npm.cmd instructions and omits the underlying error', () => {
    const result = inspectStartup({ exists: () => true, nodeVersion: '24.13.1',
      read: () => JSON.stringify({ dependencies: { react: '1' } }),
      resolveDependency: () => { throw new Error('sk-private source-content provider-response') } })
    expect(result.failures).toEqual(['dependencies'])
    const text = describeStartup(result).join('\n')
    expect(text).toContain('npm.cmd ci')
    expect(text).not.toMatch(/sk-private|source-content|provider-response/u)
  })

  it('distinguishes incomplete project files from an unsupported Node version', () => {
    const read = vi.fn()
    expect(inspectStartup({ exists: () => false, read, nodeVersion: '20.18.0' }).failures).toEqual(['node_version', 'project_files'])
    expect(read).not.toHaveBeenCalled()
  })

  it('reports corrupt package metadata without exposing its contents or throwing a raw exception', () => {
    for (const contents of ['null', '[]', 'private-invalid-package-contents']) {
      const result = inspectStartup({ exists: () => true, nodeVersion: '24.13.1', read: () => contents })
      expect(result.failures).toEqual(['project_files'])
      expect(describeStartup(result).join('\n')).not.toContain(contents)
    }
  })
})
