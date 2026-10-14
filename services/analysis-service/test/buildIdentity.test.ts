import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeArtifactDigest, loadVerifiedBuildIdentity, readBoundedFile } from '../src/release/buildIdentity.js'

const withBuild = async (work: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'cat-release-test-'))
  try {
    for (const folder of ['services/analysis-service/dist/nested', 'packages/analysis-contracts/dist']) await mkdir(join(root, folder), { recursive: true })
    for (const path of ['package-lock.json', 'packages/analysis-contracts/package.json', 'services/analysis-service/package.json', 'services/analysis-service/dist/nested/index.js', 'packages/analysis-contracts/dist/index.js']) await writeFile(join(root, path), '{}')
    await work(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
describe('compiled build identity', () => {
  it('hashes runtime files and lockfile, ignoring only the generated identity', async () => withBuild(async (root) => {
    const artifactDigest = await computeArtifactDigest(root)
    const identity = { serviceVersion: '0.1.0', commit: 'a'.repeat(40), artifactDigest }
    await writeFile(join(root, 'services/analysis-service/dist/release-build.json'), JSON.stringify(identity))
    expect(await loadVerifiedBuildIdentity(root)).toEqual(identity)
    expect(await computeArtifactDigest(root)).toBe(artifactDigest)
    await writeFile(join(root, 'package-lock.json'), '{"changed":true}')
    await expect(loadVerifiedBuildIdentity(root)).rejects.toThrow('release_build_changed')
  }))
  it('fails closed for missing or malformed identity and bounded non-file input', async () => withBuild(async (root) => {
    await expect(loadVerifiedBuildIdentity(root)).rejects.toThrow()
    const path = join(root, 'services/analysis-service/dist/release-build.json')
    await writeFile(path, '{}')
    await expect(loadVerifiedBuildIdentity(root)).rejects.toThrow()
    expect(await readBoundedFile(path, 2)).toBe('{}')
    await expect(readBoundedFile(path, 1)).rejects.toThrow('release_file_too_large')
    await expect(readBoundedFile(root, 8)).rejects.toThrow()
  }))
  it('rejects symlinked artifact trees', async () => withBuild(async (root) => {
    const directory = join(root, 'services/analysis-service/dist')
    await rm(directory, { recursive: true })
    await symlink(join(root, 'packages/analysis-contracts/dist'), directory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(computeArtifactDigest(root)).rejects.toThrow('release_artifact_symlink')
  }))
})
