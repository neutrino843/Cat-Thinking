import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startDesktop } from './launcher.mjs'
import { databaseRuntime, serviceEnvironment } from './runtime.mjs'
import { createProtectedBackup, restoreProtectedBackup } from './backup.mjs'
import { fileDigest } from './package.mjs'

/** Explicit public-fixture verification. Never point this at an existing user data directory. */
export async function verifyNativeDesktop(programRoot, verificationRoot, publicCourseFixture) {
  const root = resolve(verificationRoot)
  try { await access(root); throw new Error('desktop_smoke_requires_new_directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(root, { recursive: true })
  const data = join(root, 'original-data')
  await mkdir(data)
  await writeFile(join(data, '.cat-thinking-data.json'), JSON.stringify({ version: 1, application: 'cat-thinking', installId: randomUUID(), dataRoot: data }))
  await writeFile(join(data, 'app.json'), JSON.stringify({ version: 1, frontendPort: 53133, servicePort: 53134 }))
  const initialReadOnly = await startDesktop({ programRoot, dataRoot: data, verifyOnly: true, openBrowser: false })
  const runtime = await databaseRuntime(programRoot, data)
  const config = await runtime.load()
  const load = (path) => import(pathToFileURL(join(programRoot, 'services/analysis-service/dist', path)).href)
  const { PostgresJobStore } = await load('infrastructure/postgres/postgresJobStore.js')
  const { AesGcmContentCipher } = await load('infrastructure/contentCipher.js')
  const { RunService } = await load('domain/runService.js')
  const { loadAnalysisServiceConfig } = await load('config.js')
  const text = 'Public synthetic desktop recovery fixture. No Provider or user material.'
  const hash = fileDigest(Buffer.from(text))
  let originalStore
  let runId
  try {
    await runtime.start()
    const serviceConfig = loadAnalysisServiceConfig(serviceEnvironment(config, { servicePort: 53134, frontendUrl: 'http://127.0.0.1:53133' }, true))
    originalStore = await PostgresJobStore.connectFromConfig(serviceConfig.jobStore, new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64')))
    const service = new RunService({ store: originalStore, retentionSeconds: 3600 })
    const created = await service.createRun('desktop-public-fixture', { version: 1, requestKey: hash, docId: 'desktop-public-doc',
      manifest: { version: 1, sources: [{ version: 1, sourceId: 'desktop-public-source', kind: 'text', extractor: 'desktop-public-v1', contentHash: hash, charCount: text.length, byteCount: Buffer.byteLength(text) }] },
      artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 1, externalKnowledge: false } })
    runId = created.run.id
    await service.uploadSource('desktop-public-fixture', runId, { version: 1, sourceId: 'desktop-public-source', contentHash: hash,
      partHash: hash, partIndex: 0, partCount: 1, start: 0, end: text.length, totalChars: text.length, text })
  } finally { await originalStore?.close(); await runtime.stop() }
  const course = join(root, 'public-fixture.mszcourse')
  await writeFile(course, publicCourseFixture ? await readFile(publicCourseFixture) : Buffer.from('Opaque public binary fixture; inner course schema is not part of this outer backup test.'))
  const backupPath = join(root, 'public-protected-fixture.mszfull')
  const password = 'public-fixture-only-password'
  await createProtectedBackup({ programRoot, dataRoot: data, outputPath: backupPath, password, courseFiles: [course], expectedCourseCount: 1, scopeConfirmed: true })
  const restored = join(root, 'isolated-restored-data')
  await restoreProtectedBackup({ programRoot, backupPath, targetRoot: restored, password, postgresPort: 55436 })
  const recoveredRuntime = await databaseRuntime(programRoot, restored)
  const recoveredConfig = await recoveredRuntime.load()
  let restoredStore
  let encryptedSourceRecovered
  let providerPaused
  try {
    await recoveredRuntime.start()
    const config = loadAnalysisServiceConfig(serviceEnvironment(recoveredConfig, { servicePort: 53114, frontendUrl: 'http://127.0.0.1:53113' }, true))
    restoredStore = await PostgresJobStore.connectFromConfig(config.jobStore, new AesGcmContentCipher(Buffer.from(recoveredConfig.contentEncryptionKey, 'base64')))
    encryptedSourceRecovered = (await restoredStore.getSourceContent('desktop-public-fixture', runId, 'desktop-public-source'))?.text === text
    const connection = recoveredRuntime.connect(recoveredConfig)
    try { providerPaused = (await connection.query('SELECT enabled FROM cat_analysis_personal_state WHERE singleton=TRUE')).rows[0]?.enabled === false } finally { await connection.end() }
  } finally { await restoredStore?.close(); await recoveredRuntime.stop() }
  const restoredReadOnly = await startDesktop({ programRoot, dataRoot: restored, verifyOnly: true, openBrowser: false })
  const report = { version: 1, initialReadOnly, restoredReadOnly, encryptedSourceRecovered, providerPaused,
    encryptionKeyPreserved: recoveredConfig.contentEncryptionKey === config.contentEncryptionKey,
    courseRawBytesPreserved: fileDigest(await readFile(join(restored, 'courses/0000.mszcourse'))) === fileDigest(await readFile(course)),
    courseInnerSchemaVerifiedHere: false, browserProfileRead: false, modelCalls: 0, existingUserDataAccessed: false, cleanWindowsVmVerified: false }
  if (!encryptedSourceRecovered || !providerPaused || !report.encryptionKeyPreserved || !report.courseRawBytesPreserved) throw new Error('desktop_native_recovery_verification_failed')
  await writeFile(join(root, 'verification-report.json'), JSON.stringify(report, null, 2))
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [programRoot, verificationRoot, acknowledgement, publicCourseFixture] = process.argv.slice(2)
  if (acknowledgement !== '--public-fixture-only') throw new Error('desktop_native_smoke_public_fixture_ack_required')
  verifyNativeDesktop(resolve(programRoot), resolve(verificationRoot), publicCourseFixture).then((report) => console.log(JSON.stringify(report)))
    .catch(() => { console.error('Isolated public-fixture native verification failed; existing user data was not accessed.'); process.exitCode = 1 })
}
