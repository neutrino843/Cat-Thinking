import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = path.join(root, 'reports/competition-2026-10-19')
const browserPath = path.join(root, '.browser-test-runtime/competition-browser')
await fs.mkdir(evidence, { recursive: true })
const report = { startedAt: new Date().toISOString(), scope: 'targeted checks only; full regression awaits user manual acceptance per ITERATION_PROTOCOL', commands: [] }
const node = (name, args) => ({ name, executable: process.execPath, args })
const steps = [
  { name: 'build-final', executable: 'npm.cmd', args: ['run', 'build'], shell: process.platform === 'win32' },
  node('verify-build-final', ['scripts/verify-browser-build.mjs']),
  node('lint-changed', ['node_modules/eslint/bin/eslint.js', 'scripts/competition', 'src/onboarding/GameCompanion.tsx', '--max-warnings', '0']),
  node('unit-targeted', ['node_modules/vitest/vitest.mjs', 'run', 'src/learning/learningLoop.test.ts', 'src/learning/coursePackage.test.ts', 'src/learning/repository.test.ts', 'src/learning/learningRules.test.ts', 'src/onboarding/guide.test.ts', 'src/lib/documentImport.test.ts', 'src/lib/backup.test.ts', 'src/learning/sessionRunner.test.ts', 'src/learning/experiencePreferences.test.ts', '--no-file-parallelism', '--reporter=json', '--outputFile=reports/competition-2026-10-19/unit-results.json']),
  node('browser-targeted', ['node_modules/@playwright/test/cli.js', 'test', 'e2e/learning-loop.spec.ts', 'e2e/learning-storage.spec.ts', 'e2e/onboarding-guide.spec.ts', 'e2e/focus-experience.spec.ts', '--reporter=line,json', '--output=reports/competition-2026-10-19/browser-artifacts']),
]
let remaining = steps
if (process.argv.includes('--resume')) {
  const prior = JSON.parse(await fs.readFile(path.join(evidence, 'validation-results.json'), 'utf8'))
  const prefix = []
  for (const command of prior.commands) { if (command.status !== 'passed') break; prefix.push(command) }
  const built = prefix.find((command) => command.name === 'build-final')
  if (!built) throw new Error('没有本轮成功构建，不能跳过构建。')
  const baseline = JSON.parse(await fs.readFile(path.join(evidence, 'baseline.json'), 'utf8'))
  for (const [name, hash] of Object.entries(baseline.productSourceHashes)) {
    if (hash === null) continue
    if ((await fs.stat(path.join(root, name))).mtimeMs > Date.parse(built.finishedAt)) throw new Error(`构建后产品源文件已变化，需完整重跑：${name}`)
  }
  await fs.writeFile(path.join(evidence, `validation-history-${Date.now()}.json`), JSON.stringify(prior, null, 2))
  report.commands = prefix
  remaining = steps.slice(prefix.length)
  console.log(`RESUME keeping ${prefix.map((command) => command.name).join(', ')}`)
}
for (const step of remaining) {
  const command = { name: step.name, executable: step.executable, args: step.args, startedAt: new Date().toISOString(), log: `${step.name}.log` }
  const chunks = []
  console.log(`START ${step.name}`)
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(step.executable, step.args, { cwd: root, shell: step.shell || false, windowsHide: true, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(evidence, 'browser-results.json') } })
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', resolve)
  })
  await fs.writeFile(path.join(evidence, command.log), Buffer.concat(chunks))
  Object.assign(command, { exitCode, finishedAt: new Date().toISOString(), status: exitCode === 0 ? 'passed' : 'failed' })
  report.commands.push(command)
  await fs.writeFile(path.join(evidence, 'validation-results.json'), JSON.stringify(report, null, 2))
  console.log(`${command.status.toUpperCase()} ${step.name} exit=${exitCode}`)
  if (exitCode !== 0) { console.error(Buffer.concat(chunks).toString('utf8').slice(-7000)); report.status = 'failed'; process.exitCode = 1; break }
}
report.status ||= 'passed'
report.finishedAt = new Date().toISOString()
await fs.writeFile(path.join(evidence, 'validation-results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, commands: report.commands.length, report: path.relative(root, path.join(evidence, 'validation-results.json')) }))
