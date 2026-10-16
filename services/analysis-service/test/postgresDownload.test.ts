// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`
const windows = describe.skipIf(process.platform !== 'win32')
// Let Windows PowerShell load its own modules instead of inheriting PowerShell 7's paths.
const powerShellEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cat-startup-repair-'))
  if (dirname(directory) !== tmpdir()) throw new Error('Unexpected temporary test directory')
  try { await work(directory) }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

windows('verified Windows PostgreSQL download', () => {
  it('replaces a truncated cache only after a verified download and removes interrupted partial files', async () => fixture(async (directory) => {
    const script = join(directory, 'verify.ps1')
    // Windows PowerShell 5 needs a BOM to read literal Chinese project paths.
    await writeFile(script, `\uFEFF
$ErrorActionPreference = 'Stop'
. ${quote(resolve('scripts/verified-postgres-download.ps1'))}
$root = ${quote(directory)}
$archive = Join-Path $root 'postgres.zip'
$good = [Text.Encoding]::UTF8.GetBytes('synthetic complete archive')
$sha = [Security.Cryptography.SHA256]::Create()
$digest = ([BitConverter]::ToString($sha.ComputeHash($good))).Replace('-', '')
$sha.Dispose()
[IO.File]::WriteAllText($archive, 'truncated old download')
$script:attempts = 0
$fetch = {
  param($Uri, $Destination)
  $script:attempts++
  if ($script:attempts -eq 1) { [IO.File]::WriteAllText($Destination, 'interrupted bytes'); throw 'network interrupted' }
  [IO.File]::WriteAllBytes($Destination, $good)
}
Save-VerifiedPostgresArchive -ArchivePath $archive -DownloadUrl 'https://example.invalid/test.zip' -ExpectedDigest $digest -Download $fetch
if ($script:attempts -ne 2) { throw 'retry missing' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $digest) { throw 'wrong archive published' }
Save-VerifiedPostgresArchive -ArchivePath $archive -DownloadUrl 'https://example.invalid/test.zip' -ExpectedDigest $digest -Download { throw 'valid cache must be reused' }
if (@(Get-ChildItem -LiteralPath $root -Filter '*.partial-*').Count -ne 0) { throw 'partial leak' }
Write-Output 'VERIFIED_DOWNLOAD_OK'
`, 'utf8')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, env: powerShellEnvironment, timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('VERIFIED_DOWNLOAD_OK')
  }))

  it('refuses repeated mismatches without publishing or extracting unverified bytes', async () => fixture(async (directory) => {
    const script = join(directory, 'refuse.ps1')
    await writeFile(script, `\uFEFF
$ErrorActionPreference = 'Stop'
. ${quote(resolve('scripts/verified-postgres-download.ps1'))}
$root = ${quote(directory)}
$archive = Join-Path $root 'postgres.zip'
[IO.File]::WriteAllText($archive, 'existing invalid cache')
$script:attempts = 0
try {
  Save-VerifiedPostgresArchive -ArchivePath $archive -DownloadUrl 'https://example.invalid/test.zip' -ExpectedDigest ('0' * 64) -MaxAttempts 2 -Download {
    param($Uri, $Destination)
    $script:attempts++
    [IO.File]::WriteAllText($Destination, 'wrong bytes')
  }
  throw 'unexpected success'
} catch {
  if ($_.Exception.Message -notmatch 'no unverified archive was extracted') { throw }
}
if ($script:attempts -ne 2) { throw 'unbounded retries' }
if ([IO.File]::ReadAllText($archive) -ne 'existing invalid cache') { throw 'unverified bytes published' }
if (@(Get-ChildItem -LiteralPath $root -Filter '*.partial-*').Count -ne 0) { throw 'partial leak' }
Write-Output 'MISMATCH_REFUSED_OK'
`, 'utf8')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, env: powerShellEnvironment, timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('MISMATCH_REFUSED_OK')
  }))
})

windows('ZIP launch entry', () => {
  it('launches both extracted layouts in Chinese paths and explains how to extract a lone launcher', async () => fixture(async (directory) => {
    const root = join(directory, '中文目录 & space')
    await mkdir(root)
    const wrapper = join(root, '启动猫思之.cmd')
    await copyFile(resolve('启动猫思之.cmd'), wrapper)
    const run = () => spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', '启动猫思之.cmd'], { cwd: root, input: '\n', encoding: 'utf8', windowsHide: true })
    const missing = run()
    expect(missing.status, missing.stderr).toBe(1)
    expect(missing.stdout).toContain('全部解压')
    const stub = '@echo off\r\necho CAT_LAUNCH_OK\r\nexit /b 7\r\n'
    await writeFile(join(root, 'Start-CatThinking.cmd'), stub)
    const local = run()
    expect(local.status, local.stderr).toBe(7)
    expect(local.stdout).toContain('CAT_LAUNCH_OK')
    await rm(join(root, 'Start-CatThinking.cmd'))
    await mkdir(join(root, 'cat-thinking'))
    await writeFile(join(root, 'cat-thinking', 'Start-CatThinking.cmd'), stub)
    const nested = run()
    expect(nested.status, nested.stderr).toBe(7)
    expect(nested.stdout).toContain('CAT_LAUNCH_OK')
    expect(await readFile(wrapper, 'utf8')).toContain('全部解压')
  }))
})
