param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CatThinking'),
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'CatThinkingData'),
  [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Get-Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $algorithm.Dispose() }
}
$programPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$dataPath = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
function Assert-DirectoryPath([string]$Path) {
  if ($Path -eq [IO.Path]::GetPathRoot($Path).TrimEnd('\')) { throw 'A drive root cannot be used.' }
  if (Test-Path -LiteralPath $Path) { if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation and data roots must not be links.' } }
}
Assert-DirectoryPath $programPath
Assert-DirectoryPath $dataPath
if (Test-Path -LiteralPath (Join-Path $programPath 'current.json')) {
  $existingInstall = Get-Content -LiteralPath (Join-Path $programPath 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($existingInstall.version -ne 1 -or $existingInstall.application -ne 'cat-thinking' -or -not ([IO.Path]::GetFullPath($existingInstall.dataRoot).Equals($dataPath, [StringComparison]::OrdinalIgnoreCase))) { throw 'Existing installation metadata is invalid or uses a different data directory.' }
} elseif ((Test-Path -LiteralPath $programPath) -and (Get-ChildItem -LiteralPath $programPath -Force | Select-Object -First 1)) { throw 'Existing program directory is not an owned CatThinking installation.' }
if ($programPath.Equals($dataPath, [StringComparison]::OrdinalIgnoreCase) -or
  $dataPath.StartsWith($programPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
  $programPath.StartsWith($dataPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Program files and learning data must use separate directories.' }
$lockPath = Join-Path $dataPath 'app.lock'
if (Test-Path -LiteralPath $lockPath) {
  $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue) { throw 'Stop CatThinking using its own Stop shortcut before upgrading. No unrelated process will be stopped.' }
  Remove-Item -LiteralPath $lockPath
}
$zipPath = Join-Path $PSScriptRoot 'payload.zip'
$expectedHash = ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'payload.sha256') -Raw).Trim() -split '\s+')[0]
if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or (Get-Sha256 $zipPath) -ne $expectedHash) { throw 'Package archive hash mismatch.' }
New-Item -ItemType Directory -Path $programPath -Force | Out-Null
$stage = Join-Path $programPath ('.install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if ($archive.Entries.Count -gt 30000) { throw 'Too many package entries.' }
  [long]$totalBytes = 0
  $seen = @{}
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ($name -notmatch '^payload/' -or $name -match '(^|/)\.\.?(/|$)|[:\x00]' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe package entry.' }
    if ($entry.Length -gt 700MB) { throw 'Package entry too large.' }
    $totalBytes += $entry.Length
    if ($totalBytes -gt 2GB) { throw 'Package is too large.' }
    $target = [IO.Path]::GetFullPath((Join-Path $stage $name))
    if (-not $target.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package entry escaped staging directory.' }
    if ($seen.ContainsKey($target.ToLowerInvariant())) { throw 'Duplicate package entry.' }
    $seen[$target.ToLowerInvariant()] = $true
    if ($name.EndsWith('/')) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $archive.Dispose() }
$payload = Join-Path $stage 'payload'
$manifest = Get-Content -LiteralPath (Join-Path $payload 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.application -ne 'cat-thinking' -or $manifest.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Unsupported package manifest.' }
$listed = @{}
foreach ($file in $manifest.files) {
  if ($file.path -match '(^|/)\.\.?(/|$)|[:\\\x00]' -or [IO.Path]::IsPathRooted($file.path)) { throw 'Unsafe manifest path.' }
  $target = [IO.Path]::GetFullPath((Join-Path $payload $file.path))
  if (-not $target.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase) -or $listed.ContainsKey($target.ToLowerInvariant())) { throw 'Invalid or duplicate manifest path.' }
  $listed[$target.ToLowerInvariant()] = $true
  $actual = Get-Item -LiteralPath $target
  if ($actual.PSIsContainer -or $actual.Length -ne $file.bytes -or (Get-Sha256 $target) -ne $file.sha256) { throw 'Payload integrity check failed.' }
}
foreach ($actual in Get-ChildItem -LiteralPath $payload -Recurse -File) { if ($actual.FullName -ne (Join-Path $payload 'manifest.json') -and -not $listed.ContainsKey($actual.FullName.ToLowerInvariant())) { throw 'Unlisted payload file.' } }
$versions = Join-Path $programPath 'versions'
New-Item -ItemType Directory -Path $versions -Force | Out-Null
$destination = [IO.Path]::GetFullPath((Join-Path $versions $manifest.release))
if (-not $destination.StartsWith($versions + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Version directory escaped installation.' }
if (Test-Path -LiteralPath $destination) { throw 'This version is already installed; choose a fresh release number.' }
$ownerPath = Join-Path $dataPath '.cat-thinking-data.json'
$installId = [Guid]::NewGuid().ToString()
if (Test-Path -LiteralPath $ownerPath) {
  $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($owner.version -ne 1 -or $owner.application -ne 'cat-thinking' -or -not ([IO.Path]::GetFullPath($owner.dataRoot).Equals($dataPath, [StringComparison]::OrdinalIgnoreCase))) { throw 'Existing data ownership is invalid; refusing replacement.' }
  $installId = $owner.installId
} elseif ((Test-Path -LiteralPath $dataPath) -and (Get-ChildItem -LiteralPath $dataPath -Force | Select-Object -First 1)) { throw 'Existing nonempty data directory is not owned by CatThinking.' }
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
@{version=1; application='cat-thinking'; installId=$installId; dataRoot=$dataPath} | ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
$currentPath = Join-Path $programPath 'current.json'
$upgrading = Test-Path -LiteralPath $currentPath
Move-Item -LiteralPath $payload -Destination $destination
foreach ($name in @('launch.ps1', 'uninstall.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $programPath $name) -Force }
if ($upgrading) {
  Copy-Item -LiteralPath $currentPath -Destination (Join-Path $programPath 'previous.json') -Force
  @{version=1; pause=$true; reason='upgrade'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataPath 'pause-provider.json') -Encoding UTF8
}
$pointer = @{version=1; application='cat-thinking'; release=$manifest.release; installId=$installId; dataRoot=$dataPath; programRoot=$programPath}
$pointer | ConvertTo-Json | Set-Content -LiteralPath ($currentPath + '.next') -Encoding UTF8
Move-Item -LiteralPath ($currentPath + '.next') -Destination $currentPath -Force
if (-not $SkipShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  $menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\CatThinking'
  New-Item -ItemType Directory -Path $menu -Force | Out-Null
  foreach ($item in @(@{Name='CatThinking';Action='start'}, @{Name='Stop CatThinking';Action='stop'}, @{Name='Protected backup';Action='backup'}, @{Name='Restore backup to isolated folder';Action='restore'})) {
    $shortcut = $shell.CreateShortcut((Join-Path $menu ($item.Name + '.lnk')))
    $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $programPath 'launch.ps1') + '" -Action ' + $item.Action
    $shortcut.WorkingDirectory = $programPath
    $shortcut.WindowStyle = $(if ($item.Action -in @('start','stop')) {7} else {1})
    $shortcut.Save()
  }
  Copy-Item -LiteralPath (Join-Path $menu 'CatThinking.lnk') -Destination (Join-Path ([Environment]::GetFolderPath('Desktop')) 'CatThinking.lnk') -Force
}
$resolvedStage = [IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith($programPath + '\.install-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging cleanup scope invalid.' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Write-Output ('Installed CatThinking ' + $manifest.release + '. Data remains in ' + $dataPath + '. No database, browser or AI connection was started.')
