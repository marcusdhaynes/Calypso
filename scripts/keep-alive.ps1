$ErrorActionPreference = 'Stop'
$calypsoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$calypsoServer = Join-Path $calypsoRoot 'apps\bridge\server.mjs'
if (-not (Test-Path -LiteralPath $calypsoServer)) { throw 'Calypso server file is missing.' }
$calypsoReady = $false
try { $calypsoReady = (Invoke-RestMethod 'http://127.0.0.1:18791/health' -TimeoutSec 2).ok } catch {}
if (-not $calypsoReady) {
    $env:CALYPSO_DATA_DIR = Join-Path (Split-Path $calypsoRoot -Parent) 'calypso-data'
    $calypsoPackageRoot = Join-Path $env:LOCALAPPDATA 'Packages'
    if (Test-Path -LiteralPath $calypsoPackageRoot) {
        foreach ($calypsoPackage in (Get-ChildItem -LiteralPath $calypsoPackageRoot -Directory -Filter 'OpenAI.Codex_*')) {
            $calypsoCli = Join-Path $calypsoPackage.FullName 'LocalCache\Local\OpenClaw\npm\node_modules\openclaw\openclaw.mjs'
            if (Test-Path -LiteralPath $calypsoCli) { $env:OPENCLAW_CLI = $calypsoCli; break }
        }
    }
    $calypsoNode = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $calypsoNode -ArgumentList ('"' + $calypsoServer + '"') -WorkingDirectory $calypsoRoot -WindowStyle Hidden
}
