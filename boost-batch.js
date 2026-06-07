const { ipcMain } = require("electron");
const { runElevatedPs } = require("./run-elevated");

// ─────────────────────────────────────────────────────────────────────────
// Per-action PowerShell fragment generators
// Each function returns a PS snippet that performs ONE Boost PC action.
// All snippets get concatenated into a single elevated PowerShell process
// so the user only sees ONE UAC prompt for the whole Boost run.
// ─────────────────────────────────────────────────────────────────────────

function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function svcDisable(name) {
  return `try { Stop-Service -Name ${q(name)} -Force -ErrorAction SilentlyContinue; Set-Service -Name ${q(name)} -StartupType Disabled -ErrorAction Stop; ${q(name + ': disabled')} } catch { 'ERR: ' + $_.Exception.Message }`;
}

function regSetDword(hive, subkey, name, value) {
  const path = hive + ":\\" + subkey;
  return `try { if (-not (Test-Path ${q(path)})) { New-Item -Path ${q(path)} -Force | Out-Null }; Set-ItemProperty -Path ${q(path)} -Name ${q(name)} -Value ${value} -Type DWord -Force -ErrorAction Stop; ${q(name + '=' + value)} } catch { 'ERR: ' + $_.Exception.Message }`;
}

function regSetString(hive, subkey, name, value) {
  const path = hive + ":\\" + subkey;
  return `try { if (-not (Test-Path ${q(path)})) { New-Item -Path ${q(path)} -Force | Out-Null }; Set-ItemProperty -Path ${q(path)} -Name ${q(name)} -Value ${q(value)} -Type String -Force -ErrorAction Stop; ${q(name + '=' + value)} } catch { 'ERR: ' + $_.Exception.Message }`;
}

function multiReg(ops) { return ops.join("; "); }

