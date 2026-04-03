param(
  [string]$ServiceNames,
  [string]$OutFile
)

$scriptPath = Join-Path $PSScriptRoot 'stop-services.ps1'
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  "& '$scriptPath' -ServiceNames '$ServiceNames' | Out-File -FilePath '$OutFile' -Encoding UTF8")
Start-Process -FilePath 'powershell' -ArgumentList $argList -Verb RunAs -Wait -WindowStyle Hidden
