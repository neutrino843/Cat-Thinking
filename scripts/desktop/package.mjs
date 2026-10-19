import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, writeFile, lstat, access } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const blocked = /^(?:\.git|\.env(?:\..*)?|node_modules|test|tests|test-results|coverage|reports|logs|secrets|data|evidence|\.cache)$/iu
const unsafeExtension = /\.(?:pem|key|log|dump|mszcourse|mszbackup|mszfull)$/iu
export const fileDigest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function safeChild(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..') || /[:\0]/u.test(name)) throw new Error('desktop_path_invalid')
  const result = resolve(root, ...name.split('/'))
  const location = relative(resolve(root), result)
  if (!location || location.startsWith(`..${sep}`) || location === '..' || isAbsolute(location)) throw new Error('desktop_path_escape')
  return result
}
export async function listRegularFiles(root, prefix = '') {
  const result = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) throw new Error('desktop_payload_link_or_special_file')
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await listRegularFiles(path, name))
    else result.push(name)
  }
  return result
}
async function copyFiltered(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (blocked.test(entry.name) || unsafeExtension.test(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error('desktop_dependency_link_unexpected')
    if (entry.isDirectory()) await copyFiltered(join(source, entry.name), join(target, entry.name))
    else if (entry.isFile()) await cp(join(source, entry.name), join(target, entry.name), { errorOnExist: true, force: false })
  }
}
export async function runtimeDependencyGraph(root) {
  const service = JSON.parse(await readFile(join(root, 'services/analysis-service/package.json'), 'utf8'))
  const contract = JSON.parse(await readFile(join(root, 'packages/analysis-contracts/package.json'), 'utf8'))
  const result = new Map()
  const find = async (name, lookup) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) throw new Error('desktop_dependency_name_invalid')
    let location
    try { location = dirname(lookup.resolve(`${name}/package.json`)) } catch {
      location = dirname(lookup.resolve(name))
      while (location !== dirname(location)) {
        try { if (JSON.parse(await readFile(join(location, 'package.json'), 'utf8')).name === name) break } catch { /* ascend from an exported entry */ }
        location = dirname(location)
      }
    }
    location = await realpath(location)
    const pkg = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'))
    if (pkg.name !== name) throw new Error('desktop_dependency_identity_mismatch')
    return { root: location, pkg }
  }
  const visit = async (name, lookup, parentDestination = '') => {
    if (name === '@cat-thinking/analysis-contracts') return
    const found = await find(name, lookup)
    const existing = result.get(name)
    if (existing?.root === found.root) return
    const identity = existing ? `${parentDestination}/node_modules/${name}` : name
    if (result.get(identity)?.root === found.root) return
    const destination = existing ? identity : `node_modules/${name}`
    result.set(identity, { ...found, destination })
    const childLookup = createRequire(join(found.root, 'package.json'))
    for (const dependency of Object.keys(found.pkg.dependencies ?? {}).sort()) await visit(dependency, childLookup, destination)
    for (const dependency of Object.keys(found.pkg.optionalDependencies ?? {}).sort()) {
      try { await visit(dependency, childLookup, destination) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
    }
  }
  await visit('fflate', createRequire(join(root, 'package.json')))
  for (const name of Object.keys(service.dependencies ?? {}).sort()) await visit(name, createRequire(join(root, 'services/analysis-service/package.json')), 'services/analysis-service')
  for (const name of Object.keys(contract.dependencies ?? {}).sort()) await visit(name, createRequire(join(root, 'packages/analysis-contracts/package.json')), 'node_modules/@cat-thinking/analysis-contracts')
  return result
}
export async function verifyPayload(root) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.application !== 'cat-thinking' || !Array.isArray(manifest.files) || manifest.files.length > 30_000) throw new Error('desktop_manifest_invalid')
  const seen = new Set()
  for (const file of manifest.files) {
    const identity = String(file.path).toLowerCase()
    if (seen.has(identity) || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('desktop_manifest_duplicate_or_invalid')
    seen.add(identity)
    const path = safeChild(root, file.path)
    if (!(await lstat(path)).isFile()) throw new Error('desktop_payload_nonregular')
    const bytes = await readFile(path)
    if (bytes.length !== file.bytes || fileDigest(bytes) !== file.sha256) throw new Error('desktop_payload_hash_mismatch')
  }
  const files = await listRegularFiles(root)
  if (files.filter((path) => path !== 'manifest.json').length !== seen.size || files.some((path) => path !== 'manifest.json' && !seen.has(path.toLowerCase()))) throw new Error('desktop_payload_unlisted_file')
  return manifest
}

