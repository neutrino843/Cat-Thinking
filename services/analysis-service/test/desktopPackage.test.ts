// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, cp, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zipSync } from 'fflate'

const exec = promisify(execFile)
const root = resolve('.')
const { safeChild, verifyPayload, fileDigest, runtimeDependencyGraph } = await import(pathToFileURL(join(root, 'scripts/desktop/package.mjs')).href)
const { sealBackup, unsealBackup, packBackupEntries, validateBackupEntries } = await import(pathToFileURL(join(root, 'scripts/desktop/backup.mjs')).href)
const { validateDatabaseConfiguration, serviceEnvironment, readDesktopJson } = await import(pathToFileURL(join(root, 'scripts/desktop/runtime.mjs')).href)

const configuration = () => ({ version: 1, host: '127.0.0.1', port: 55435, admin: { user: 'cat_analysis_admin', password: 'a'.repeat(43) },
  databases: { local: { name: 'cat_analysis_local', user: 'cat_analysis_local', password: 'b'.repeat(43) } },
  contentEncryptionKey: Buffer.alloc(32, 1).toString('base64'), serviceToken: 'c'.repeat(43) })
const password = 'synthetic-backup-password'
async function temporary<T>(work: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'cat-desktop-package-test-'))
  try { return await work(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
async function fixturePayload(directory: string, release = '1.0.0') {
  await mkdir(directory, { recursive: true })
  const content = { 'runtime/node.exe': Buffer.from('synthetic executable placeholder, never launched'), 'dist/index.html': Buffer.from('<html>synthetic local fixture</html>') }
  const files = []
  for (const [path, bytes] of Object.entries(content)) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), bytes); files.push({ path, bytes: bytes.length, sha256: fileDigest(bytes) }) }
  const manifest = { version: 1, application: 'cat-thinking', release, files, signed: false, cleanWindowsVerified: false }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { content, manifest }
}
async function fixtureInstaller(directory: string, release: string) {
  const { content, manifest } = await fixturePayload(join(directory, 'payload'), release)
  const archive = Buffer.from(zipSync(Object.fromEntries([...Object.entries(content).map(([path, bytes]) => [`payload/${path}`, bytes]),
    ['payload/manifest.json', Buffer.from(JSON.stringify(manifest))]])))
  await writeFile(join(directory, 'payload.zip'), archive)
  await writeFile(join(directory, 'payload.sha256'), `${fileDigest(archive)}  payload.zip`)
  for (const file of ['install.ps1', 'launch.ps1', 'uninstall.ps1']) await cp(join(root, 'scripts/desktop', file), join(directory, file))
}

describe('Windows desktop payload integrity and dependency boundaries', () => {
  it.each(['../escape', '/absolute', 'C:/drive', 'dir\\file', 'dir/../file', 'dir//file', ''])('rejects escaping payload path %s', (path) => {
    expect(() => safeChild(root, path)).toThrow()
  })
  it('verifies every file then refuses corruption or unlisted additions', async () => temporary(async (directory) => {
    await fixturePayload(directory)
    expect(await verifyPayload(directory)).toMatchObject({ application: 'cat-thinking', cleanWindowsVerified: false })
    await writeFile(join(directory, 'foreign.env'), 'synthetic-private-setting')
    await expect(verifyPayload(directory)).rejects.toThrow('unlisted')
    await rm(join(directory, 'foreign.env'))
    await writeFile(join(directory, 'dist/index.html'), 'tampered')
    await expect(verifyPayload(directory)).rejects.toThrow('hash_mismatch')
  }))
  it('collects only server runtime dependency closure and explicit ZIP support', async () => {
    const graph = await runtimeDependencyGraph(root)
    expect([...graph.keys()]).toEqual(expect.arrayContaining(['fastify', 'pg', 'zod', 'fflate']))
    for (const developmentTool of ['vite', 'typescript', 'vitest', '@playwright/test', 'react']) expect(graph.has(developmentTool)).toBe(false)
  })
  it('preserves encryption keys and rejects invalid existing configuration instead of generating replacements', () => {
    const config = configuration()
    expect(validateDatabaseConfiguration(config)).toBe(config)
    expect(() => validateDatabaseConfiguration({ ...config, contentEncryptionKey: '' })).toThrow('no_key_regeneration')
    expect(() => validateDatabaseConfiguration({ ...config, host: 'remote.example.com' })).toThrow()
    const env = serviceEnvironment(config, { servicePort: 53014, frontendUrl: 'http://127.0.0.1:53013' }, true)
    expect(env).toMatchObject({ ANALYSIS_CONTENT_ENCRYPTION_KEY: config.contentEncryptionKey, ANALYSIS_PERSONAL_READ_ONLY: 'true', ANALYSIS_PROVIDER_MODE: 'disabled' })
  })
  it('reads Windows PowerShell UTF-8 BOM metadata correctly', async () => temporary(async (directory) => {
    const path = join(directory, 'owner.json'); await writeFile(path, '\uFEFF{"version":1}')
    expect(await readDesktopJson(path)).toEqual({ version: 1 })
  }))
})

