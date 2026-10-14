param([ValidateSet('start','stop','verify','backup','restore')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$current = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($current.version -ne 1 -or $current.application -ne 'cat-thinking' -or $current.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Installation metadata is invalid.' }
$program = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('versions\' + $current.release)))
if (-not $program.StartsWith($PSScriptRoot + '\versions\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Program path escaped installation.' }
$node = Join-Path $program 'runtime\node.exe'
$launcher = Join-Path $program 'scripts\desktop\launcher.mjs'
if ($Action -eq 'start') {
  Start-Process -FilePath $node -ArgumentList @('"' + $launcher + '"', 'start', '"' + $current.dataRoot + '"') -WorkingDirectory $program -WindowStyle Hidden
  exit 0
}
if ($Action -in @('stop','verify')) { & $node $launcher $Action $current.dataRoot; exit $LASTEXITCODE }
Write-Output 'Protected backup includes the database and encryption keys plus the course files you select. It does not read your browser profile.'
Write-Output 'Export every course you want to preserve as .mszcourse before stopping CatThinking. Browser documents outside these packages require separate export.'
$securePassword = Read-Host 'Backup password (at least 10 characters)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
if ($Action -eq 'backup') {
  & $node $launcher stop $current.dataRoot
  if ($LASTEXITCODE -ne 0) { throw 'Application shutdown did not complete.' }
  $courseDirectory = Read-Host 'Directory containing ALL exported .mszcourse files to include'
  $files = @(Get-ChildItem -LiteralPath $courseDirectory -Filter '*.mszcourse' -File | Sort-Object Name | Select-Object -ExpandProperty FullName)
  Write-Output ('Selected course package count: ' + $files.Count)
  $confirmation = Read-Host 'Type the selected count to confirm the exported course scope (0 for an empty course collection)'
  if ($confirmation -ne [string]$files.Count) { throw 'Course scope was not confirmed.' }
  $outputPath = Read-Host 'New output .mszfull file path'
  $options = @{password=$password;outputPath=$outputPath;courseFiles=$files;expectedCourseCount=$files.Count;scopeConfirmed=$true}
} else {
  $backupPath = Read-Host 'Existing .mszfull file path'
  $targetRoot = Read-Host 'New EMPTY isolated restore directory (must not exist)'
  $options = @{password=$password;backupPath=$backupPath;targetRoot=$targetRoot}
}
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $node
$info.Arguments = '"' + (Join-Path $program 'scripts\desktop\backup.mjs') + '" ' + $Action + ' "' + $current.dataRoot + '"'
$info.WorkingDirectory = $program
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$process = [Diagnostics.Process]::Start($info)
$process.StandardInput.Write(($options | ConvertTo-Json -Depth 10 -Compress))
$process.StandardInput.Close()
$password = $null
$options = $null
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw 'Backup or isolated restore failed. Existing data was not replaced.' }
Write-Output 'Completed. Restored course packages require explicit import; restored AI execution remains paused.'
