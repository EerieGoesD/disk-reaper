param(
  [int]$MinIdleDays = 30,
  [int]$PreselectIdleDays = 180
)
# Finds (1) folders left behind by apps that are no longer installed and
# (2) caches that are safe to empty. Prints one JSON object.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System; using System.IO; using System.Collections.Generic;
public static class DrWalk {
  public class R { public long Bytes; public long Files; public DateTime Newest; public bool HasBinary; }
  // Walks a folder without following junctions. skipPrefix: top-level entries
  // starting with it are ignored (used to protect Visual Studio's own records).
  public static R Walk(string root, bool checkBinary, string skipPrefix) {
    var r = new R(); r.Newest = DateTime.MinValue;
    var st = new Stack<string>(); st.Push(root);
    bool top = true;
    while (st.Count > 0) {
      var d = st.Pop();
      try {
        foreach (var f in Directory.EnumerateFiles(d)) {
          try {
            var fi = new FileInfo(f);
            if (top && !string.IsNullOrEmpty(skipPrefix) && fi.Name.StartsWith(skipPrefix)) continue;
            r.Bytes += fi.Length; r.Files++;
            var t = fi.LastWriteTimeUtc; if (t > r.Newest) r.Newest = t;
            if (checkBinary && !r.HasBinary) {
              var e = fi.Extension.ToLowerInvariant();
              if (e == ".exe" || e == ".dll" || e == ".sys") r.HasBinary = true;
            }
          } catch {}
        }
        foreach (var s in Directory.EnumerateDirectories(d)) {
          try {
            var a = File.GetAttributes(s);
            if ((a & FileAttributes.ReparsePoint) != 0) continue;
            if (top && !string.IsNullOrEmpty(skipPrefix) && Path.GetFileName(s).StartsWith(skipPrefix)) continue;
          } catch { continue; }
          st.Push(s);
        }
      } catch {}
      top = false;
    }
    return r;
  }
}
"@

function Norm([string]$s) { if (-not $s) { return '' }; return ($s.ToLower() -replace '[^a-z0-9]', '') }
$owned = New-Object System.Collections.Generic.HashSet[string]
function AddOwned([string]$v) { $n = Norm $v; if ($n.Length -ge 3) { [void]$owned.Add($n) } }
function AddOwnedPath([string]$p) {
  if (-not $p) { return }
  $p = $p.Trim().Trim('"') -replace ',.*$', ''
  if (-not $p) { return }
  try { if ([System.IO.Path]::HasExtension($p)) { $p = Split-Path $p -Parent } } catch {}
  $p = $p.TrimEnd('\')
  AddOwned (Split-Path $p -Leaf)
  AddOwned (Split-Path (Split-Path $p -Parent) -Leaf)
}

# ── Everything that counts as "still installed or in use" ──
$uninstallKeys = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)
$installedNames = @()
foreach ($rp in $uninstallKeys) {
  Get-ChildItem $rp | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName) { $installedNames += [string]$p.DisplayName }
    AddOwned $p.DisplayName; AddOwned $p.Publisher
    AddOwnedPath $p.InstallLocation; AddOwnedPath $p.DisplayIcon
    if ($p.UninstallString -match '^"([^"]+)"') { AddOwnedPath $matches[1] }
  }
}
Get-AppxPackage | ForEach-Object {
  AddOwned $_.Name; AddOwned $_.PackageFamilyName
  foreach ($x in ($_.Name -split '\.')) { AddOwned $x }
}
Get-Process | Where-Object Path | ForEach-Object { AddOwnedPath $_.Path }
Get-CimInstance Win32_Service | ForEach-Object {
  AddOwned $_.Name
  if ($_.PathName -match '^"([^"]+)"') { AddOwnedPath $matches[1] }
  elseif ($_.PathName) { AddOwnedPath (($_.PathName -split ' ')[0]) }
}
foreach ($rk in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') {
  $k = Get-ItemProperty $rk
  if ($k) {
    $k.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
      AddOwned $_.Name
      $v = [string]$_.Value
      if ($v -match '^"([^"]+)"') { AddOwnedPath $matches[1] } else { AddOwnedPath (($v -split ' ')[0]) }
    }
  }
}
Get-ScheduledTask | ForEach-Object { foreach ($a in $_.Actions) { if ($a.Execute) { AddOwnedPath ([Environment]::ExpandEnvironmentVariables($a.Execute)) } } }
foreach ($sf in @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))) {
  Get-ChildItem -LiteralPath (Join-Path $sf 'Programs') -Recurse | ForEach-Object { AddOwned $_.BaseName }
}
$ownedArr = @($owned)

