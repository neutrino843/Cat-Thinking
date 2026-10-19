param([Parameter(Mandatory=$true)][string]$Workspace, [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9-]{36}$')][string]$RunId)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$evidencePath = Join-Path $workspacePath ".local-ai-validation/guard-$RunId"
$groupName = "CatThinking-Offline-Acceptance-$RunId"
$ownedRules = @()
try {
  if (-not (Test-Path -LiteralPath $evidencePath -PathType Container)) { throw 'Evidence directory must already exist' }
  $programs = @('runtime/ollama/ollama.exe', 'runtime/ollama/lib/ollama/llama-server.exe', '.local-ai-validation/runtime/node.exe') | ForEach-Object {
    $candidate = (Resolve-Path -LiteralPath (Join-Path $workspacePath $_)).Path
    if (-not $candidate.StartsWith($workspacePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Program outside workspace' }
    $candidate
  }
  $profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
  if (@($profiles | Where-Object { -not $_.Enabled }).Count -gt 0) { throw 'A firewall profile is disabled; refusing an unenforced offline claim' }
  $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 11434 -State Listen)
  if ($listener.Count -ne 1) { throw 'Expected exactly one owned engine listener' }
  $engineOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
  if (-not [String]::Equals($engineOwner.ExecutablePath, $programs[0], [StringComparison]::OrdinalIgnoreCase)) { throw 'Engine listener belongs to another executable' }
  $engineReceipt = @{ processId=$engineOwner.ProcessId; executable=$engineOwner.ExecutablePath; localAddress='127.0.0.1'; port=11434 }
  foreach ($program in $programs) {
    $ruleName = "$groupName-$($ownedRules.Count)"
    New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Group $groupName -Direction Outbound -Action Block -Program $program -Profile Any -Enabled True -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
    $ownedRules += $ruleName
  }
  @{ runId=$RunId; ready=$true; at=[DateTime]::UtcNow.ToString('o'); scope='selected-process-external-network'; programs=$programs; rules=$ownedRules; profiles=$profiles; engine=$engineReceipt } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidencePath 'ready.json') -Encoding utf8
  $expires = [DateTime]::UtcNow.AddMinutes(120)
  while (-not (Test-Path -LiteralPath (Join-Path $evidencePath 'finish')) -and [DateTime]::UtcNow -lt $expires) { Start-Sleep -Seconds 2 }
} catch {
  @{ ready=$false; at=[DateTime]::UtcNow.ToString('o'); error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidencePath 'error.json') -Encoding utf8
} finally {
  foreach ($ruleName in $ownedRules) { Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue }
  $remaining = @(Get-NetFirewallRule -Group $groupName -ErrorAction SilentlyContinue)
  @{ runId=$RunId; at=[DateTime]::UtcNow.ToString('o'); remainingRules=$remaining.Count; cleanupComplete=($remaining.Count -eq 0) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidencePath 'cleanup.json') -Encoding utf8
}
