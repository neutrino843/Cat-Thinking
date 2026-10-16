$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '..\.cat-thinking-postgres'))
$archivePath = Join-Path $runtimeRoot 'postgresql-18.6-5-windows-x64-binaries.zip'
$downloadUrl = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip'
# Digest recorded from the official HTTPS download; not an independently signed vendor checksum.
$expectedDigest = 'E2246BA91D22345BC3D017586C09EDE52D9DF180B1EEB480F050445F1CAD84E2'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$postgresPath = Join-Path $runtimeRoot 'pgsql\bin\postgres.exe'
if (Test-Path -LiteralPath $postgresPath) {
  $version = & $postgresPath --version
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '18\.6') { throw 'Unexpected existing PostgreSQL version; refusing replacement.' }
  Write-Output 'PostgreSQL 18.6 binaries already installed.'
  exit 0
}
. (Join-Path $PSScriptRoot 'verified-postgres-download.ps1')
Save-VerifiedPostgresArchive -ArchivePath $archivePath -DownloadUrl $downloadUrl -ExpectedDigest $expectedDigest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/') { continue }
    $target = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $entry.FullName))
    if (-not $target.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped runtime directory.' }
    if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $archive.Dispose() }
$version = & $postgresPath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '18\.6') { throw 'PostgreSQL executable verification failed.' }
@{ version = '18.6'; source = $downloadUrl; sha256 = $expectedDigest.ToLowerInvariant(); installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'installation.json') -Encoding UTF8
Write-Output 'PostgreSQL 18.6 installed locally; no global PATH or Windows service changes.'
