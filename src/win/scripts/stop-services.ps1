param(
  [string]$ServiceNames
)

$names = $ServiceNames -split ','
$results = @()

foreach ($name in $names) {
  $name = $name.Trim()
  if (-not $name) { continue }
  try {
    Stop-Service -Name $name -Force -ErrorAction Stop
    Set-Service  -Name $name -StartupType Disabled -ErrorAction Stop
    $results += [PSCustomObject]@{ Name = $name; Ok = $true; Error = '' }
  } catch {
    $results += [PSCustomObject]@{ Name = $name; Ok = $false; Error = $_.Exception.Message }
  }
}

$results | ConvertTo-Json -Compress