export async function buildDesktopPackage({ root = repositoryRoot, outputRoot = resolve(root, '../output/desktop'), release = '3.0.0-dev.1',
  nodePath = process.execPath, postgresRoot = resolve(root, '../.cat-thinking-postgres/pgsql'), ollamaRoot, compress = true } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('desktop_build_requires_windows_x64')
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(release)) throw new Error('desktop_release_invalid')
  const { stdout: nodeVersion } = await exec(nodePath, ['--version'], { windowsHide: true })
  if (!/^v24\.(?:1[3-9]|[2-9][0-9])\.[0-9]+\s*$/u.test(nodeVersion) || nodeVersion.trim() === 'v24.13.0') throw new Error('desktop_node_version_unsupported')
  const { stdout: pgVersion } = await exec(join(postgresRoot, 'bin/postgres.exe'), ['--version'], { windowsHide: true })
  if (!/\b18\.6\b/u.test(pgVersion)) throw new Error('desktop_postgres_version_unverified')
  // V3 distributions carry the engine, so users never need a separate installation.
  if (/^3\./u.test(release) && !ollamaRoot) throw new Error('desktop_v3_bundled_ollama_required')
  let ollamaVersion
  if (ollamaRoot) {
    const { stdout, stderr } = await exec(join(ollamaRoot, 'ollama.exe'), ['--version'], { windowsHide: true })
    ollamaVersion = `${stdout} ${stderr}`.match(/\b\d+\.\d+\.\d+\b/u)?.[0]
    if (!ollamaVersion) throw new Error('desktop_ollama_version_unverified')
    await access(join(ollamaRoot, 'LICENSE'))
  }
  const output = safeChild(outputRoot, `CatThinking-${release}-windows-x64`)
  try { await access(output); throw new Error('desktop_output_exists_choose_new_release') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const payload = join(output, 'payload')
  await mkdir(payload, { recursive: true })
  await copyFiltered(join(root, 'dist'), join(payload, 'dist'))
  await copyFiltered(join(root, 'services/analysis-service/dist'), join(payload, 'services/analysis-service/dist'))
  await cp(join(root, 'services/analysis-service/package.json'), join(payload, 'services/analysis-service/package.json'))
  await copyFiltered(join(root, 'packages/analysis-contracts/dist'), join(payload, 'packages/analysis-contracts/dist'))
  await cp(join(root, 'packages/analysis-contracts/package.json'), join(payload, 'packages/analysis-contracts/package.json'))
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'cat-thinking-desktop', type: 'module', version: release, private: true }))
  await mkdir(join(payload, 'runtime'), { recursive: true })
  await cp(nodePath, join(payload, 'runtime/node.exe'))
  for (const component of ['bin', 'lib', 'share']) await copyFiltered(join(postgresRoot, component), join(payload, `runtime/postgres/${component}`))
  if (ollamaRoot) await copyFiltered(ollamaRoot, join(payload, 'runtime/ollama'))
  const dependencies = await runtimeDependencyGraph(root)
  for (const dependency of dependencies.values()) await copyFiltered(dependency.root, safeChild(payload, dependency.destination))
  await mkdir(join(payload, 'node_modules/@cat-thinking/analysis-contracts'), { recursive: true })
  await cp(join(payload, 'packages/analysis-contracts/dist'), join(payload, 'node_modules/@cat-thinking/analysis-contracts/dist'), { recursive: true })
  await cp(join(payload, 'packages/analysis-contracts/package.json'), join(payload, 'node_modules/@cat-thinking/analysis-contracts/package.json'))
  await copyFiltered(join(root, 'scripts/desktop'), join(payload, 'scripts/desktop'))
  const files = []
  for (const path of await listRegularFiles(payload)) { const bytes = await readFile(safeChild(payload, path)); files.push({ path, bytes: bytes.length, sha256: fileDigest(bytes) }) }
  const manifest = { version: 1, application: 'cat-thinking', release, platform: 'win32-x64', nodeVersion: nodeVersion.trim(), postgresVersion: '18.6',
    fixedFrontendPort: 53013, fixedServicePort: 53014, fixedPostgresPort: 55435, signed: false, cleanWindowsVerified: false,
    ...(ollamaVersion ? { ollamaVersion, bundledLocalEngine: true, modelsIncluded: false } : {}),
    dependencies: [...dependencies.values()].map((value) => ({ name: value.pkg.name, version: value.pkg.version, destination: value.destination })).sort((a, b) => a.destination.localeCompare(b.destination)), files }
  await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await verifyPayload(payload)
  for (const file of ['Install.cmd', 'install.ps1', 'launch.ps1', 'uninstall.ps1', 'README.md']) await cp(join(root, 'scripts/desktop', file), join(output, file))
  if (compress) {
    await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/desktop/compress.ps1'),
      '-SourcePath', payload, '-DestinationPath', join(output, 'payload.zip')], { windowsHide: true, maxBuffer: 1_000_000, timeout: 600_000 })
    await writeFile(join(output, 'payload.sha256'), `${fileDigest(await readFile(join(output, 'payload.zip')))}  payload.zip\n`)
  }
  return { output, payload, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), dependencies: dependencies.size }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const release = args[0] ?? '3.0.0-dev.1'
  const compress = !args.includes('--no-zip')
  const engineIndex = args.indexOf('--ollama-root')
  const ollamaRoot = engineIndex >= 0 ? args[engineIndex + 1] : undefined
  buildDesktopPackage({ release, compress, ollamaRoot }).then((result) => console.log(JSON.stringify(result))).catch(() => { console.error('Windows package build failed; inspect required built artifacts, runtimes and fresh output version.'); process.exitCode = 1 })
}
