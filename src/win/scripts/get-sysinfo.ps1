$info = @{}

# CPU
$cpu = Get-CimInstance Win32_Processor
$info['cpu'] = @{
  name = $cpu.Name
  cores = $cpu.NumberOfCores
  threads = $cpu.NumberOfLogicalProcessors
  maxClock = $cpu.MaxClockSpeed
  currentClock = $cpu.CurrentClockSpeed
  load = $cpu.LoadPercentage
}

# GPU(s)
$gpus = @()
Get-CimInstance Win32_VideoController | ForEach-Object {
  $gpus += @{
    name = $_.Name
    vram = $_.AdapterRAM
    driver = $_.DriverVersion
    resX = $_.CurrentHorizontalResolution
    resY = $_.CurrentVerticalResolution
    refresh = $_.CurrentRefreshRate
  }
}
$info['gpus'] = $gpus

# RAM
$sticks = @()
Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  $sticks += @{
    manufacturer = $_.Manufacturer
    partNumber = ($_.PartNumber -replace '\s+$', '')
    capacity = $_.Capacity
    speed = $_.Speed
    configuredSpeed = $_.ConfiguredClockSpeed
  }
}
$info['ram'] = $sticks

# OS
$os = Get-CimInstance Win32_OperatingSystem
$info['os'] = @{
  name = $os.Caption
  version = $os.Version
  build = $os.BuildNumber
  arch = $os.OSArchitecture
  totalMemKB = $os.TotalVisibleMemorySize
  freeMemKB = $os.FreePhysicalMemory
  bootTime = $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss')
}

# Disks
$disks = @()
Get-CimInstance Win32_DiskDrive | ForEach-Object {
  $disks += @{
    model = $_.Model
    size = $_.Size
    mediaType = $_.MediaType
    interface = $_.InterfaceType
  }
}
$info['disks'] = $disks

# Motherboard
$mb = Get-CimInstance Win32_BaseBoard
$info['motherboard'] = @{
  manufacturer = $mb.Manufacturer
  product = $mb.Product
  serial = $mb.SerialNumber
}

# BIOS
$bios = Get-CimInstance Win32_BIOS
$info['bios'] = @{
  manufacturer = $bios.Manufacturer
  version = $bios.SMBIOSBIOSVersion
  releaseDate = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { '' }
}

# Battery
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if ($bat) {
  $info['battery'] = @{
    name = $bat.Name
    charge = $bat.EstimatedChargeRemaining
    status = $bat.BatteryStatus
  }
} else {
  $info['battery'] = $null
}

# Network (connected only)
$nets = @()
Get-CimInstance Win32_NetworkAdapter | Where-Object { $_.NetConnectionStatus -eq 2 } | ForEach-Object {
  $nets += @{
    name = $_.Name
    mac = $_.MACAddress
    speed = $_.Speed
  }
}
$info['network'] = $nets

# Power plan
$plan = powercfg /getactivescheme 2>&1
$planName = if ($plan -match '\((.+)\)') { $Matches[1] } else { 'Unknown' }
$info['powerPlan'] = $planName

# Computer name and model
$cs = Get-CimInstance Win32_ComputerSystem
$info['computerName'] = $cs.Name
$info['model'] = $cs.Model
$info['manufacturer'] = $cs.Manufacturer
$info['systemType'] = $cs.SystemType

$info | ConvertTo-Json -Depth 3 -Compress
