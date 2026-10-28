# dsh-session-archive installer (Windows PowerShell)
# Usage:
#   .\install.ps1                 # install into the "desktop" profile
#   .\install.ps1 -Profile web    # install into another profile
#   .\install.ps1 -Uninstall      # remove it again (keeps your session files untouched)
#
# It only edits the profile's package.json and creates a junction in node_modules.
# Your session files are never touched. A backup of package.json is written first.

param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$Name = 'dsh-session-archive'

if (-not $PluginDir) {
  $PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$PluginDir = (Resolve-Path $PluginDir).Path

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$PkgPath = Join-Path $ProfileDir 'package.json'
$NodeModules = Join-Path $ProfileDir 'node_modules'
$LinkPath = Join-Path $NodeModules $Name

if (-not (Test-Path $PkgPath)) {
  Write-Host "ERROR: profile not found: $ProfileDir" -ForegroundColor Red
  Write-Host "Available profiles:"
  $profilesRoot = Join-Path $DshHome 'profiles'
  if (Test-Path $profilesRoot) { Get-ChildItem $profilesRoot -Directory | ForEach-Object { Write-Host "  - $($_.Name)" } }
  exit 1
}

if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  Write-Host "ERROR: $PluginDir does not look like the plugin directory (no package.json)." -ForegroundColor Red
  exit 1
}

# ---------- backup ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$PkgPath.bak-$stamp"
Copy-Item $PkgPath $backup
Write-Host "backup : $backup"

# ---------- load json as text (keep formatting as much as possible) ----------
$raw = Get-Content $PkgPath -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json

if ($Uninstall) {
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $Name })
  }
  if ($json.dependencies -and $json.dependencies.PSObject.Properties[$Name]) {
    $json.dependencies.PSObject.Properties.Remove($Name)
  }
  if (Test-Path $LinkPath) {
    # only remove the link itself, never the plugin source
    (Get-Item $LinkPath).Delete()
    Write-Host "link    : removed $LinkPath"
  }
  $json | ConvertTo-Json -Depth 20 | Set-Content -Path $PkgPath -Encoding UTF8
  Write-Host "OK: uninstalled. Restart DSH." -ForegroundColor Green
  exit 0
}

# ---------- add to profile ----------
if (-not $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object PSObject) }
if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object PSObject) }
if (-not $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

$changed = $false
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains $Name) {
  $changed = $true
  $json.dsh.profile.bundles = @($bundles + $Name)
  Write-Host "profile : added '$Name' to bundles"
} else {
  Write-Host "profile : already in bundles"
}

if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object PSObject) }
$depValue = 'link:' + ($PluginDir -replace '\\', '/')
if ($json.dependencies.PSObject.Properties[$Name]) {
  if ($json.dependencies.$Name -ne $depValue) { $changed = $true }
  $json.dependencies.$Name = $depValue
} else {
  $changed = $true
  $json.dependencies | Add-Member -NotePropertyName $Name -NotePropertyValue $depValue
}
Write-Host "profile : dependency -> $depValue"

if ($changed) {
  $json | ConvertTo-Json -Depth 20 | Set-Content -Path $PkgPath -Encoding UTF8
  Write-Host "profile : package.json updated"
} else {
  Write-Host "profile : no change needed (already installed with the same path)"
  Remove-Item $backup -ErrorAction SilentlyContinue
}

# ---------- junction ----------
if (-not (Test-Path $NodeModules)) { New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null }
if (Test-Path $LinkPath) {
  Write-Host "link    : already exists ($LinkPath)"
} else {
  try {
    New-Item -ItemType Junction -Path $LinkPath -Target $PluginDir | Out-Null
    Write-Host "link    : $LinkPath -> $PluginDir"
  } catch {
    Write-Host "WARN: could not create junction. If links are not allowed on this machine, run this once instead (as the current user):" -ForegroundColor Yellow
    Write-Host "      cmd /c mklink /J `"$LinkPath`" `"$PluginDir`""
    Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkYellow
  }
}

Write-Host ''
Write-Host "OK: installed into profile '$Profile'." -ForegroundColor Green
Write-Host 'Next: fully restart DSH (quit it, then start it again).'
Write-Host 'After restart you should see the tool "session_archive" and a startup hint.'
Write-Host 'Rollback: copy the .bak-* file back over package.json, or run .\install.ps1 -Uninstall'
