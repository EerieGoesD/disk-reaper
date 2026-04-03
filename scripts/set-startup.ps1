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
  } elseif ($Source -eq 'HKLM') {
    $approvedPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
  } else {
    $approvedPath = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
  }
  $bytes = New-Object byte[] 12
  $bytes[0] = if ($Enabled -eq 1) { 0x02 } else { 0x03 }
  Set-ItemProperty -Path $approvedPath -Name $Name -Value $bytes -Type Binary -ErrorAction Stop
}
