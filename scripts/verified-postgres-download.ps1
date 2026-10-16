function Save-VerifiedPostgresArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DownloadUrl,
    [Parameter(Mandatory = $true)][string]$ExpectedDigest,
    [ValidateRange(1, 3)][int]$MaxAttempts = 3,
    [scriptblock]$Download = {
      param($Uri, $Destination)
      Invoke-WebRequest -Uri $Uri -OutFile $Destination -TimeoutSec 600 -UseBasicParsing
    }
  )
  if ($ExpectedDigest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid PostgreSQL archive digest.' }
  if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -eq $ExpectedDigest) { return }
    Write-Host 'PostgreSQL download cache is incomplete or invalid. Downloading a verified replacement...'
  }
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    # Never publish an interrupted download as the reusable archive.
    $partialPath = $ArchivePath + '.partial-' + [Guid]::NewGuid().ToString('N')
    try {
      Write-Host ('Downloading PostgreSQL (' + $attempt + '/' + $MaxAttempts + ')...')
      & $Download $DownloadUrl $partialPath
      if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf) -or
          (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash -ne $ExpectedDigest) {
        throw 'PostgreSQL archive digest mismatch; refusing extraction.'
      }
      Move-Item -LiteralPath $partialPath -Destination $ArchivePath -Force
      return
    } catch {
      if ($attempt -eq $MaxAttempts) {
        throw 'PostgreSQL download did not complete or failed SHA-256 verification. Check the network and start again; no unverified archive was extracted.'
      }
      Write-Host 'Download interrupted or verification failed. Retrying...'
    } finally {
      if (Test-Path -LiteralPath $partialPath -PathType Leaf) { Remove-Item -LiteralPath $partialPath -Force }
    }
  }
}