describe('password-protected database and user-confirmed course backup', () => {
  it('roundtrips an authenticated encrypted bundle and rejects wrong passwords and changed bytes', async () => {
    const raw = packBackupEntries({ 'database.dump': Buffer.from('synthetic postgres dump'), 'database.json': Buffer.from(JSON.stringify(configuration())),
      'courses/0000.mszcourse': Buffer.from('opaque course bundle; no password extracted') }, { scopeConfirmed: true, expectedCourseCount: 1 })
    const protectedBytes = await sealBackup(raw, password)
    expect(protectedBytes.includes(Buffer.from('synthetic postgres dump'))).toBe(false)
    const opened = validateBackupEntries(await unsealBackup(protectedBytes, password))
    expect(opened.manifest.courseIndex.expectedCourseCount).toBe(1)
    expect(opened.manifest.browserCollectedAutomatically).toBe(false)
    expect(opened.manifest.unorganizedBrowserDocumentsExcluded).toBe(true)
    expect(Buffer.from(opened.entries['database.json']).toString('utf8')).toContain(configuration().contentEncryptionKey)
    await expect(unsealBackup(protectedBytes, 'wrong-password-123')).rejects.toThrow('wrong_password_or_corrupt')
    const changed = Buffer.from(protectedBytes); changed[changed.length - 17] ^= 1
    await expect(unsealBackup(changed, password)).rejects.toThrow('wrong_password_or_corrupt')
    await expect(sealBackup(raw, 'short')).rejects.toThrow('minimum_10')
  })
  it('requires scope confirmation and all counted course files, includes keys and refuses foreign paths', () => {
    const entries = { 'database.dump': Buffer.from('dump'), 'database.json': Buffer.from(JSON.stringify(configuration())) }
    expect(() => packBackupEntries(entries, { scopeConfirmed: false, expectedCourseCount: 0 })).toThrow('confirmation_required')
    expect(() => packBackupEntries(entries, { scopeConfirmed: true, expectedCourseCount: 1 })).toThrow('confirmation_required')
    expect(() => packBackupEntries({ 'database.dump': Buffer.from('dump') }, { scopeConfirmed: true, expectedCourseCount: 0 })).toThrow('keys_required')
    const foreign = zipSync({ '../private.json': Buffer.from('not accepted') })
    expect(() => validateBackupEntries(foreign)).toThrow('entry_invalid')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows installer and preserved data upgrade', () => {
  it('installs versions separately, refuses a running PID, upgrades without replacing data, and uninstalls with data kept', async () => temporary(async (directory) => {
    const first = join(directory, 'first'), second = join(directory, 'second')
    await fixtureInstaller(first, '1.0.0'); await fixtureInstaller(second, '1.1.0')
    const program = join(directory, 'program'), data = join(directory, 'data')
    const install = (packageRoot: string) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(packageRoot, 'install.ps1'),
      '-InstallRoot', program, '-DataRoot', data, '-SkipShortcuts'], { windowsHide: true, timeout: 30000 })
    await install(first)
    await mkdir(join(data, 'secrets')); await writeFile(join(data, 'secrets/database.json'), 'synthetic existing encryption key')
    await writeFile(join(data, 'app.lock'), JSON.stringify({ pid: process.pid }))
    await expect(install(second)).rejects.toThrow()
    expect((await readDesktopJson(join(program, 'current.json'))).release).toBe('1.0.0')
    await rm(join(data, 'app.lock'))
    await install(second)
    expect((await readDesktopJson(join(program, 'current.json'))).release).toBe('1.1.0')
    expect((await readDesktopJson(join(data, 'pause-provider.json'))).pause).toBe(true)
    expect(await readFile(join(data, 'secrets/database.json'), 'utf8')).toBe('synthetic existing encryption key')
    await access(join(program, 'versions/1.0.0/runtime/node.exe'))
    await access(join(program, 'versions/1.1.0/runtime/node.exe'))
    await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(program, 'uninstall.ps1'), '-SkipShortcuts'], { windowsHide: true, timeout: 30000 })
    expect(await readFile(join(data, 'secrets/database.json'), 'utf8')).toBe('synthetic existing encryption key')
    await expect(access(join(program, 'versions'))).rejects.toThrow()
  }), 60000)
  it('rejects installation into the data directory and unsafe ZIP entries without touching prior data', async () => temporary(async (directory) => {
    await fixtureInstaller(join(directory, 'package'), '1.0.0')
    const protectedDirectory = join(directory, 'preserve'); await mkdir(protectedDirectory); await writeFile(join(protectedDirectory, 'keep.txt'), 'keep')
    await expect(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'package/install.ps1'),
      '-InstallRoot', protectedDirectory, '-DataRoot', protectedDirectory, '-SkipShortcuts'], { windowsHide: true })).rejects.toThrow()
    expect(await readFile(join(protectedDirectory, 'keep.txt'), 'utf8')).toBe('keep')
    const maliciousZip = Buffer.from(zipSync({ 'payload/../escape.txt': Buffer.from('unsafe') }))
    await writeFile(join(directory, 'package/payload.zip'), maliciousZip)
    await writeFile(join(directory, 'package/payload.sha256'), `${fileDigest(maliciousZip)}  payload.zip`)
    await expect(exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'package/install.ps1'),
      '-InstallRoot', join(directory, 'new-program'), '-DataRoot', join(directory, 'new-data'), '-SkipShortcuts'], { windowsHide: true })).rejects.toThrow()
    await expect(access(join(directory, 'escape.txt'))).rejects.toThrow()
  }), 30000)
})
