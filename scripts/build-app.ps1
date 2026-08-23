#requires -Version 5.1
<#
.SYNOPSIS
    Builds the desktop control panel (DiscordAudioBridge.exe).

.PARAMETER Run
    Launch the app once it is built.

.DESCRIPTION
    The desktop app is a thin WinForms shell hosting WebView2, pointed at the control panel the
    bot already serves on loopback. It ships in a few megabytes because WebView2 is part of
    Windows; nothing here bundles a browser.

    The same UI is reachable without this app: run `npm start` and open the URL it prints.
#>

param([switch]$Run)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'desktop/BridgeApp/BridgeApp.csproj'
$output = Join-Path $root 'desktop/BridgeApp/bin'
$exe = Join-Path $output 'DiscordAudioBridge.exe'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'The .NET SDK is not installed.' -ForegroundColor Red
    Write-Host '  Install it with:  winget install Microsoft.DotNet.SDK.10'
    Write-Host ''
    Write-Host 'You can still use the control panel without the desktop app:'
    Write-Host '  npm start   then open the URL it prints in any browser.'
    Write-Host ''
    exit 1
}

$dotnetVersion = [version](((dotnet --version) -split '-')[0])
if ($dotnetVersion.Major -lt 10) {
    Write-Error ".NET 10 SDK is required (found $dotnetVersion). Install it with: winget install Microsoft.DotNet.SDK.10"
    exit 1
}

Write-Host "Building the desktop app -> $output" -ForegroundColor Cyan

dotnet publish $project `
    --configuration Release `
    --output $output `
    --nologo `
    -p:DebugType=none

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path $exe)) {
    Write-Error "Build reported success but $exe is missing."
    exit 1
}

$size = [math]::Round(((Get-ChildItem $output -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ''
Write-Host "Built $exe ($size MB)" -ForegroundColor Green

# WebView2 ships with Windows 11 and current Windows 10, but say so plainly if it is absent.
$runtimeKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$hasRuntime = $runtimeKeys | Where-Object { Test-Path $_ }

if (-not $hasRuntime) {
    Write-Warning 'The WebView2 runtime was not detected. Install it from:'
    Write-Warning '  https://developer.microsoft.com/microsoft-edge/webview2/'
}

if ($Run) {
    Write-Host 'Launching...' -ForegroundColor Cyan
    Start-Process $exe
}
