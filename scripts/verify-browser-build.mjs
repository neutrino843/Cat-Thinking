import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const metrics = JSON.parse(await readFile(resolve(dist, 'build-metrics.json'), 'utf8'))
if (metrics.version !== 1 || !Array.isArray(metrics.chunks) || !metrics.chunks.length) throw new Error('Missing browser build metrics; run npm run build first')
const chunks = new Map()
for (const chunk of metrics.chunks) {
  if (typeof chunk.fileName !== 'string' || chunks.has(chunk.fileName)) throw new Error('Invalid browser chunk identity')
  const path = resolve(dist, chunk.fileName)
  if (!path.startsWith(dist + sep) || !Array.isArray(chunk.imports) || !Array.isArray(chunk.dynamicImports)) throw new Error('Invalid browser chunk path or dependencies')
  const bytes = await readFile(path)
  if (bytes.byteLength !== chunk.bytes || gzipSync(bytes).byteLength !== chunk.gzipBytes) throw new Error('Browser build evidence does not match current files')
  chunks.set(chunk.fileName, chunk)
}
const entry = metrics.chunks.filter((chunk) => chunk.isEntry)
const analysis = metrics.chunks.filter((chunk) => chunk.name === 'AnalysisResultsPanel')
if (entry.length !== 1 || analysis.length !== 1) throw new Error('Expected one browser entry and one lazy AI panel')
if (entry[0].bytes > 500_000) throw new Error('Browser entry exceeds the existing 500 kB warning budget')
const visited = new Set()
const active = new Set()
function checkStaticGraph(fileName) {
  if (active.has(fileName)) throw new Error('Browser static chunks form a circular dependency')
  if (visited.has(fileName)) return
  const chunk = chunks.get(fileName)
  if (!chunk) throw new Error('Unknown browser static dependency')
  active.add(fileName)
  for (const imported of chunk.imports) checkStaticGraph(imported)
  active.delete(fileName)
  visited.add(fileName)
}
for (const chunk of metrics.chunks) checkStaticGraph(chunk.fileName)
const initial = new Set()
function walk(fileName) {
  if (initial.has(fileName)) return
  const chunk = chunks.get(fileName)
  if (!chunk) throw new Error('Unknown browser static dependency')
  initial.add(fileName)
  for (const imported of chunk.imports) walk(imported)
}
walk(entry[0].fileName)
if (initial.has(analysis[0].fileName)) throw new Error('AI panel must remain outside the initial static dependency graph')
console.log(JSON.stringify({
  version: 1,
  entry: { bytes: entry[0].bytes, gzipBytes: entry[0].gzipBytes },
  initialJavaScript: { bytes: [...initial].reduce((sum, name) => sum + chunks.get(name).bytes, 0), gzipBytes: [...initial].reduce((sum, name) => sum + chunks.get(name).gzipBytes, 0), chunks: initial.size },
  lazyAnalysis: { bytes: analysis[0].bytes, gzipBytes: analysis[0].gzipBytes },
  entryPackages: entry[0].packages,
  // Module renderedLength precedes final minification; package weights are diagnostic, not transfer bytes.
  largestChunkPackages: metrics.chunks[0].packages,
}, null, 2))
