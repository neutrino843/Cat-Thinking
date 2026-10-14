import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, stat, rm, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, unzipSync } from 'fflate'
import { assertOwnedDataDirectory, databaseRuntime, privateDirectory, validateDatabaseConfiguration } from './runtime.mjs'
import { fileDigest, safeChild } from './package.mjs'

const derive = promisify(scrypt)
const MAGIC = Buffer.from('MSZFULL1')
const MAX_BYTES = 512 * 1024 * 1024
const defaultProgramRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function validPassword(password) { if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw new Error('desktop_backup_password_minimum_10_characters') }
export async function sealBackup(bytes, password) {
  validPassword(password)
  if (bytes.length > MAX_BYTES) throw new Error('desktop_backup_too_large_no_silent_omission')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header = Buffer.from(JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt-16384-8-1', salt: salt.toString('base64'), iv: iv.toString('base64') }))
  const key = await derive(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(header)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length)
    return Buffer.concat([MAGIC, length, header, encrypted, cipher.getAuthTag()])
  } finally { key.fill(0) }
}
export async function unsealBackup(bytes, password) {
  validPassword(password)
  if (bytes.length < 64 || bytes.length > MAX_BYTES + 4096 || !bytes.subarray(0, 8).equals(MAGIC)) throw new Error('desktop_backup_format_invalid')
  const length = bytes.readUInt32BE(8)
  if (length < 1 || length > 4096 || 12 + length + 16 >= bytes.length) throw new Error('desktop_backup_header_invalid')
  const header = bytes.subarray(12, 12 + length)
  const config = JSON.parse(header.toString('utf8'))
  if (config.version !== 1 || config.algorithm !== 'aes-256-gcm' || config.kdf !== 'scrypt-16384-8-1' || typeof config.salt !== 'string' || typeof config.iv !== 'string' ||
    Buffer.from(config.salt, 'base64').length !== 16 || Buffer.from(config.iv, 'base64').length !== 12) throw new Error('desktop_backup_version_unsupported')
  const key = await derive(password, Buffer.from(config.salt, 'base64'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(config.iv, 'base64'))
    cipher.setAAD(header); cipher.setAuthTag(bytes.subarray(-16))
    return Buffer.concat([cipher.update(bytes.subarray(12 + length, -16)), cipher.final()])
  } catch { throw new Error('desktop_backup_wrong_password_or_corrupt') } finally { key.fill(0) }
}
export function packBackupEntries(entries, courseIndex) {
  if (!courseIndex?.scopeConfirmed || !Number.isInteger(courseIndex.expectedCourseCount) || courseIndex.expectedCourseCount < 0 ||
    courseIndex.expectedCourseCount !== Object.keys(entries).filter((name) => name.startsWith('courses/')).length) throw new Error('desktop_backup_course_scope_confirmation_required')
  if (!entries['database.dump'] || !entries['database.json']) throw new Error('desktop_backup_database_and_keys_required')
  const files = Object.entries(entries).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: fileDigest(bytes) }))
  if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES) throw new Error('desktop_backup_too_large_no_silent_omission')
  const manifest = { version: 1, application: 'cat-thinking-protected-backup', files, courseIndex,
    browserCollectedAutomatically: false, unorganizedBrowserDocumentsExcluded: true, restorePolicy: 'new-isolated-folder-provider-paused',
    note: 'Course scope is confirmed by the user. Browser packages and database dump were exported separately; this is not a simultaneous browser snapshot.' }
  return Buffer.from(zipSync({ ...entries, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }, { level: 1 }))
}
export function validateBackupEntries(bytes) {
  const seen = new Set()
  let total = 0
  const entries = unzipSync(bytes, { filter: (entry) => {
    if (!/^(?:manifest\.json|database\.json|database\.dump|courses\/[0-9]{4}\.mszcourse)$/u.test(entry.name) || seen.has(entry.name) || !Number.isSafeInteger(entry.originalSize)) throw new Error('desktop_backup_entry_invalid')
    seen.add(entry.name); total += entry.originalSize
    if (total > MAX_BYTES || seen.size > 1004) throw new Error('desktop_backup_limits_exceeded')
    return true
  } })
  const manifest = JSON.parse(Buffer.from(entries['manifest.json'] ?? []).toString('utf8'))
  if (manifest.version !== 1 || manifest.application !== 'cat-thinking-protected-backup' || !Array.isArray(manifest.files) ||
    !manifest.courseIndex?.scopeConfirmed || manifest.courseIndex.expectedCourseCount !== Object.keys(entries).filter((name) => name.startsWith('courses/')).length) throw new Error('desktop_backup_manifest_invalid')
  const expected = new Set()
  for (const file of manifest.files) {
    if (expected.has(file.path) || !entries[file.path] || entries[file.path].length !== file.bytes || fileDigest(entries[file.path]) !== file.sha256) throw new Error('desktop_backup_integrity_failed')
    expected.add(file.path)
  }
  if (Object.keys(entries).some((name) => name !== 'manifest.json' && !expected.has(name)) || !entries['database.json'] || !entries['database.dump']) throw new Error('desktop_backup_missing_or_unlisted')
  validateDatabaseConfiguration(JSON.parse(Buffer.from(entries['database.json']).toString('utf8')))
  return { entries, manifest }
}
export async function createProtectedBackup({ programRoot = defaultProgramRoot, dataRoot, outputPath, password, courseFiles = [], expectedCourseCount, scopeConfirmed }) {
  validPassword(password)
  await assertOwnedDataDirectory(dataRoot)
  try { await access(join(dataRoot, 'app.lock')); throw new Error('desktop_backup_stop_application_first') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!scopeConfirmed || expectedCourseCount !== courseFiles.length || !courseFiles.every((path) => /\.mszcourse$/iu.test(path))) throw new Error('desktop_backup_course_scope_confirmation_required')
  const sizes = await Promise.all(courseFiles.map(async (path) => (await stat(path)).size))
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_BYTES) throw new Error('desktop_backup_too_large_no_silent_omission')
  const runtime = await databaseRuntime(programRoot, dataRoot)
  const config = await runtime.load()
  const alreadyRunning = await runtime.running()
  const temporary = join(dataRoot, 'secrets', `backup-${randomUUID()}.dump`)
  try {
    await runtime.start()
    await runtime.run('pg_dump', ['-h', config.host, '-p', String(config.port), '-U', config.databases.local.user, '-d', config.databases.local.name, '-Fc', '--no-owner', '--no-acl', '-f', temporary], { PGPASSWORD: config.databases.local.password })
    if ((await stat(temporary)).size + sizes.reduce((sum, size) => sum + size, 0) > MAX_BYTES) throw new Error('desktop_backup_too_large_no_silent_omission')
    const entries = { 'database.dump': await readFile(temporary), 'database.json': Buffer.from(JSON.stringify(config)) }
    for (const [index, path] of courseFiles.entries()) entries[`courses/${String(index).padStart(4, '0')}.mszcourse`] = await readFile(path)
    const payload = packBackupEntries(entries, { version: 1, expectedCourseCount, scopeConfirmed: true,
      scope: 'all-courses-the-user-confirmed-exporting', names: courseFiles.map((path) => path.split(/[\\/]/u).pop()) })
    await writeFile(resolve(outputPath), await sealBackup(payload, password), { flag: 'wx', mode: 0o600 })
    return { path: resolve(outputPath), courseCount: courseFiles.length, protectedDatabaseAndKeys: true, browserCollectedAutomatically: false }
  } finally { await rm(temporary, { force: true }); if (!alreadyRunning) await runtime.stop() }
}
export async function restoreProtectedBackup({ programRoot = defaultProgramRoot, backupPath, targetRoot, password, postgresPort = 55436 }) {
  const validated = validateBackupEntries(await unsealBackup(await readFile(backupPath), password))
  const target = resolve(targetRoot)
  if (target === dirname(target)) throw new Error('desktop_restore_target_invalid')
  try { await access(target); throw new Error('desktop_restore_requires_new_isolated_directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Number.isInteger(postgresPort) || postgresPort < 1024 || postgresPort > 65535) throw new Error('desktop_restore_port_invalid')
  await privateDirectory(target)
  const owner = { version: 1, application: 'cat-thinking', installId: randomUUID(), dataRoot: target }
  await writeFile(join(target, '.cat-thinking-data.json'), JSON.stringify(owner))
  await privateDirectory(join(target, 'secrets'))
  const config = JSON.parse(Buffer.from(validated.entries['database.json']).toString('utf8'))
  config.port = postgresPort
  await writeFile(join(target, 'secrets/database.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 })
  await writeFile(join(target, 'app.json'), JSON.stringify({ version: 1, frontendPort: 53113, servicePort: 53114 }))
  await writeFile(join(target, 'pause-provider.json'), JSON.stringify({ version: 1, pause: true, reason: 'restored-backup' }))
  for (const [name, bytes] of Object.entries(validated.entries).filter(([name]) => name.startsWith('courses/'))) {
    const destination = safeChild(target, name)
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  }
  const dump = join(target, 'secrets/restore.dump')
  await writeFile(dump, validated.entries['database.dump'], { flag: 'wx', mode: 0o600 })
  const runtime = await databaseRuntime(programRoot, target)
  try {
    await runtime.setup()
    await runtime.run('pg_restore', ['-h', '127.0.0.1', '-p', String(config.port), '-U', config.databases.local.user, '-d', config.databases.local.name,
      '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', dump], { PGPASSWORD: config.databases.local.password })
    const connection = runtime.connect(config)
    try { const known = await connection.query("SELECT to_regclass('public.cat_analysis_personal_state') AS name"); if (known.rows[0]?.name) await connection.query('UPDATE cat_analysis_personal_state SET enabled=FALSE,revision=revision+1 WHERE singleton=TRUE AND enabled=TRUE') } finally { await connection.end() }
    await writeFile(join(target, 'restore-report.json'), JSON.stringify({ version: 1, complete: true, courseCount: validated.manifest.courseIndex.expectedCourseCount,
      providerPaused: true, encryptionKeyPreserved: true, browserPackagesNeedExplicitImport: true }))
    return { target, courseCount: validated.manifest.courseIndex.expectedCourseCount, providerPaused: true, encryptionKeyPreserved: true }
  } finally { await runtime.stop(); await rm(dump, { force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, dataRoot] = process.argv.slice(2)
  let input = ''
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 100_000) throw new Error('desktop_backup_input_too_large') }
  const options = JSON.parse(input)
  const operation = action === 'backup' ? createProtectedBackup({ ...options, dataRoot }) : restoreProtectedBackup(options)
  operation.then((result) => console.log(JSON.stringify(result))).catch(() => { console.error('受保护备份或隔离恢复未完成：检查密码、完整性、课程范围和空目标目录；当前安装与密钥保持不变。'); process.exitCode = 1 })
}
