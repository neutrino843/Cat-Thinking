import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, open } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { z } from 'zod'

export const buildIdentitySchema = z.object({
  serviceVersion: z.string().min(1).max(80),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export type BuildIdentity = z.infer<typeof buildIdentitySchema>

export const computeArtifactDigest = async (root: string): Promise<string> => {
  const paths = ['package-lock.json', 'packages/analysis-contracts/package.json', 'services/analysis-service/package.json']
  const collect = async (directory: string): Promise<void> => {
    if ((await lstat(resolve(root, directory))).isSymbolicLink()) throw new Error('release_artifact_symlink')
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('release_artifact_symlink')
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile() && entry.name !== 'release-build.json') paths.push(path)
    }
  }
  await collect('services/analysis-service/dist')
  await collect('packages/analysis-contracts/dist')
  const hash = createHash('sha256').update('cat-analysis-build-v1\n')
  for (const path of paths.sort()) {
    const absolute = resolve(root, path)
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error('release_artifact_symlink')
    const bytes = await readFile(absolute)
    hash.update(`${relative(root, absolute).replaceAll('\\', '/')}\n${bytes.length}\n`).update(bytes)
  }
  return hash.digest('hex')
}

export const readBoundedFile = async (path: string, maxBytes: number): Promise<string> => {
  const handle = await open(path, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('release_file_invalid')
    const bytes = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) throw new Error('release_file_too_large')
    return bytes.subarray(0, total).toString('utf8')
  } finally { await handle.close() }
}

export const loadVerifiedBuildIdentity = async (root: string): Promise<BuildIdentity> => {
  const identity = buildIdentitySchema.parse(JSON.parse(await readBoundedFile(resolve(root, 'services/analysis-service/dist/release-build.json'), 4096)))
  if (identity.artifactDigest !== await computeArtifactDigest(root)) throw new Error('release_build_changed')
  return identity
}
