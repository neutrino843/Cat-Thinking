import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = (payload) => createHash('sha256').update(payload).digest('hex')

const requireLocalName = (name, field) => {
  if (typeof name !== 'string' || name.length === 0 || basename(name) !== name) {
    throw new Error(`${field} must be a local file name`)
  }
}

const verifyDocumentFixtures = () => {
  const directory = resolve(root, 'e2e', 'fixtures', 'documents')
  const manifest = readJson(resolve(directory, 'manifest.json'))
  if (manifest.schemaVersion !== 1 || typeof manifest.files !== 'object') {
    throw new Error('Document fixture manifest schema is invalid')
  }
  for (const [name, metadata] of Object.entries(manifest.files)) {
    requireLocalName(name, 'document fixture name')
    const path = resolve(directory, name)
    const payload = readFileSync(path)
    if (payload.byteLength !== metadata.bytes) throw new Error(`${name}: byte size mismatch`)
    if (sha256(payload) !== metadata.sha256) throw new Error(`${name}: SHA-256 mismatch`)
  }
  console.log(`Verified ${Object.keys(manifest.files).length} document fixtures`)
}

const verifyGoldenFixtures = () => {
  const fixturesRoot = resolve(root, 'evals', 'analysis', 'fixtures')
  const directories = readdirSync(fixturesRoot)
    .map((name) => resolve(fixturesRoot, name))
    .filter((path) => statSync(path).isDirectory())
  if (directories.length === 0) throw new Error('No analysis golden fixtures found')

  for (const directory of directories) {
    const manifest = readJson(resolve(directory, 'manifest.json'))
    requireLocalName(manifest.sourceFile, 'golden sourceFile')
    requireLocalName(manifest.expectationsFile, 'golden expectationsFile')
    if (manifest.version !== 1 || manifest.redistributable !== true || manifest.license !== 'project-generated') {
      throw new Error(`${manifest.fixtureId ?? directory}: unsafe golden fixture metadata`)
    }
    const sourcePath = resolve(directory, manifest.sourceFile)
    const expectationsPath = resolve(directory, manifest.expectationsFile)
    if (!existsSync(sourcePath) || !existsSync(expectationsPath)) {
      throw new Error(`${manifest.fixtureId}: fixture file is missing`)
    }
    const expectations = readJson(expectationsPath)
    if (expectations.fixtureId !== manifest.fixtureId) throw new Error(`${manifest.fixtureId}: identity mismatch`)
    if (sha256(readFileSync(sourcePath)) !== manifest.contentHash) {
      throw new Error(`${manifest.fixtureId}: source SHA-256 mismatch`)
    }
  }
  console.log(`Verified ${directories.length} analysis golden fixtures`)
}

verifyDocumentFixtures()
verifyGoldenFixtures()
