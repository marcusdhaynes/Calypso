@echo off
setlocal
set "CALYPSO_INSTALLER=%~f0"
powershell.exe -NoProfile -NonInteractive -Command "$s=[IO.File]::ReadAllText($env:CALYPSO_INSTALLER); $m=[regex]::Match($s,'(?ms)^:POWERSHELL\r?\n(.*)\z'); if(-not $m.Success){throw 'Installer payload missing'}; & ([scriptblock]::Create($m.Groups[1].Value))"
if errorlevel 1 (
 echo Calypso installation did not complete. Your files were not deleted.
 pause
 exit /b 1
)
exit /b 0
:POWERSHELL
$ErrorActionPreference='Stop'
$publisher='https://marcusdhaynes.github.io/Calypso/'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$major=[int]((& $node --version).TrimStart('v').Split('.')[0])
if($major -lt 22){throw 'Calypso needs Node.js 22 or newer from https://nodejs.org/'}
$health=$null
try{$health=Invoke-RestMethod 'http://127.0.0.1:18791/health' -TimeoutSec 3}catch{}
if($health -and $health.product -ne 'Calypso'){throw 'Port 18791 belongs to another application.'}
if($health -and $health.managedUpdates){Start-Process ($publisher+'#settings');exit 0}
Write-Host 'Downloading the tested Calypso engine...'
$m=Invoke-RestMethod ($publisher+'engine-manifest.json') -TimeoutSec 30
if($m.schema -ne 1 -or $m.revision -lt 1 -or $m.commit -notmatch '^[a-f0-9]{40}$' -or $m.files.Count -gt 60){throw 'Invalid update manifest.'}
$installRoot=Join-Path $env:LOCALAPPDATA 'Calypso\Engine'
$stage=Join-Path $installRoot ('stage-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try{
 $seen=@{}
 foreach($file in $m.files){
  if(($file.path -notmatch '^bridge/[a-z0-9-]+\.mjs -or $file.size -lt 1 -or $file.size -gt 2000000 -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($file.path)){throw 'Invalid update file.'}
  $seen[$file.path]=$true;$dest=Join-Path $stage $file.path
  New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/marcusdhaynes/Calypso/'+$m.commit+'/apps/'+$file.path) -OutFile $dest -TimeoutSec 60
  if((Get-Item -LiteralPath $dest).Length -ne $file.size -or (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant() -ne $file.sha256){throw ('Checksum failed: '+$file.path)}
 }
 foreach($required in @('bridge/server.mjs','bridge/supervisor.mjs','bridge/update-manifest.mjs','web/index.html','web/app.js','web/store.js')){if(-not $seen.ContainsKey($required)){throw ('Missing '+$required)}}
 $status=$null;$state=$null;$oldProcess=$null
 if($health){
  $status=Invoke-RestMethod 'http://127.0.0.1:18791/api/status' -TimeoutSec 10
  $state=Invoke-RestMethod 'http://127.0.0.1:18791/api/state' -TimeoutSec 10
  if($state.busy -or @($state.conversations | ForEach-Object {$_.messages} | Where-Object {$_.status -eq 'streaming'}).Count -gt 0 -or $status.verificationBusy -or $status.modelSetup.phase -in @('installing','starting','downloading','testing')){throw 'Calypso is busy. Let its current task finish, then run this installer again.'}
  $owners=@(Get-NetTCPConnection -LocalPort 18791 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count -ne 1){throw 'Could not uniquely identify the Calypso process.'}
  $oldProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owners[0])
  if($oldProcess.Name -ne 'node.exe' -or $oldProcess.CommandLine -notmatch '(?i)calypso.*[\\/]apps[\\/]bridge[\\/]server\.mjs'){throw 'Please quit the old Calypso desktop app once, then run this installer again.'}
 }
 $legacyData=Join-Path $env:USERPROFILE '.openclaw\team\calypso-data'
 $normalData=Join-Path $env:LOCALAPPDATA 'Calypso\Unified'
 $data=$normalData
 if($status -and $status.dataRoot){$data=[IO.Path]::GetFullPath([string]$status.dataRoot)}
 elseif(Test-Path -LiteralPath (Join-Path $legacyData 'state.json')){$data=$legacyData}
 $destRoot=Join-Path $installRoot ('build-'+$m.revision+'-'+[Guid]::NewGuid().ToString('N'))
 Move-Item -LiteralPath $stage -Destination $destRoot;$stage=$null
 $config=Join-Path $destRoot 'engine-config.json'
 [IO.File]::WriteAllText($config,(@{dataRoot=$data}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $supervisor=Join-Path $destRoot 'bridge\supervisor.mjs'
 $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $launcher=Join-Path $destRoot 'launch.vbs'
 $command='"'+$node+'" "'+$supervisor+'"'
 $vbs='Set sh = CreateObject("WScript.Shell")'+[Environment]::NewLine+'WScript.Quit sh.Run("'+$command.Replace('"','""')+'", 0, True)'
 [IO.File]::WriteAllText($launcher,$vbs,[Text.Encoding]::Unicode)
 $action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('"'+$launcher+'"') -WorkingDirectory $destRoot
 $trigger=New-ScheduledTaskTrigger -AtLogOn -User $account
 $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
 $principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
 $task=Get-ScheduledTask -TaskName 'Calypso Background Engine' -ErrorAction SilentlyContinue
 $oldXml=$null
 if($task){$oldXml=Export-ScheduledTask -TaskName 'Calypso Background Engine';Disable-ScheduledTask -InputObject $task | Out-Null}
 try{
  if($oldProcess){
   $children=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$oldProcess.ProcessId))
   foreach($p in $children){if($p.Name -eq 'llama-server.exe' -and $p.ExecutablePath -and $p.ExecutablePath.StartsWith((Join-Path $data 'local-inference'),[StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $p.ProcessId -ErrorAction Stop}}
   Stop-Process -Id $oldProcess.ProcessId -ErrorAction Stop
   Wait-Process -Id $oldProcess.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
  }
  Register-ScheduledTask -TaskName 'Calypso Background Engine' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'Calypso Background Engine'
 }catch{
  if($oldXml){Register-ScheduledTask -TaskName 'Calypso Background Engine' -Xml $oldXml -Force | Out-Null;Enable-ScheduledTask -TaskName 'Calypso Background Engine' | Out-Null;Start-ScheduledTask -TaskName 'Calypso Background Engine'}
  throw
 }
 Write-Host 'Calypso automatic updates installed. Opening Calypso...'
 Start-Process ($publisher+'#settings')
}finally{if($stage -and (Test-Path -LiteralPath $stage)){Remove-Item -LiteralPath $stage -Recurse -Force}}
 -and $file.path -notin @('web/index.html','web/app.js','web/store.js','web/styles.css','web/icon.svg','web/manifest.webmanifest','web/sw.js','web/updates.js')) -or $file.size -lt 1 -or $file.size -gt 2000000 -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($file.path)){throw 'Invalid update file.'}
  $seen[$file.path]=$true;$dest=Join-Path $stage $file.path
  New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/marcusdhaynes/Calypso/'+$m.commit+'/apps/'+$file.path) -OutFile $dest -TimeoutSec 60
  if((Get-Item -LiteralPath $dest).Length -ne $file.size -or (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant() -ne $file.sha256){throw ('Checksum failed: '+$file.path)}
 }
 foreach($required in @('bridge/server.mjs','bridge/supervisor.mjs','bridge/update-manifest.mjs','web/index.html','web/app.js','web/store.js')){if(-not $seen.ContainsKey($required)){throw ('Missing '+$required)}}
 $status=$null;$state=$null;$oldProcess=$null
 if($health){
  $status=Invoke-RestMethod 'http://127.0.0.1:18791/api/status' -TimeoutSec 10
  $state=Invoke-RestMethod 'http://127.0.0.1:18791/api/state' -TimeoutSec 10
  if($state.busy -or @($state.conversations | ForEach-Object {$_.messages} | Where-Object {$_.status -eq 'streaming'}).Count -gt 0 -or $status.verificationBusy -or $status.modelSetup.phase -in @('installing','starting','downloading','testing')){throw 'Calypso is busy. Let its current task finish, then run this installer again.'}
  $owners=@(Get-NetTCPConnection -LocalPort 18791 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count -ne 1){throw 'Could not uniquely identify the Calypso process.'}
  $oldProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owners[0])
  if($oldProcess.Name -ne 'node.exe' -or $oldProcess.CommandLine -notmatch '(?i)calypso.*[\\/]apps[\\/]bridge[\\/]server\.mjs'){throw 'Please quit the old Calypso desktop app once, then run this installer again.'}
 }
 $legacyData=Join-Path $env:USERPROFILE '.openclaw\team\calypso-data'
 $normalData=Join-Path $env:LOCALAPPDATA 'Calypso\Unified'
 $data=$normalData
 if($status -and $status.dataRoot){$data=[IO.Path]::GetFullPath([string]$status.dataRoot)}
 elseif(Test-Path -LiteralPath (Join-Path $legacyData 'state.json')){$data=$legacyData}
 $destRoot=Join-Path $installRoot ('build-'+$m.revision+'-'+[Guid]::NewGuid().ToString('N'))
 Move-Item -LiteralPath $stage -Destination $destRoot;$stage=$null
 $config=Join-Path $destRoot 'engine-config.json'
 [IO.File]::WriteAllText($config,(@{dataRoot=$data}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $supervisor=Join-Path $destRoot 'bridge\supervisor.mjs'
 $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $launcher=Join-Path $destRoot 'launch.vbs'
 $command='"'+$node+'" "'+$supervisor+'"'
 $vbs='Set sh = CreateObject("WScript.Shell")'+[Environment]::NewLine+'WScript.Quit sh.Run("'+$command.Replace('"','""')+'", 0, True)'
 [IO.File]::WriteAllText($launcher,$vbs,[Text.Encoding]::Unicode)
 $action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('"'+$launcher+'"') -WorkingDirectory $destRoot
 $trigger=New-ScheduledTaskTrigger -AtLogOn -User $account
 $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
 $principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
 $task=Get-ScheduledTask -TaskName 'Calypso Background Engine' -ErrorAction SilentlyContinue
 $oldXml=$null
 if($task){$oldXml=Export-ScheduledTask -TaskName 'Calypso Background Engine';Disable-ScheduledTask -InputObject $task | Out-Null}
 try{
  if($oldProcess){
   $children=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$oldProcess.ProcessId))
   foreach($p in $children){if($p.Name -eq 'llama-server.exe' -and $p.ExecutablePath -and $p.ExecutablePath.StartsWith((Join-Path $data 'local-inference'),[StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $p.ProcessId -ErrorAction Stop}}
   Stop-Process -Id $oldProcess.ProcessId -ErrorAction Stop
   Wait-Process -Id $oldProcess.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
  }
  Register-ScheduledTask -TaskName 'Calypso Background Engine' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'Calypso Background Engine'
 }catch{
  if($oldXml){Register-ScheduledTask -TaskName 'Calypso Background Engine' -Xml $oldXml -Force | Out-Null;Enable-ScheduledTask -TaskName 'Calypso Background Engine' | Out-Null;Start-ScheduledTask -TaskName 'Calypso Background Engine'}
  throw
 }
 Write-Host 'Calypso automatic updates installed. Opening Calypso...'
 Start-Process ($publisher+'#settings')
}finally{if($stage -and (Test-Path -LiteralPath $stage)){Remove-Item -LiteralPath $stage -Recurse -Force}}
