# Aural interview system production release launcher.
# Compatible with Windows PowerShell 5.1: if started under 5.1 it finds
# PowerShell 7 (pwsh) and re-invokes the core script with all arguments.
# This file is intentionally ASCII-only so legacy consoles cannot corrupt it.
param(
  [string]$Revision = "HEAD",
  [string]$WslDistribution = "Ubuntu",
  [string]$IdentityFile = "",
  [string]$JumpHost = "root@123.57.152.131",
  [string]$TargetHost = "root@172.28.145.158",
  [string]$PublicBaseUrl = "https://agitest.yifx.vip",
  [switch]$Apply,
  [switch]$ForceRebuild,
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
$core = Join-Path $PSScriptRoot "release.core.ps1"
if (-not (Test-Path $core)) {
  Write-Error "release.core.ps1 not found next to this launcher."
  exit 1
}

if ($PSVersionTable.PSVersion.Major -ge 7) {
  try {
    & $core @PSBoundParameters
    exit $LASTEXITCODE
  } catch {
    Write-Error $_
    exit 1
  }
}

$pwshCandidates = @()
try { $pwshCandidates += (Get-Command pwsh -ErrorAction Stop).Source } catch {}
$pwshCandidates += Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"
$pwsh = $pwshCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $pwsh) {
  Write-Host ""
  Write-Host "ERROR: PowerShell 7 (pwsh) is required but was not found." -ForegroundColor Red
  Write-Host "Install it with: winget install Microsoft.PowerShell"
  Write-Host "Then rerun this script. No tests, builds, or SSH actions were started."
  exit 1
}

$relayArgs = @("-NoProfile", "-File", $core)
foreach ($key in @($PSBoundParameters.Keys)) {
  $value = $PSBoundParameters[$key]
  if ($value -is [System.Management.Automation.SwitchParameter]) {
    if ($value.IsPresent) { $relayArgs += "-$key" }
  } else {
    $relayArgs += @("-$key", "$value")
  }
}

Write-Host "Handing off to PowerShell 7: $pwsh" -ForegroundColor Yellow
& $pwsh @relayArgs
exit $LASTEXITCODE
