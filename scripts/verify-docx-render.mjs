import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = resolve(root, 'e2e', 'fixtures', 'documents')
const expected = JSON.parse(readFileSync(resolve(fixtureDirectory, 'expected.json'), 'utf8'))
const source = resolve(fixtureDirectory, expected.structuredDocx.file)
const outputDirectory = mkdtempSync(join(tmpdir(), 'cat-thinking-docx-'))

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  return result.stdout
}

const normalizeRenderedText = (value) => value
  .normalize('NFC')
  .replace(/\s*\|\s*/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

try {
  run('libreoffice', ['--headless', '--convert-to', 'pdf', '--outdir', outputDirectory, source])
  const output = resolve(outputDirectory, `${basename(source, '.docx')}.pdf`)
  const info = run('pdfinfo', [output])
  const pages = Number(info.match(/^Pages:\s+(\d+)$/mu)?.[1] ?? 0)
  if (pages < 1) throw new Error('Converted DOCX has no PDF pages')

  const text = normalizeRenderedText(run('pdftotext', ['-layout', '-enc', 'UTF-8', output, '-']))
  for (const required of expected.structuredDocx.requiredText) {
    const normalizedRequired = normalizeRenderedText(required)
    if (!text.includes(normalizedRequired)) {
      throw new Error(`Converted DOCX is missing required text: ${normalizedRequired}`)
    }
  }
  console.log(`LibreOffice DOCX smoke test passed: ${pages} page(s)`)
} finally {
  rmSync(outputDirectory, { recursive: true, force: true })
}
