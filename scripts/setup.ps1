#requires -Version 5.1
<#
.SYNOPSIS
    One-shot setup: checks prerequisites, installs dependencies, builds both native components,
    and creates .env from the example.

.DESCRIPTION
    Safe to re-run. Nothing here overwrites an existing .env.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$problems = @()

function Test-Tool {
    param([string]$Name, [string]$Command, [string[]]$Arguments, [string]$Install, [switch]$Optional)

    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $found) {
        $label = if ($Optional) { 'OPTIONAL' } else { 'MISSING ' }
        $colour = if ($Optional) { 'Yellow' } else { 'Red' }
        Write-Host ("  [{0}] {1,-12} not found" -f $label, $Name) -ForegroundColor $colour
        Write-Host ("               {0}" -f $Install) -ForegroundColor DarkGray
        if (-not $Optional) { $script:problems += $Name }
        return $false
    }

    $version = (& $Command @Arguments 2>&1 | Select-Object -First 1)
    Write-Host ("  [   OK   ] {0,-12} {1}" -f $Name, $version) -ForegroundColor Green
    return $true
}

Write-Host ''
Write-Host 'Checking prerequisites' -ForegroundColor Cyan

$hasNode = Test-Tool -Name 'Node.js' -Command 'node' -Arguments @('--version') `
    -Install 'winget install OpenJS.NodeJS.LTS   (needs 22.18 or newer)'
Test-Tool -Name 'ffmpeg' -Command 'ffmpeg' -Arguments @('-version') `
    -Install 'winget install Gyan.FFmpeg' | Out-Null
$hasDotnet = Test-Tool -Name '.NET SDK' -Command 'dotnet' -Arguments @('--version') `
    -Install 'winget install Microsoft.DotNet.SDK.9' -Optional

if ($hasNode) {
    $nodeVersion = [version](((node --version) -replace '^v', '') -split '-')[0]
    if ($nodeVersion -lt [version]'22.18.0') {
        Write-Host "  [ TOO OLD ] Node $nodeVersion - this project runs TypeScript directly and needs 22.18+" -ForegroundColor Red
        $problems += 'Node.js version'
    }
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host "Install the missing prerequisites above, then run this again." -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'Installing npm dependencies' -ForegroundColor Cyan
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($hasDotnet) {
    Write-Host ''
    Write-Host 'Building AudioTap (per-application capture)' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-native.ps1')

    Write-Host ''
    Write-Host 'Building the desktop control panel' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-app.ps1')
} else {
    Write-Host ''
    Write-Warning 'Skipping the native builds: no .NET SDK.'
    Write-Warning 'The bot still works, but per-application capture and the desktop app will not be available.'
}

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Write-Host ''
    Write-Host 'Created .env from .env.example' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host ''
Write-Host '  Next:'
Write-Host '    1. Put your bot token and application ID in .env'
Write-Host '       (or start the app and use the Setup tab)'
Write-Host '    2. npm run app       launch the desktop control panel'
Write-Host '       npm start         or run headless and open the printed URL'
Write-Host '    3. npm run register  publish the slash commands'
Write-Host ''
