import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const summaryPath = resolve(root, 'coverage', 'coverage-summary.json')
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))

const thresholds = {
  total: { statements: 78, branches: 69, functions: 84, lines: 82 },
  analysis: { functions: 90, lines: 90, branches: 85 },
  contracts: { functions: 90, lines: 90, branches: 85 },
  service: { functions: 90, lines: 90, branches: 85 },
}

const percentage = (covered, total) => total === 0 ? 100 : (covered / total) * 100

const combine = (entries) => {
  const result = {
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  }
  for (const entry of entries) {
    for (const metric of Object.keys(result)) {
      result[metric].covered += entry[metric].covered
      result[metric].total += entry[metric].total
    }
  }
  return result
}

const normalizedEntries = Object.entries(summary)
  .filter(([name]) => name !== 'total')
  .map(([name, value]) => [name.replaceAll('\\', '/'), value])

const groups = {
  total: summary.total,
  analysis: combine(
    normalizedEntries.filter(([name]) => name.includes('/src/analysis/')).map(([, value]) => value),
  ),
  contracts: combine(
    normalizedEntries
      .filter(([name]) => name.includes('/packages/analysis-contracts/src/'))
      .map(([, value]) => value),
  ),
  service: combine(
    normalizedEntries
      .filter(([name]) => name.includes('/services/analysis-service/src/'))
      .map(([, value]) => value),
  ),
}

let failed = false
for (const [groupName, required] of Object.entries(thresholds)) {
  const group = groups[groupName]
  for (const [metric, minimum] of Object.entries(required)) {
    const actual = percentage(group[metric].covered, group[metric].total)
    const formatted = actual.toFixed(2)
    if (actual + Number.EPSILON < minimum) {
      console.error(`Coverage gate failed: ${groupName}.${metric} ${formatted}% < ${minimum}%`)
      failed = true
    } else {
      console.log(`Coverage gate passed: ${groupName}.${metric} ${formatted}% >= ${minimum}%`)
    }
  }
}

if (failed) process.exitCode = 1
