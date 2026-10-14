param([switch]$DeleteData, [switch]$SkipShortcuts)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$current = Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($current.version -ne 1 -or $current.application -ne 'cat-thinking' -or -not ([IO.Path]::GetFullPath($current.programRoot).TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase))) { throw 'Installation ownership invalid.' }
$data = [IO.Path]::GetFullPath($current.dataRoot).TrimEnd('\')
if ($data -eq [IO.Path]::GetPathRoot($data).TrimEnd('\') -or $data.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($data + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe data location.' }
$owner = Get-Content -LiteralPath (Join-Path $data '.cat-thinking-data.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($owner.application -ne 'cat-thinking' -or $owner.installId -ne $current.installId -or -not ([IO.Path]::GetFullPath($owner.dataRoot).TrimEnd('\').Equals($data, [StringComparison]::OrdinalIgnoreCase))) { throw 'Data ownership invalid.' }
if (Test-Path -LiteralPath (Join-Path $data 'app.lock')) {
  $version = Join-Path $root ('versions\' + $current.release)
  & (Join-Path $version 'runtime\node.exe') (Join-Path $version 'scripts\desktop\launcher.mjs') stop $data
  if ($LASTEXITCODE -ne 0) { throw 'Owned application did not stop; uninstall cancelled. No unrelated process was killed.' }
}
$versions = [IO.Path]::GetFullPath((Join-Path $root 'versions'))
if (Test-Path -LiteralPath $versions) {
  foreach ($directory in Get-ChildItem -LiteralPath $versions -Directory) {
    $target = [IO.Path]::GetFullPath($directory.FullName)
    if (-not $target.StartsWith($root + '\versions\', [StringComparison]::OrdinalIgnoreCase) -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Version cleanup escaped installation.' }
    $manifest = Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.application -ne 'cat-thinking') { throw 'Foreign version directory; refusing deletion.' }
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Remove-Item -LiteralPath $versions
}
if (-not $SkipShortcuts) {
  $shortcutPaths = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'CatThinking.lnk'))
  $menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\CatThinking'
  foreach ($name in @('CatThinking','Stop CatThinking','Protected backup','Restore backup to isolated folder')) { $shortcutPaths += Join-Path $menu ($name + '.lnk') }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($path in $shortcutPaths) { if (Test-Path -LiteralPath $path) { $shortcut = $shell.CreateShortcut($path); if ($shortcut.Arguments.Contains((Join-Path $root 'launch.ps1'))) { Remove-Item -LiteralPath $path } } }
}
foreach ($name in @('current.json','previous.json','launch.ps1')) { $path = Join-Path $root $name; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }
if ($DeleteData) {
  $resolvedData = [IO.Path]::GetFullPath($data)
  if ($resolvedData -eq [IO.Path]::GetPathRoot($resolvedData).TrimEnd('\') -or $resolvedData.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Data deletion scope invalid.' }
  if ((Get-Item -LiteralPath $resolvedData).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Data directory became a link; deletion refused.' }
  Remove-Item -LiteralPath $resolvedData -Recurse -Force
  Write-Output 'Owned program files and explicitly selected data were removed.'
} else { Write-Output ('Program files removed. Data and encryption keys were preserved at ' + $data) }