const ACTIONS = {
  // ── Service disables ──
  svcWSearch:        () => svcDisable("WSearch"),
  svcSysMain:        () => svcDisable("SysMain"),
  svcMSiSCSI:        () => svcDisable("MSiSCSI"),
  svcAxInstSV:       () => svcDisable("AxInstSV"),
  svcAppMgmt:        () => svcDisable("AppMgmt"),
  svcCscService:     () => svcDisable("CscService"),
  svcRemoteRegistry: () => svcDisable("RemoteRegistry"),
  svcWebClient:      () => svcDisable("WebClient"),
  svcWinRM:          () => svcDisable("WinRM"),
  svcWerSvc:         () => svcDisable("WerSvc"),
  svcDiagTrack:      () => svcDisable("DiagTrack"),
  svcTrkWks:         () => svcDisable("TrkWks"),
  svcdmwappush:      () => svcDisable("dmwappushservice"),
  svcSstpSvc:        () => svcDisable("SstpSvc"),
  svcInventorySvc:   () => svcDisable("InventorySvc"),
  svcwuqisvc:        () => svcDisable("wuqisvc"),
  svcCDPSvc:         () => svcDisable("CDPSvc"),
  svcADPSvc:         () => svcDisable("ADPSvc"),

  // ── Privacy (HKCU registry) ──
  privAdvertisingId:        () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", "Enabled", 0),
  privTailored:             () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", 0),
  privSuggestedContent:     () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", "SubscribedContent-338393Enabled", 0),
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", "SubscribedContent-353694Enabled", 0),
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", "SubscribedContent-353696Enabled", 0),
  ]),
  privLockScreenTips:       () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", "RotatingLockScreenOverlayEnabled", 0),
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", "SubscribedContent-338387Enabled", 0),
  ]),
  privAppLaunchTracking:    () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "Start_TrackProgs", 0),
  privStartRecommendations: () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "Start_IrisRecommendations", 0),
  privActivityHistory:      () => multiReg([
    regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Windows\\System", "EnableActivityFeed", 0),
    regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Windows\\System", "PublishUserActivities", 0),
    regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Windows\\System", "UploadUserActivities", 0),
  ]),
  privFindMyDevice:         () => regSetDword("HKLM", "Software\\Policies\\Microsoft\\FindMyDevice", "AllowFindMyDevice", 0),
  privInkingTyping:         () => regSetDword("HKCU", "Software\\Microsoft\\InputPersonalization", "RestrictImplicitInkCollection", 1),
  privSpeechOnline:         () => regSetDword("HKCU", "Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy", "HasAccepted", 0),

  // ── Taskbar / Explorer (HKCU + HKLM policy) ──
  expOldContextMenu:   () => regSetString("HKCU", "Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32", "(Default)", ""),
  expHideWidgets:      () => regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Dsh", "AllowNewsAndInterests", 0),
  expHideChat:         () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "TaskbarMn", 0),
  expHideTaskView:     () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "ShowTaskViewButton", 0),
  expHideSearch:       () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Search", "SearchboxTaskbarMode", 0),
  expAlignLeft:        () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "TaskbarAl", 0),
  expShowFileExt:      () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "HideFileExt", 0),
  expShowHidden:       () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "Hidden", 1),
  expBingInStart:      () => regSetDword("HKCU", "Software\\Policies\\Microsoft\\Windows\\Explorer", "DisableSearchBoxSuggestions", 1),
  expHideRecent:       () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", "ShowRecent", 0),
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", "ShowFrequent", 0),
  ]),

  // ── Microsoft Edge policy keys (HKLM) ──
  edgeStartupBoost:   () => regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Edge", "StartupBoostEnabled", 0),
  edgeSleepingTabs:   () => regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Edge", "SleepingTabsEnabled", 0),
  edgeHubsSidebar:    () => regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Edge", "HubsSidebarEnabled", 0),

  // ── Gaming + responsiveness tweaks ──
  visualFx:          () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects", "VisualFXSetting", 2),
    regSetString("HKCU", "Control Panel\\Desktop\\WindowMetrics", "MinAnimate", "0"),
  ]),
  fgLockTimeout:     () => regSetDword("HKCU", "Control Panel\\Desktop", "ForegroundLockTimeout", 0),
  menuShowDelay:     () => regSetString("HKCU", "Control Panel\\Desktop", "MenuShowDelay", "0"),
  shutdownTimeouts:  () => multiReg([
    regSetString("HKCU", "Control Panel\\Desktop", "WaitToKillAppTimeout", "5000"),
    regSetString("HKCU", "Control Panel\\Desktop", "HungAppTimeout", "1000"),
  ]),
  prioSched:         () => regSetDword("HKLM", "SYSTEM\\CurrentControlSet\\Control\\PriorityControl", "Win32PrioritySeparation", 38),
  gameDvr:           () => multiReg([
    regSetDword("HKCU", "System\\GameConfigStore", "GameDVR_Enabled", 0),
    regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR", "AllowGameDVR", 0),
  ]),
  gameBar:           () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\GameBar", "UseNexusForGameBarEnabled", 0),
    regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR", "AppCaptureEnabled", 0),
  ]),
  gameMode:          () => multiReg([
    regSetDword("HKCU", "Software\\Microsoft\\GameBar", "AllowAutoGameMode", 0),
    regSetDword("HKCU", "Software\\Microsoft\\GameBar", "AutoGameModeEnabled", 0),
  ]),
  autoPlay:          () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers", "DisableAutoplay", 1),
  lowDiskWarn:       () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", "NoLowDiskSpaceChecks", 1),
  maxIcons:          () => regSetString("HKLM", "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer", "Max Cached Icons", "4096"),

  // ── File system CLI ──
  "8dot3":           () => `try { & fsutil.exe behavior set disable8dot3 1 | Out-Null; '8dot3: disabled' } catch { 'ERR: ' + $_.Exception.Message }`,
  autochk:           () => regSetDword("HKLM", "SYSTEM\\CurrentControlSet\\Control\\Session Manager", "AutoChkTimeout", 0),

  // ── Boot + power ──
  bootTweaks:        () => `try { & bcdedit.exe /timeout 3 | Out-Null; & bcdedit.exe /set "{current}" quietboot Yes | Out-Null; 'bootTweaks: applied' } catch { 'ERR: ' + $_.Exception.Message }`,
  highPerfPlan:      () => `try { & powercfg.exe /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c | Out-Null; 'highPerf: active' } catch { 'ERR: ' + $_.Exception.Message }`,

  // ── System maintenance ──
  hibernation:       () => `try { & powercfg.exe /hibernate off; 'hibernation: off' } catch { 'ERR: ' + $_.Exception.Message }`,
  bgApps:            () => regSetDword("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications", "GlobalUserDisabled", 1),

  // ── Clipboard (WinRT, no admin needed but bundled anyway) ──
  clipboard:         () => `try { [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime] | Out-Null; [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory() | Out-Null; 'clipboard: cleared' } catch { 'ERR: ' + $_.Exception.Message }`,

  // ── Temp folders ──
  clearUserTemp:     () => `try { Get-ChildItem -LiteralPath $env:TEMP -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; 'userTemp: cleared' } catch { 'ERR: ' + $_.Exception.Message }`,
  clearWinTemp:      () => `try { Get-ChildItem -LiteralPath "$env:SystemRoot\\Temp" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; 'winTemp: cleared' } catch { 'ERR: ' + $_.Exception.Message }`,

  // ── Delivery Optimization peer-to-peer ──
  doP2P:             () => regSetDword("HKLM", "SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization", "DODownloadMode", 0),

  // ── Telemetry scheduled tasks (9 tasks) ──
  telemetryTasks:    () => `try {
    $tasks = @(
      @{P='\\Microsoft\\Windows\\Application Experience\\';N='Microsoft Compatibility Appraiser'},
      @{P='\\Microsoft\\Windows\\Application Experience\\';N='ProgramDataUpdater'},
      @{P='\\Microsoft\\Windows\\Application Experience\\';N='StartupAppTask'},
      @{P='\\Microsoft\\Windows\\Autochk\\';N='Proxy'},
      @{P='\\Microsoft\\Windows\\Customer Experience Improvement Program\\';N='Consolidator'},
      @{P='\\Microsoft\\Windows\\Customer Experience Improvement Program\\';N='UsbCeip'},
      @{P='\\Microsoft\\Windows\\DiskDiagnostic\\';N='Microsoft-Windows-DiskDiagnosticDataCollector'},
      @{P='\\Microsoft\\Windows\\Feedback\\Siuf\\';N='DmClient'},
      @{P='\\Microsoft\\Windows\\Feedback\\Siuf\\';N='DmClientOnScenarioDownload'}
    ); $ok=0; $fail=0; foreach ($t in $tasks) { try { Disable-ScheduledTask -TaskPath $t.P -TaskName $t.N -ErrorAction Stop | Out-Null; $ok++ } catch { $fail++ } }; "telemetryTasks: $ok ok, $fail failed" } catch { 'ERR: ' + $_.Exception.Message }`,

  // ── OneDrive uninstaller ──
  uninstallOneDrive: () => `try { Stop-Process -Name OneDrive -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; $exe = $null; foreach ($p in @("$env:SystemRoot\\System32\\OneDriveSetup.exe","$env:SystemRoot\\SysWOW64\\OneDriveSetup.exe")) { if (Test-Path $p) { $exe = $p; break } }; if ($exe) { Start-Process -FilePath $exe -ArgumentList '/uninstall' -Wait; 'oneDrive: uninstaller ran' } else { 'oneDrive: setup not found' } } catch { 'ERR: ' + $_.Exception.Message }`,

  // ── Kill OEM bloatware (processes + linked services) ──
  // Renderer pre-resolves the list; the keys/pids come in via context.
  // We accept them as a special opts.bloatware param.
};

