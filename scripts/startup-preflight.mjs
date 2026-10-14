import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Match the service's supported Node 24 runtime, as well as the locked toolchain. */
export const supportsLocalNodeVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  return major === 24 && (minor > 13 || minor === 13 && patch >= 1)
}

export const inspectStartup = ({ root = projectRoot, nodeVersion = process.versions.node,
  exists = existsSync, read = readFileSync, resolveDependency } = {}) => {
  const failures = []
  if (!supportsLocalNodeVersion(nodeVersion)) failures.push('node_version')
  const files = ['package.json', 'scripts/local-postgres.mjs', 'services/analysis-service/package.json']
  if (files.some((file) => !exists(join(root, file)))) return { failures: [...failures, 'project_files'], nodeVersion }
  let packages
  try {
    packages = [JSON.parse(read(join(root, 'package.json'), 'utf8')),
      JSON.parse(read(join(root, 'services/analysis-service/package.json'), 'utf8'))]
    if (packages.some((pkg) => !pkg || typeof pkg !== 'object' || Array.isArray(pkg))) throw new Error('invalid_project_metadata')
  } catch { return { failures: [...failures, 'project_files'], nodeVersion } }
  const require = createRequire(join(root, 'package.json'))
  const lookup = resolveDependency ?? ((name) => {
    try { return require.resolve(`${name}/package.json`) } catch { return require.resolve(name) }
  })
  // Do not read .env, database configuration, source text or Provider responses.
  const dependencies = new Set(packages.flatMap((pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })))
  for (const name of dependencies) {
    if (name.startsWith('@cat-thinking/')) continue // Built by the existing launcher.
    try { lookup(name) } catch { failures.push('dependencies'); break }
  }
  return { failures, nodeVersion }
}

export const describeStartup = ({ failures, nodeVersion }) => {
  const messages = [`Node.js：${nodeVersion}`]
  if (failures.includes('node_version')) messages.push('Node.js 版本不适合当前应用。请安装 Node.js 24.13.1 或更新的 24 系列版本，安装后重新打开终端。')
  if (failures.includes('project_files')) messages.push('应用文件不完整。请使用完整的 cat-thinking 文件夹，保留 scripts 与 services 子文件夹；不需要改成英文路径。')
  if (failures.includes('dependencies')) messages.push('应用依赖缺失或损坏。在本文件夹的 PowerShell 中执行 npm.cmd ci，完成后重新启动。此检查没有自动下载任何文件。')
  if (!failures.length) messages.push('应用文件和本机启动依赖检查通过。中文路径可以直接使用；此检查不会启动数据库或调用 AI。')
  return messages
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = inspectStartup()
  for (const message of describeStartup(result)) console.log(message)
  process.exitCode = result.failures.length ? 1 : 0
}
