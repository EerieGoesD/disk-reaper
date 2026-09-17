param(
  [string]$Name,
  [string]$Source,
  [string]$UwpPath,
  [int]$Enabled
)

if ($Source -eq 'UWP' -and $UwpPath) {
  $stateVal = if ($Enabled -eq 1) { 1 } else { 0 }
  $cleanPath = $UwpPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', ''
  Set-ItemProperty -Path "Registry::$cleanPath" -Name 'State' -Value $stateVal -Type DWord -ErrorAction Stop
} else {
  if ($Source -eq 'StartupFolder') {
    $approvedPath = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
  } elseif ($Source -eq 'CommonStartupFolder') {
    $approvedPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
  } elseif ($Source -eq 'HKLM32') {
    $approvedPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'
  } elseif ($Source -eq 'HKLM') {
    $approvedPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
  } else {
    $approvedPath = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
  }
  if (-not (Test-Path $approvedPath)) { New-Item -Path $approvedPath -Force | Out-Null }

  # Startup-folder entries are keyed by the shortcut file name including its
  # extension (AnyDesk.lnk), while the list shows the name without it.
  $valueName = $Name
  if ($Source -eq 'StartupFolder' -or $Source -eq 'CommonStartupFolder') {
    $existing = (Get-Item -Path $approvedPath).GetValueNames() |
      Where-Object { [System.IO.Path]::GetFileNameWithoutExtension($_) -eq $Name } |
      Select-Object -First 1
    if ($existing) { $valueName = $existing } elseif ($Name -notmatch '\.') { $valueName = "$Name.lnk" }
  }

  $bytes = New-Object byte[] 12
  $bytes[0] = if ($Enabled -eq 1) { 0x02 } else { 0x03 }
  Set-ItemProperty -Path $approvedPath -Name $valueName -Value $bytes -Type Binary -ErrorAction Stop
}