// ── Restore point (run BEFORE the rest if requested) ──
function restorePointFragment() {
  return `try {
    try { Enable-ComputerRestore -Drive ($env:SystemDrive + '\\') -ErrorAction SilentlyContinue } catch {};
    try { New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore' -Name 'SystemRestorePointCreationFrequency' -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null } catch {};
    Checkpoint-Computer -Description 'Disk Reaper Boost PC' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop;
    'restorePoint: created'
  } catch { 'ERR: ' + $_.Exception.Message }`;
}

// ── Bloatware kill fragment (services + PIDs supplied by renderer) ──
function bloatwareFragment(services, pids) {
  const svcArr = services.map(q).join(",");
  const pidArr = pids.join(",");
  return `try {
    $svcNames = @(${svcArr});
    foreach ($n in $svcNames) { try { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue; Set-Service -Name $n -StartupType Disabled -ErrorAction SilentlyContinue } catch {} };
    $pids = @(${pidArr || "''"});
    foreach ($p in $pids) { try { if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } } catch {} };
    "killBloat: services=${services.length}, pids=${pids.length}"
  } catch { 'ERR: ' + $_.Exception.Message }`;
}

// Build the full script. Each action is wrapped in a marker so the renderer
// can parse per-action results and advance its progress bar.
function buildScript(keys, opts) {
  const blocks = [];
  if (opts && opts.createRestorePoint) {
    blocks.push(`Write-Output '##STEP## restorePoint START'; ${restorePointFragment()}; Write-Output '##STEP## restorePoint END'`);
  }
  for (const key of keys) {
    if (key === "killAllBloatware") {
      const services = (opts.bloatwareServices || []);
      const pids = (opts.bloatwarePids || []);
      blocks.push(`Write-Output '##STEP## ${key} START'; ${bloatwareFragment(services, pids)}; Write-Output '##STEP## ${key} END'`);
      continue;
    }
    const gen = ACTIONS[key];
    if (!gen) {
      blocks.push(`Write-Output '##STEP## ${key} START'; 'SKIPPED: unknown action key'; Write-Output '##STEP## ${key} END'`);
      continue;
    }
    blocks.push(`Write-Output '##STEP## ${key} START'; ${gen()}; Write-Output '##STEP## ${key} END'`);
  }
  return "$ErrorActionPreference='Continue';\n" + blocks.join("\n");
}

// Parse the stdout from the elevated process into per-key results.
function parseResults(stdout) {
  const out = {};
  if (!stdout) return out;
  const re = /##STEP##\s+(\S+)\s+START\s*\r?\n([\s\S]*?)##STEP##\s+\1\s+END/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    const key = m[1];
    const body = (m[2] || "").trim();
    const failed = /^ERR:|^SKIPPED:/m.test(body);
    out[key] = { ok: !failed, output: body };
  }
  return out;
}

async function runBoostBatch(keys, opts) {
  opts = opts || {};
  const script = buildScript(keys, opts);
  const r = await runElevatedPs(script);
  if (!r) return { ok: false, error: "no result", perAction: {} };
  if (!r.ok) {
    return {
      ok: false,
      error: r.error || "elevation failed",
      perAction: parseResults(r.stdout || ""),
    };
  }
  return { ok: true, perAction: parseResults(r.stdout || "") };
}

ipcMain.handle("run-boost-batch", (_, payload) => runBoostBatch(payload.keys || [], payload.opts || {}));

module.exports = { runBoostBatch };
