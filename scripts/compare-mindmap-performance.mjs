import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2] ?? 'reports/mindmap-performance-2026-10-21'
const read = async (name) => JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
const before = await read('before')
const after = await read('after')
assert.equal(after.browser, before.browser, 'Browser versions must match')
assert.deepEqual(after.viewport, before.viewport, 'Viewports must match')
assert.equal(before.modelPosts, 0)
assert.equal(after.modelPosts, 0)
const median = (values) => {
  assert(values.length > 0 && values.every(Number.isFinite), 'Expected finite samples')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const pair = (previous, current) => ({ beforeMs: previous, afterMs: current, reductionPercent: previous > 0 ? (previous - current) / previous * 100 : null })
assert.equal(before.profile.cases.length, after.profile.cases.length)
const layouts = before.profile.cases.map((previous, index) => {
  const current = after.profile.cases[index]
  assert.equal(current.count, previous.count)
  assert.equal(current.nodes, previous.nodes)
  assert.deepEqual(current.geometry, previous.geometry, `Layout geometry changed at ${current.count} nodes`)
  return {
    nodes: current.count,
    geometryEqual: true,
    firstForFixture: pair(previous.first.ms, current.first.ms),
    warmMedian: pair(median(previous.warm.map((s) => s.ms)), median(current.warm.map((s) => s.ms))),
    warmMeasureCalls: { before: previous.warm.map((s) => s.measureCalls), after: current.warm.map((s) => s.measureCalls) },
    edit: pair(previous.edit.ms, current.edit.ms),
    editMeasureCalls: { before: previous.edit.measureCalls, after: current.edit.measureCalls },
  }
})
const coldBefore = await read('before-cold')
const coldAfter = await read('after-cold')
assert.equal(coldAfter.browser, coldBefore.browser)
assert.deepEqual(coldAfter.viewport, coldBefore.viewport)
assert.equal(coldBefore.result.nodes, coldAfter.result.nodes)
assert.deepEqual(after.profile.imports.map(({ nodes, sourceCharacters, locators }) => ({ nodes, sourceCharacters, locators })), before.profile.imports.map(({ nodes, sourceCharacters, locators }) => ({ nodes, sourceCharacters, locators })))
const comparison = {
  browser: after.browser, viewport: after.viewport, layouts,
  cold400SingleSample: pair(coldBefore.result.cold.ms, coldAfter.result.cold.ms),
  cold400MeasureCalls: { before: coldBefore.result.cold.measureCalls, after: coldAfter.result.cold.measureCalls },
  outline1051StableFrameMedian: pair(median(before.outlineTiming.stableFrameMs), median(after.outlineTiming.stableFrameMs)),
  outline1051DispatchMedian: pair(median(before.outlineTiming.synchronousDispatchMs), median(after.outlineTiming.synchronousDispatchMs)),
  unchangedImportMedian: pair(median(before.profile.imports.map((s) => s.ms)), median(after.profile.imports.map((s) => s.ms))),
  modelPosts: 0,
  limitations: ['Synthetic development build on one machine and Chromium; not a production SLA.', 'firstForFixture is not a cold cache. Cold400 is a separate fresh page, one sample only.', 'Double requestAnimationFrame includes scheduling and paint; dispatch is synchronous event handling, not total rendering CPU.', 'Import is an unchanged control; its timing variation is not an optimization claim.'],
}
await writeFile(join(directory, 'comparison.json'), JSON.stringify(comparison, null, 2))
console.log(JSON.stringify(comparison, null, 2))
