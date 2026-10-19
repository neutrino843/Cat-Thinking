import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { zipSync, unzipSync, strToU8 } from 'fflate'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const iteration = path.join(root, 'docs/iterations/2026-10-19-益海嘉里杯初赛方案')
const materials = path.join(iteration, '参赛材料')
const evidence = path.join(root, 'reports/competition-2026-10-19')
const readJSON = async (name) => JSON.parse(await fs.readFile(path.join(evidence, name), 'utf8'))
const walkthrough = await readJSON('walkthrough.json'), layout = await readJSON('layout/results.json'), unit = await readJSON('unit-results.json'), browser = await readJSON('browser-results.json'), validation = await readJSON('validation-results.json'), productDiff = await readJSON('product-source-diff.json')
assert.equal(walkthrough.status, 'passed')
assert.equal(layout.status, 'passed')
assert.equal(validation.status, 'passed')
assert.equal(unit.numFailedTests, 0)
assert.equal(browser.stats.unexpected, 0)
const summary = { date: '2026-10-19', kind: 'software validation, not learner research or effectiveness evidence', unit: { files: unit.testResults.length, passed: unit.numPassedTests, failed: unit.numFailedTests, skipped: unit.numPendingTests }, browser: browser.stats, walkthrough: { checks: walkthrough.checks.length, aiPosts: walkthrough.apiPosts.length, pageErrors: walkthrough.pageErrors.length, startedAt: walkthrough.startedAt, finishedAt: walkthrough.finishedAt }, layout: { checks: layout.checks.length, note: layout.kind }, productDiff, manualAcceptance: 'not confirmed in this session', realCourse: 'not supplied; authored sample used', learnerResearch: 'not performed by agent', fullRegression: 'pending user manual acceptance' }
await fs.writeFile(path.join(materials, '验证摘要.json'), JSON.stringify(summary, null, 2))
const entries = {}, manifest = []
async function add(file, archiveName) {
  const bytes = await fs.readFile(file)
  entries[archiveName] = new Uint8Array(bytes)
  manifest.push({ path: archiveName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
async function visit(directory, prefix) {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('材料目录不能包含软链接。')
    if (entry.name === '交付文件清单.json') continue
    const name = `${prefix}/${entry.name}`
    if (entry.isDirectory()) await visit(path.join(directory, entry.name), name)
    else if (/\.(md|txt|json|pptx|pdf|doc|mszcourse|webm|png)$/i.test(entry.name)) await add(path.join(directory, entry.name), name)
  }
}
await visit(materials, '参赛材料')
for (const name of ['实施报告.md', '下一步计划.md', '审计报告-保底实施.md', '执行补充计划.md']) await add(path.join(iteration, name), name)
const clean = JSON.parse(Buffer.from(entries['参赛材料/统计学自编示范-无作答.mszcourse']).toString())
const progress = JSON.parse(Buffer.from(entries['参赛材料/统计学自编示范-自动演示记录.mszcourse']).toString())
assert.equal(clean.course.example, true)
assert.equal(progress.course.example, true)
assert.equal(clean.records.filter((r) => r.kind === 'attempt').length, 0)
assert.equal(progress.records.filter((r) => r.kind === 'attempt').length, 2)
assert.equal(clean.records.find((r) => r.kind === 'archive').artifacts.find((a) => a.kind === 'quiz').payload.questions.length, 6)
const pptx = unzipSync(entries['参赛材料/猫思之-参赛展示工作稿.pptx'])
assert.equal(Object.keys(pptx).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 6)
assert.equal(Buffer.from(entries['参赛材料/第二十四季官方报名表-原件.doc']).subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1')
assert.equal(Buffer.from(entries['参赛材料/猫思之-浏览器自动演示.webm']).subarray(0, 4).toString('hex'), '1a45dfa3')
const manifestData = { version: 1, createdAt: new Date().toISOString(), note: 'Author-prepared sample and automated walkthrough only; no learner study, secrets, user databases or executable AI tasks.', files: manifest }
const manifestBytes = strToU8(JSON.stringify(manifestData, null, 2))
entries['交付文件清单.json'] = manifestBytes
await fs.writeFile(path.join(materials, '交付文件清单.json'), manifestBytes)
const zipPath = path.join(iteration, '猫思之-参赛准备包.zip')
const zipped = zipSync(entries, { level: 6 })
await fs.writeFile(zipPath, zipped)
const reopened = unzipSync(await fs.readFile(zipPath))
for (const item of manifest) assert.equal(createHash('sha256').update(reopened[item.path]).digest('hex'), item.sha256)
const receipt = { status: 'passed', archive: path.relative(root, zipPath), bytes: zipped.byteLength, files: manifest.length, sha256: createHash('sha256').update(zipped).digest('hex'), verification: 'reopened archive and verified every listed entry hash' }
await fs.writeFile(path.join(evidence, 'package-validation.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
