$ErrorActionPreference = 'Stop'
$calypsoSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$calypsoEngine = Join-Path $env:USERPROFILE '.openclaw\team\calypso-engine'
$calypsoData = Join-Path $env:USERPROFILE '.openclaw\team\calypso-data'
$calypsoOldData = Join-Path $env:LOCALAPPDATA 'Calypso\Unified'
if (-not (Test-Path -LiteralPath (Join-Path $calypsoData 'state.json'))) {
    New-Item -ItemType Directory -Force $calypsoData | Out-Null
    if (Test-Path -LiteralPath $calypsoOldData) {
        Get-ChildItem -LiteralPath $calypsoOldData -Force | Where-Object Name -ne '.engine.lock' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $calypsoData -Recurse -Force }
        $calypsoStateFile = Join-Path $calypsoData 'state.json'
        if (Test-Path -LiteralPath $calypsoStateFile) {
            $calypsoState = Get-Content -LiteralPath $calypsoStateFile -Raw | ConvertFrom-Json
            foreach ($calypsoProject in $calypsoState.projects) {
                if ($calypsoProject.folder.StartsWith($calypsoOldData, [StringComparison]::OrdinalIgnoreCase)) { $calypsoProject.folder = $calypsoProject.folder.Replace($calypsoOldData, $calypsoData) }
                foreach ($calypsoPhase in $calypsoProject.tasks) {
                    if ($calypsoPhase.reportPath -and $calypsoPhase.reportPath.StartsWith($calypsoOldData, [StringComparison]::OrdinalIgnoreCase)) { $calypsoPhase.reportPath = $calypsoPhase.reportPath.Replace($calypsoOldData, $calypsoData) }
                }
            }
            $calypsoState | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $calypsoStateFile -Encoding utf8
        }
    }
}
foreach ($part in @('apps\bridge','apps\web','scripts')) { New-Item -ItemType Directory -Force (Join-Path $calypsoEngine $part) | Out-Null }
Copy-Item -LiteralPath (Join-Path $calypsoSource 'apps\bridge\server.mjs') -Destination (Join-Path $calypsoEngine 'apps\bridge\server.mjs')
foreach ($asset in @('index.html','app.js','store.js','styles.css','icon.svg','manifest.webmanifest','sw.js')) {
    Copy-Item -LiteralPath (Join-Path $calypsoSource ('apps\web\' + $asset)) -Destination (Join-Path $calypsoEngine ('apps\web\' + $asset))
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'keep-alive.ps1') -Destination (Join-Path $calypsoEngine 'scripts\keep-alive.ps1')
$calypsoAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$calypsoAction = New-ScheduledTaskAction -Execute 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $calypsoEngine 'scripts\keep-alive.ps1') + '"')
$calypsoLogin = New-ScheduledTaskTrigger -AtLogOn -User $calypsoAccount
$calypsoRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$calypsoPrincipal = New-ScheduledTaskPrincipal -UserId $calypsoAccount -LogonType Interactive -RunLevel Limited
$calypsoSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 45)
Register-ScheduledTask -TaskName 'Calypso Background Engine' -Action $calypsoAction -Trigger @($calypsoLogin,$calypsoRepeat) -Principal $calypsoPrincipal -Settings $calypsoSettings -Description 'Keep the local Calypso engine ready quietly at sign-in and recover stopped processes.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Calypso Background Engine'
Write-Output ('Calypso background engine installed at ' + $calypsoEngine)
