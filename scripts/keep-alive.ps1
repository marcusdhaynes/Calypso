$ErrorActionPreference = 'Stop'
$calypsoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$calypsoServer = Join-Path $calypsoRoot 'apps\bridge\server.mjs'
if (-not (Test-Path -LiteralPath $calypsoServer)) { throw 'Calypso server file is missing.' }
$calypsoReady = $false
try { $calypsoReady = (Invoke-RestMethod 'http://127.0.0.1:18791/health' -TimeoutSec 2).ok } catch {}
if (-not $calypsoReady) {
    $calypsoNode = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $calypsoNode -ArgumentList ('"' + $calypsoServer + '"') -WorkingDirectory $calypsoRoot -WindowStyle Hidden
}
