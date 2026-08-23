#requires -Version 5.1
<#
.SYNOPSIS
    Builds AudioTap.exe, the WASAPI capture helper.

.DESCRIPTION
    AudioTap is the only part of this project that has to be native code: per-process loopback
    capture goes through ActivateAudioInterfaceAsync, which has no Node binding. Everything else
    runs on Node and ffmpeg.

    Output lands in native/AudioTap/bin/AudioTap.exe, which is where the bot looks by default.
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'native/AudioTap/AudioTap.csproj'
$output = Join-Path $root 'native/AudioTap/bin'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'The .NET SDK is not installed.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Install it with:   winget install Microsoft.DotNet.SDK.10'
    Write-Host '  Or download from:  https://dotnet.microsoft.com/download'
    Write-Host ''
    Write-Host 'Without it you can still use "/stream dshow" with a virtual audio cable,'
    Write-Host 'but per-application capture will not be available.'
    Write-Host ''
    exit 1
}

$dotnetVersion = [version](((dotnet --version) -split '-')[0])
if ($dotnetVersion.Major -lt 10) {
    Write-Error ".NET 10 SDK is required (found $dotnetVersion). Install it with: winget install Microsoft.DotNet.SDK.10"
    exit 1
}

$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) {
    Write-Warning "Windows build $build detected. Per-process loopback needs Windows 10 version 2004 (build 19041) or newer."
}

Write-Host "Building AudioTap -> $output" -ForegroundColor Cyan

dotnet publish $project `
    --configuration Release `
    --output $output `
    --nologo `
    -p:DebugType=none `
    -p:GenerateDocumentationFile=false

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $output 'AudioTap.exe'
if (-not (Test-Path $exe)) {
    Write-Error "Build reported success but $exe is missing."
    exit 1
}

Write-Host ''
Write-Host "Built $exe" -ForegroundColor Green
Write-Host 'Smoke test: listing applications that currently hold an audio session...' -ForegroundColor Cyan
& $exe --list-processes
