$items = @()

$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
)
foreach ($p in $paths) {
  try {
    $key = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
    if ($key) {
      $key.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
        $items += [PSCustomObject]@{
          Name    = $_.Name
          Command = $_.Value
          Source  = if ($p -like 'HKLM*') { 'HKLM' } else { 'HKCU' }
          Type    = 'Registry'
        }
      }
    }
  } catch {}
}

$startupFolder = [System.Environment]::GetFolderPath('Startup')
if (Test-Path $startupFolder) {
  Get-ChildItem $startupFolder -File | ForEach-Object {
    $items += [PSCustomObject]@{
      Name    = $_.BaseName
      Command = $_.FullName
      Source  = 'StartupFolder'
      Type    = 'Folder'
    }
  }
}

$approvedPaths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
)
$disabledSet = @{}
foreach ($ap in $approvedPaths) {
  try {
    $key = Get-Item -Path $ap -ErrorAction SilentlyContinue
    if ($key) {
      foreach ($name in $key.GetValueNames()) {
        $val = $key.GetValue($name)
        if ($val -and $val.Length -ge 1 -and $val[0] -ne 2) {
          $disabledSet[$name] = $true
        }
      }
    }
  } catch {}
}

foreach ($item in $items) {
  $enabled = -not $disabledSet.ContainsKey($item.Name)
  $item | Add-Member -NotePropertyName 'Enabled' -NotePropertyValue $enabled
}

# UWP / Store apps with startup tasks
$uwpBase = 'HKCU:\SOFTWARE\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData'
if (Test-Path $uwpBase) {
  Get-ChildItem $uwpBase -ErrorAction SilentlyContinue | ForEach-Object {
    $packageKey = $_
    Get-ChildItem $packageKey.PSPath -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
      if ($null -ne $props.State -and $props.State -is [int]) {
        $taskName = $_.PSChildName
        # Try to get a friendly name from the task ID
        $cleanTask = $taskName -replace 'StartupTask$|StartupId$|Startup$|Task$|Id$', ''
        # Also get package name as fallback
        $pkgName = $packageKey.PSChildName -replace '_[a-z0-9]+$', ''
        $friendly = $pkgName -replace '^Microsoft\.', '' -replace '^MicrosoftTeams$', 'Microsoft Teams' -replace '^SpotifyAB\.', '' -replace '^[0-9A-F]+\.', '' -replace '^AD2F1837\.', '' -replace '\.', ' '
        # Skip GUIDs / empty / dotted task names - use package name instead
        $isGuid = $cleanTask -match '^[0-9a-f]{8}-'
        $isEmpty = (-not $cleanTask) -or ($cleanTask -eq '')
        $hasDots = $cleanTask -match '\.'
        $raw = if (-not $isEmpty -and -not $isGuid -and -not $hasDots) { $cleanTask } else { $friendly }
        # Friendly name overrides for well-known apps
        $nameMap = @{
          'GamingApp'            = 'Xbox'
          'microsoftdefender'    = 'Microsoft Defender'
          'GCP'                  = 'Intel Graphics'
          'TeamsTfw'             = 'Microsoft Teams (Work)'
          'AutoStart'            = 'Power Automate'
          'StartTerminalOnLogin' = 'Windows Terminal'
          'OmenBackground'       = 'OMEN Command Center'
          'HPAudioSwitch'        = 'HP Audio Switch'
          'SpotifyLauncher'      = 'Spotify (Launcher)'
        }
        $label = if ($nameMap.ContainsKey($raw)) { $nameMap[$raw] } else { $raw }
        $uwpEnabled = ($props.State -eq 1)
        $items += [PSCustomObject]@{
          Name    = $label
          Command = $taskName
          Source  = 'UWP'
          Type    = 'StoreApp'
          Enabled = $uwpEnabled
          UwpPath = $_.PSPath
        }
      }
    }
  }
}

$items | Select-Object Name,Command,Source,Type,Enabled,UwpPath | ConvertTo-Json -Compress
