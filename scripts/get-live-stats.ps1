$cpu = Get-CimInstance Win32_Processor
$os = Get-CimInstance Win32_OperatingSystem
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue

$result = @{
  cpuLoad = $cpu.LoadPercentage
  cpuClock = $cpu.CurrentClockSpeed
  totalMemKB = $os.TotalVisibleMemorySize
  freeMemKB = $os.FreePhysicalMemory
}

if ($bat) {
  $result['batteryCharge'] = $bat.EstimatedChargeRemaining
  $result['batteryStatus'] = $bat.BatteryStatus
}

$result | ConvertTo-Json -Compress