# Folders that belong to Windows, drivers, audio plugins or developer tools.
# Never offered as leftovers even when nothing "owns" them by name.
$protected = @(
  'microsoft','windows','windowsapps','packages','temp','tmp','programs','comms','connecteddevicesplatform',
  'd3dscache','crashdumps','peerdistrepub','squirreltemp','temporaryinternetfiles','toastnotificationmanagercompat',
  'virtualstore','publishers','placeholdertilelogofolder','isolatedstorage','history','historico','traces','speech',
  'packagecache','packagemanagement','referenceassemblies','commonfiles','internetexplorer','windowsdefender',
  'windowsdefenderadvancedthreatprotection','windowsmail','windowsmediaplayer','windowsnt','windowsphotoviewer',
  'windowspowershell','windowssidebar','modifiablewindowsapps','uninstallinformation','installshieldinstallationinformation',
  'onlineservices','msbuild','dotnet','iis','iisexpress','hyperv','wsl','usoprivate','usoshared','softwaredistribution',
  'ssh','documents','templates','desktop','startmenu','applicationdata','boostinterprocess','nuget','node','nodejs',
  'npm','npmcache','pip','pnpm','pnpmcache','pnpmstate','yarn','nodegyp','electron','electronbuilder','tauri','cargo',
  'rustup','go','python','dart','pub','flutter','kotlin','gradle','jetbrains','android','docker','git','gnupg',
  'chocolatey','chocolateyhttpcache','shimgen','choco','scoop','winget','vstplugins','vst','vst2','vst3','steinberg',
  'avid','clap','lv2','aax','nvidia','nvidiacorporation','amd','ati','intel','realtek','diskreaper',
  'comeerielargefilefinder','largefilefinder','mozilla','google','cef','chromium','capacitor','caches','cache','logs',
  'log','fonts','identityservice','solutions','xdgconfig','mainktscompiledcache','toollib','dbg','copilot',
  'githubcopilot','openai','cmaketools','nasm','regid19910801commicrosoft'
)
function IsOwned([string]$name) {
  $n = Norm $name
  if ($n.Length -lt 3) { return $true }
  if ($protected -contains $n) { return $true }
  foreach ($o in $ownedArr) {
    if ($o -eq $n) { return $true }
    if ($n.Length -ge 4 -and $o.Contains($n)) { return $true }
    if ($o.Length -ge 5 -and $n.Contains($o)) { return $true }
  }
  return $false
}

$now = (Get-Date).ToUniversalTime()
$idleCutoff = $now.AddDays(-$MinIdleDays)
$leftovers = New-Object System.Collections.Generic.List[object]
$seenPaths = New-Object System.Collections.Generic.HashSet[string]

function AddLeftover($dir, [string]$reason, [bool]$admin, [bool]$force) {
  $full = $dir.FullName
  if (-not $seenPaths.Add($full.ToLower())) { return }
  $w = [DrWalk]::Walk($full, $false, $null)
  $newest = if ($w.Files -gt 0) { $w.Newest } else { $dir.LastWriteTimeUtc }
  $days = [int]($now - $newest).TotalDays
  if (-not $force -and $newest -gt $idleCutoff) { return }
  $leftovers.Add([PSCustomObject]@{
    path     = $full
    name     = $dir.Name
    bytes    = [long]$w.Bytes
    files    = [long]$w.Files
    lastUsed = $newest.ToLocalTime().ToString('yyyy-MM-dd')
    idleDays = $days
    admin    = $admin
    reason   = $reason
    selected = ($force -or $days -ge $PreselectIdleDays)
  })
}

