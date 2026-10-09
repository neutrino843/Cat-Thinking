import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const summary = JSON.parse(readFileSync(resolve(root, 'coverage-postgres', 'coverage-summary.json'), 'utf8'))
const thresholds = { functions: 90, lines: 90, branches: 85 }

let failed = false
for (const [metric, minimum] of Object.entries(thresholds)) {
  const actual = summary.total[metric].pct
  if (actual + Number.EPSILON < minimum) {
    console.error(`PostgreSQL coverage gate failed: ${metric} ${actual.toFixed(2)}% < ${minimum}%`)
    console.error(
      `::error file=scripts/verify-postgres-coverage.mjs,title=PostgreSQL ${metric} coverage::${actual.toFixed(2)}% is below ${minimum}%`,
    )
    failed = true
  } else {
    console.log(`PostgreSQL coverage gate passed: ${metric} ${actual.toFixed(2)}% >= ${minimum}%`)
  }
}

if (failed) process.exitCode = 1
