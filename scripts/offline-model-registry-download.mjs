import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Explicit diagnostic downloader for networks whose VPN DNS uses a reserved fake-IP
// range rejected by Ollama. Never used by the app; every blob must match the
// digest AND byte length from the official registry manifest before registration.
const root = resolve('.local-ai-validation/models')
const transfer = (args) => new Promise((yes, no) => {
  const child = spawn('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '30', '--max-time', '120', '--speed-limit', '1024', '--speed-time', '30', ...args], { shell: false, windowsHide: true, stdio: 'inherit' })
  child.once('error', no); child.once('exit', (code) => code === 0 ? yes() : no(new Error(`curl_exit_${code}`)))
})
const curl = async (args) => {
  for (let attempt = 1; ; attempt++) {
    try { await transfer(args); return } catch (error) { if (attempt >= 8) throw error; console.log(JSON.stringify({ retry: attempt, reason: error.message })) }
  }
}
const hashFile = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
await mkdir(resolve(root, 'blobs'), { recursive: true })
const lockPath = resolve(root, '../registry-download.lock')
const lock = await open(lockPath, 'wx')
await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
try {
for (const tag of ['4b', '8b']) {
  const manifestPath = resolve(root, 'manifests/registry.ollama.ai/library/qwen3', tag)
  await mkdir(dirname(manifestPath), { recursive: true })
  const temporaryManifest = `${manifestPath}.download`
  await curl(['--output', temporaryManifest, `https://registry.ollama.ai/v2/library/qwen3/manifests/${tag}`])
  const raw = await readFile(temporaryManifest, 'utf8'), manifest = JSON.parse(raw)
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) throw new Error('invalid_manifest')
  const receipts = []
  for (const layer of [...manifest.layers, manifest.config]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 1) throw new Error('invalid_layer')
    const destination = resolve(root, 'blobs', layer.digest.replace(':', '-'))
    const valid = async (path) => (await stat(path).catch(() => ({ size: -1 }))).size === layer.size && await hashFile(path) === layer.digest.slice(7)
    console.log(JSON.stringify({ model: `qwen3:${tag}`, digest: layer.digest, bytes: layer.size, at: new Date().toISOString() }))
    if (!await valid(destination)) {
      const url = `https://registry.ollama.ai/v2/library/qwen3/blobs/${layer.digest}`
      if (layer.size > 100_000_000) {
        const chunks = resolve(root, '../chunks', layer.digest.slice(7))
        await mkdir(chunks, { recursive: true })
        const chunkSize = 128 * 1024 * 1024, count = Math.ceil(layer.size / chunkSize)
        let next = 0
        const chunkPath = (index) => resolve(chunks, `${index}.part`)
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (next < count) {
            const index = next++, start = index * chunkSize, end = Math.min(layer.size, start + chunkSize) - 1
            if ((await stat(chunkPath(index)).catch(() => ({ size: -1 }))).size !== end - start + 1) {
              await curl(['--range', `${start}-${end}`, '--output', chunkPath(index), url])
            }
            if ((await stat(chunkPath(index))).size !== end - start + 1) throw new Error('range_length_invalid')
            console.log(JSON.stringify({ tag, chunk: index + 1, count, at: new Date().toISOString() }))
          }
        }))
        const concatenate = async function* () {
          for (let index = 0; index < count; index++) yield* createReadStream(chunkPath(index))
        }
        await pipeline(Readable.from(concatenate()), createWriteStream(`${destination}.download`))
      } else await curl(['--output', `${destination}.download`, url])
      if (!await valid(`${destination}.download`)) throw new Error('blob_integrity_failed')
      await rename(`${destination}.download`, destination)
    }
    receipts.push({ digest: layer.digest, bytes: layer.size, integrityPassed: true })
  }
  await rename(temporaryManifest, manifestPath)
  await writeFile(resolve('.local-ai-validation', `registry-${tag}.json`), JSON.stringify({ source: `https://registry.ollama.ai/v2/library/qwen3/manifests/${tag}`, at: new Date().toISOString(), manifestDigest: createHash('sha256').update(raw).digest('hex'), layers: receipts }, null, 2))
}
} finally { await lock.close(); await unlink(lockPath) }