# ── 1. Generic leftovers: folders no installed app, service, task, startup
#       entry or running program is linked to, untouched for a while. ──
$roots = @(
  @{ path = $env:LOCALAPPDATA;         admin = $false; program = $false },
  @{ path = $env:APPDATA;              admin = $false; program = $false },
  @{ path = $env:ProgramData;          admin = $true;  program = $false },
  @{ path = $env:ProgramFiles;         admin = $true;  program = $true  },
  @{ path = ${env:ProgramFiles(x86)};  admin = $true;  program = $true  }
)
foreach ($r in $roots) {
  if (-not $r.path) { continue }
  Get-ChildItem -LiteralPath $r.path -Directory -Force |
    Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
    ForEach-Object {
      $name = $_.Name
      if ($name.StartsWith('.')) { return }
      if (IsOwned $name) { return }
      # A Program Files folder that still holds programs is a working install
      # that simply isn't registered, not a leftover.
      if ($r.program) {
        $bin = [DrWalk]::Walk($_.FullName, $true, $null)
        if ($bin.HasBinary) { return }
      }
      AddLeftover $_ 'Not linked to any installed app' $r.admin $false
    }
}

# ── 2. Visual Studio leftovers (only when no Visual Studio is installed) ──
$vsInstalled = $installedNames | Where-Object { $_ -match '^(Microsoft )?Visual Studio (Community|Professional|Enterprise|Build Tools)' -or $_ -match '^Visual Studio (Community|Professional|Enterprise|Build Tools)' }
if (-not $vsInstalled) {
  $vsPaths = @(
    (Join-Path $env:ProgramData 'Microsoft\VisualStudio'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\VisualStudio'),
    (Join-Path $env:APPDATA 'Microsoft\VisualStudio'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\VSApplicationInsights'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\VSCommon'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\VisualStudio Services')
  )
  foreach ($vp in $vsPaths) {
    if ($vp -and (Test-Path -LiteralPath $vp)) {
      $d = Get-Item -LiteralPath $vp -Force
      $isAdmin = -not ($vp.StartsWith($env:LOCALAPPDATA, 'OrdinalIgnoreCase') -or $vp.StartsWith($env:APPDATA, 'OrdinalIgnoreCase'))
      AddLeftover $d 'Visual Studio is no longer installed' $isAdmin $true
    }
  }
}

# ── 3. Caches: contents are rebuilt or re-downloaded when needed ──
$L = $env:LOCALAPPDATA; $R = $env:APPDATA; $P = $env:ProgramData; $U = $env:USERPROFILE
# group: 'app' = selected by default, 'dev' = developer package caches, left unticked
# because clearing them means the next build downloads everything again.
$cacheDefs = @(
  @{ label = 'Visual Studio installer downloads'; group = 'app'; skip = '_'; paths = @("$P\Microsoft\VisualStudio\Packages") },
  @{ label = 'VS Code extension downloads';      group = 'app'; paths = @("$R\Code\CachedExtensionVSIXs") },
  @{ label = 'VS Code cache';                    group = 'app'; paths = @("$R\Code\Cache", "$R\Code\CachedData", "$R\Code\Code Cache", "$R\Code\GPUCache") },
  @{ label = 'Crash dumps';                      group = 'app'; paths = @("$L\CrashDumps") },
  @{ label = 'Error reports';                    group = 'app'; paths = @("$L\Microsoft\Windows\WER", "$P\Microsoft\Windows\WER\ReportArchive", "$P\Microsoft\Windows\WER\ReportQueue") },
  @{ label = 'Graphics shader caches';           group = 'app'; paths = @("$L\D3DSCache", "$L\NVIDIA\DXCache", "$L\NVIDIA\GLCache", "$L\AMD\DxCache", "$L\AMD\GLCache") },
  @{ label = 'Installer leftovers (Squirrel)';   group = 'app'; paths = @("$L\SquirrelTemp") },
  @{ label = 'Chrome cache';                     group = 'app'; paths = @("$L\Google\Chrome\User Data\*\Cache", "$L\Google\Chrome\User Data\*\Code Cache") },
  @{ label = 'Edge cache';                       group = 'app'; paths = @("$L\Microsoft\Edge\User Data\*\Cache", "$L\Microsoft\Edge\User Data\*\Code Cache") },
  @{ label = 'Brave cache';                      group = 'app'; paths = @("$L\BraveSoftware\Brave-Browser\User Data\*\Cache", "$L\BraveSoftware\Brave-Browser\User Data\*\Code Cache") },
  @{ label = 'Firefox cache';                    group = 'app'; paths = @("$L\Mozilla\Firefox\Profiles\*\cache2") },
  @{ label = 'Discord cache';                    group = 'app'; paths = @("$R\discord\Cache", "$R\discord\Code Cache", "$R\discord\GPUCache") },
  @{ label = 'Slack cache';                      group = 'app'; paths = @("$R\Slack\Cache", "$R\Slack\Code Cache", "$R\Slack\GPUCache") },
  @{ label = 'Spotify cache';                    group = 'app'; paths = @("$L\Spotify\Data") },
  @{ label = 'Electron downloads';               group = 'app'; paths = @("$L\electron\Cache", "$L\electron-builder\Cache") },
  @{ label = 'npm cache';                        group = 'dev'; paths = @("$L\npm-cache") },
  @{ label = 'pnpm cache';                       group = 'dev'; paths = @("$L\pnpm-cache") },
  @{ label = 'Yarn cache';                       group = 'dev'; paths = @("$L\Yarn\Cache") },
  @{ label = 'pip cache';                        group = 'dev'; paths = @("$L\pip\Cache") },
  @{ label = 'node-gyp cache';                   group = 'dev'; paths = @("$L\node-gyp\Cache") },
  @{ label = 'NuGet download cache';             group = 'dev'; paths = @("$L\NuGet\v3-cache") },
  @{ label = 'NuGet packages';                   group = 'dev'; paths = @("$U\.nuget\packages") },
  @{ label = 'Gradle cache';                     group = 'dev'; paths = @("$U\.gradle\caches") },
  @{ label = 'Cargo download cache';             group = 'dev'; paths = @("$U\.cargo\registry\cache") },
  @{ label = 'Flutter/Dart package cache';       group = 'dev'; paths = @("$L\Pub\Cache") }
)
$caches = New-Object System.Collections.Generic.List[object]
foreach ($c in $cacheDefs) {
  $found = @()
  foreach ($pat in $c.paths) {
    foreach ($rp in (Resolve-Path -Path $pat -ErrorAction SilentlyContinue)) {
      $pp = $rp.ProviderPath
      if ($pp -and (Test-Path -LiteralPath $pp -PathType Container)) { $found += $pp }
    }
  }
  if (-not $found.Count) { continue }
  $bytes = 0L; $files = 0L
  foreach ($fp in $found) { $w = [DrWalk]::Walk($fp, $false, $c.skip); $bytes += $w.Bytes; $files += $w.Files }
  if ($bytes -lt 1MB) { continue }
  $isAdmin = [bool]($found | Where-Object { $_.StartsWith($P, 'OrdinalIgnoreCase') -or $_.StartsWith($env:ProgramFiles, 'OrdinalIgnoreCase') -or $_.StartsWith($env:SystemRoot, 'OrdinalIgnoreCase') })
  $caches.Add([PSCustomObject]@{
    label    = $c.label
    paths    = @($found)
    bytes    = [long]$bytes
    files    = [long]$files
    admin    = $isAdmin
    group    = $c.group
    skip     = [string]$c.skip
    selected = ($c.group -eq 'app')
  })
}

'##LEFTOVERS##' + (ConvertTo-Json -InputObject ([PSCustomObject]@{
  leftovers = @($leftovers | Sort-Object bytes -Descending)
  caches    = @($caches | Sort-Object bytes -Descending)
}) -Compress -Depth 5)
