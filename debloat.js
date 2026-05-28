const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { runPsJson, readRegValue, writeRegValue } = require("./cleaner");
const { runElevatedBatch, runElevatedPs } = require("./run-elevated");

// ─────────────────────────────────────────────────────────────────────────
// Preinstalled UWP "bloat" list (curated; excludes apps users actually need
// like Calculator, Photos, Notepad, Snipping Tool, Store, Edge).
// Each entry has a stable display label and a PackageFamilyName prefix or
// a wildcard pattern to match against Get-AppxPackage results.
// ─────────────────────────────────────────────────────────────────────────
const UWP_BLOAT = [
  { key: "BingNews",                 label: "Bing News",                  match: "Microsoft.BingNews" },
  { key: "BingWeather",              label: "Bing Weather",               match: "Microsoft.BingWeather" },
  { key: "BingSearch",               label: "Bing Search",                match: "Microsoft.BingSearch" },
  { key: "GetHelp",                  label: "Get Help",                   match: "Microsoft.GetHelp" },
  { key: "Getstarted",               label: "Tips (Get Started)",         match: "Microsoft.Getstarted" },
  { key: "OfficeHub",                label: "Office Hub stub",            match: "Microsoft.MicrosoftOfficeHub" },
  { key: "Solitaire",                label: "Solitaire & Casual Games",   match: "Microsoft.MicrosoftSolitaireCollection" },
  { key: "PowerAutomate",            label: "Power Automate Desktop",     match: "Microsoft.PowerAutomateDesktop" },
  { key: "Skype",                    label: "Skype",                      match: "Microsoft.SkypeApp" },
  { key: "Teams",                    label: "Microsoft Teams (personal)", match: "MicrosoftTeams" },
  { key: "FeedbackHub",              label: "Feedback Hub",               match: "Microsoft.WindowsFeedbackHub" },
  { key: "Maps",                     label: "Maps",                       match: "Microsoft.WindowsMaps" },
  { key: "MixedRealityPortal",       label: "Mixed Reality Portal",       match: "Microsoft.MixedReality.Portal" },
  { key: "YourPhone",                label: "Phone Link",                 match: "Microsoft.YourPhone" },
  { key: "ZuneMusic",                label: "Media Player (Groove)",      match: "Microsoft.ZuneMusic" },
  { key: "ZuneVideo",                label: "Movies & TV",                match: "Microsoft.ZuneVideo" },
  { key: "Xbox.TCUI",                label: "Xbox TCUI",                  match: "Microsoft.Xbox.TCUI" },
  { key: "XboxApp",                  label: "Xbox App",                   match: "Microsoft.XboxApp" },
  { key: "XboxGameOverlay",          label: "Xbox Game Overlay",          match: "Microsoft.XboxGameOverlay" },
  { key: "XboxGamingOverlay",        label: "Xbox Gaming Overlay",        match: "Microsoft.XboxGamingOverlay" },
  { key: "XboxIdentityProvider",     label: "Xbox Identity Provider",     match: "Microsoft.XboxIdentityProvider" },
  { key: "XboxSpeechToTextOverlay",  label: "Xbox Speech-to-Text",        match: "Microsoft.XboxSpeechToTextOverlay" },
  { key: "Cortana",                  label: "Cortana",                    match: "Microsoft.549981C3F5F10" },
  { key: "Clipchamp",                label: "Clipchamp",                  match: "Clipchamp.Clipchamp" },
  { key: "QuickAssist",              label: "Quick Assist",               match: "MicrosoftCorporationII.QuickAssist" },
  { key: "OutlookForWindows",        label: "Outlook (new)",              match: "Microsoft.OutlookForWindows" },
  { key: "CandyCrush",               label: "Candy Crush stub",           match: "king.com.CandyCrush" },
  { key: "Disney",                   label: "Disney+ stub",               match: "Disney.37853FC22B2CE" },
  { key: "Spotify",                  label: "Spotify stub",               match: "SpotifyAB.SpotifyMusic" },
  { key: "TikTok",                   label: "TikTok stub",                match: "BytedancePte.Ltd.TikTok" },
  { key: "LinkedIn",                 label: "LinkedIn stub",              match: "7EE7776C.LinkedInforWindows" },
  { key: "Family",                   label: "Microsoft Family",           match: "MicrosoftCorporationII.MicrosoftFamily" },
];

async function getUwpBloatList() {
  // Returns one entry per curated item with installed=true/false based on
  // whether any matching Appx package exists for the current user.
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$pkgs = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework } | Select-Object -ExpandProperty Name;" +
    "$pkgs | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 15 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  let names = r.data || [];
  if (typeof names === "string") names = [names];
  const installedSet = new Set(names);
  return {
    ok: true,
    items: UWP_BLOAT.map(b => ({
      key: b.key,
      label: b.label,
      match: b.match,
      installed: Array.from(installedSet).some(n => n.startsWith(b.match)),
    })),
  };
}

async function removeUwpPackages(keys) {
  // Remove Appx for current user AND remove the provisioned image so future
  // user accounts on this PC won't get the app re-installed.
  const targets = UWP_BLOAT.filter(b => keys.includes(b.key)).map(b => b.match);
  if (!targets.length) return { ok: false, error: "no targets" };
  const patterns = targets.map(t => "'" + t + "*'").join(",");
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$patterns = @(" + patterns + ");" +
    "$results = @();" +
    "foreach ($p in $patterns) {" +
    "  $removed = $false; $err = '';" +
    "  Get-AppxPackage -Name $p -ErrorAction SilentlyContinue | ForEach-Object {" +
    "    try { Remove-AppxPackage -Package $_.PackageFullName -ErrorAction Stop; $removed = $true }" +
    "    catch { $err = $_.Exception.Message }" +
    "  };" +
    "  Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like $p } | ForEach-Object {" +
    "    try { Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName -ErrorAction Stop | Out-Null; $removed = $true }" +
    "    catch { $err = $_.Exception.Message }" +
    "  };" +
    "  $results += [PSCustomObject]@{ Pattern = $p; Removed = $removed; Error = $err };" +
    "}" +
    "$results | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 5 * 60 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  let arr = r.data || [];
  if (!Array.isArray(arr)) arr = [arr];
  return { ok: true, results: arr };
}

// ─────────────────────────────────────────────────────────────────────────
// Privacy registry tweaks
// Each entry: array of registry keys. enableValue (default Windows behavior)
// vs disableValue (privacy-friendly state).
// ─────────────────────────────────────────────────────────────────────────
const PRIVACY_TWEAKS = {
  advertisingId: {
    label: "Advertising ID",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", name: "Enabled", enable: 1, disable: 0, type: "DWord" }],
  },
  activityHistory: {
    label: "Activity History",
    keys: [
      { hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Windows\\System", name: "EnableActivityFeed",    enable: null, disable: 0, type: "DWord" },
      { hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Windows\\System", name: "PublishUserActivities", enable: null, disable: 0, type: "DWord" },
      { hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Windows\\System", name: "UploadUserActivities",  enable: null, disable: 0, type: "DWord" },
    ],
  },
  suggestedContent: {
    label: "Suggested Content in Settings",
    keys: [
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338393Enabled", enable: 1, disable: 0, type: "DWord" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-353694Enabled", enable: 1, disable: 0, type: "DWord" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-353696Enabled", enable: 1, disable: 0, type: "DWord" },
    ],
  },
  tailoredExperiences: {
    label: "Tailored Experiences",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Privacy", name: "TailoredExperiencesWithDiagnosticDataEnabled", enable: 1, disable: 0, type: "DWord" }],
  },
  lockScreenTips: {
    label: "Lock-screen Spotlight Tips",
    keys: [
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "RotatingLockScreenOverlayEnabled", enable: 1, disable: 0, type: "DWord" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338387Enabled",  enable: 1, disable: 0, type: "DWord" },
    ],
  },
  findMyDevice: {
    label: "Find My Device",
    keys: [{ hive: "HKLM", subkey: "Software\\Policies\\Microsoft\\FindMyDevice", name: "AllowFindMyDevice", enable: null, disable: 0, type: "DWord" }],
  },
  inkingTyping: {
    label: "Inking & Typing Personalization",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\InputPersonalization", name: "RestrictImplicitInkCollection", enable: 0, disable: 1, type: "DWord" }],
  },
  speechOnline: {
    label: "Online Speech Recognition",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy", name: "HasAccepted", enable: 1, disable: 0, type: "DWord" }],
  },
  appLaunchTracking: {
    label: "App Launch Tracking",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Start_TrackProgs", enable: 1, disable: 0, type: "DWord" }],
  },
  startRecommendations: {
    label: "Start Menu Recommendations",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Start_IrisRecommendations", enable: 1, disable: 0, type: "DWord" }],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Taskbar / Explorer tweaks (HKCU). Most need an Explorer restart to apply.
// ─────────────────────────────────────────────────────────────────────────
const EXPLORER_TWEAKS = {
  oldContextMenu: {
    label: "Restore Windows 10 Right-Click Menu",
    keys: [{ hive: "HKCU", subkey: "Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32", name: "(Default)", enable: null, disable: "", type: "String" }],
    requiresExplorerRestart: true,
  },
  hideWidgets: {
    // Official Microsoft Policy CSP path (Policy CSP - NewsAndInterests:
    // AllowNewsAndInterests). HKCU\Explorer\Advanced\TaskbarDa was rejected
    // by Windows 11 with "Attempted to perform an unauthorized operation"
    // because some recent builds protect it; the Dsh policy key is the
    // documented enterprise way and Windows always respects it.
    label: "Hide Widgets Button",
    keys: [{ hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Dsh", name: "AllowNewsAndInterests", enable: null, disable: 0, type: "DWord" }],
  },
  hideChat: {
    label: "Hide Chat (Teams) Button",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "TaskbarMn", enable: 1, disable: 0, type: "DWord" }],
  },
  hideTaskView: {
    label: "Hide Task View Button",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "ShowTaskViewButton", enable: 1, disable: 0, type: "DWord" }],
  },
  hideSearch: {
    label: "Hide Taskbar Search",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Search", name: "SearchboxTaskbarMode", enable: 1, disable: 0, type: "DWord" }],
  },
  alignTaskbarLeft: {
    label: "Align Taskbar Left",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "TaskbarAl", enable: 1, disable: 0, type: "DWord" }],
  },
  showFileExt: {
    label: "Show File Extensions",
    // Reversed: "enabled" Windows default hides extensions (HideFileExt=1).
    // "Disabled" (optimized) shows them (HideFileExt=0).
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "HideFileExt", enable: 1, disable: 0, type: "DWord" }],
  },
  showHiddenFiles: {
    label: "Show Hidden Files",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Hidden", enable: 2, disable: 1, type: "DWord" }],
  },
  hideRecentQuickAccess: {
    label: "Hide Recent/Frequent in Quick Access",
    keys: [
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", name: "ShowRecent",   enable: 1, disable: 0, type: "DWord" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", name: "ShowFrequent", enable: 1, disable: 0, type: "DWord" },
    ],
  },
  disableBingInStart: {
    label: "Disable Bing Search in Start Menu",
    keys: [{ hive: "HKCU", subkey: "Software\\Policies\\Microsoft\\Windows\\Explorer", name: "DisableSearchBoxSuggestions", enable: null, disable: 1, type: "DWord" }],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Edge debloat tweaks (HKLM\SOFTWARE\Policies\Microsoft\Edge).
// Edge respects policy keys even without an enterprise environment.
// ─────────────────────────────────────────────────────────────────────────
const EDGE_TWEAKS = {
  edgeStartupBoost: {
    label: "Edge Startup Boost",
    keys: [{ hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Edge", name: "StartupBoostEnabled", enable: null, disable: 0, type: "DWord" }],
  },
  edgeSleepingTabs: {
    label: "Edge Sleeping Tabs",
    keys: [{ hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Edge", name: "SleepingTabsEnabled", enable: null, disable: 0, type: "DWord" }],
  },
  edgeHubsSidebar: {
    label: "Edge Hubs Sidebar (Copilot/Bing)",
    keys: [{ hive: "HKLM", subkey: "SOFTWARE\\Policies\\Microsoft\\Edge", name: "HubsSidebarEnabled", enable: null, disable: 0, type: "DWord" }],
  },
};

// Generic toggle helpers that work over the {keys, enable, disable, type} schema above.
async function getToggleStateFromKeys(keys) {
  let allDisabled = true;
  for (const k of keys) {
    const r = await readRegValue(k.hive, k.subkey, k.name);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.hasValue || String(r.value) !== String(k.disable)) { allDisabled = false; break; }
  }
  return { ok: true, disabled: allDisabled };
}

// Batched read: build a single PowerShell script that reads every reg value
// in `items` (one Get-Item per unique path + GetValue per name) and returns a
// JSON array. One process spawn for the whole panel instead of 20+.
async function readManyRegValues(items) {
  if (!items.length) return { ok: true, results: [] };
  const tuples = items.map((it, i) => {
    const path = it.hive + ":\\" + it.subkey;
    const safePath = path.replace(/'/g, "''");
    const safeName = String(it.name).replace(/'/g, "''");
    return "[PSCustomObject]@{ Idx=" + i + "; Path='" + safePath + "'; Name='" + safeName + "' }";
  }).join(",");
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$items = @(" + tuples + ");" +
    "$out = @();" +
    "foreach ($i in $items) {" +
    "  $item = Get-Item -LiteralPath $i.Path -ErrorAction SilentlyContinue;" +
    "  $v = $null;" +
    "  if ($item -ne $null) {" +
    "    $nm = $i.Name; if ($nm -eq '(Default)') { $nm = '' };" +
    "    $v = $item.GetValue($nm, $null);" +
    "  }" +
    "  $out += [PSCustomObject]@{ Idx=$i.Idx; HasValue=($v -ne $null); Value=$v };" +
    "}" +
    "ConvertTo-Json -InputObject @($out) -Compress -Depth 4";
  const r = await runPsJson(ps, 30 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  let arr = r.data || [];
  if (!Array.isArray(arr)) arr = [arr];
  const byIdx = {};
  for (const o of arr) byIdx[o.Idx] = { hasValue: !!o.HasValue, value: o.Value === undefined ? null : o.Value };
  // Fill any missing indices with not-found.
  const results = items.map((_, i) => byIdx[i] || { hasValue: false, value: null });
  return { ok: true, results };
}

// Aggregate read across all three tweak groups in a single PS invocation.
async function getAllDebloatStates() {
  const flat = [];
  const refs = [];
  function push(group, tweakKey, tweakCfg) {
    const startIdx = flat.length;
    for (const k of tweakCfg.keys) {
      flat.push({ hive: k.hive, subkey: k.subkey, name: k.name });
    }
    refs.push({ group, tweakKey, startIdx, endIdx: flat.length, keys: tweakCfg.keys });
  }
  for (const k of Object.keys(PRIVACY_TWEAKS))  push("privacy",  k, PRIVACY_TWEAKS[k]);
  for (const k of Object.keys(EXPLORER_TWEAKS)) push("explorer", k, EXPLORER_TWEAKS[k]);
  for (const k of Object.keys(EDGE_TWEAKS))     push("edge",     k, EDGE_TWEAKS[k]);
  const r = await readManyRegValues(flat);
  if (!r.ok) return { ok: false, error: r.error };
  const out = { ok: true, privacy: {}, explorer: {}, edge: {} };
  for (const ref of refs) {
    let allDisabled = true;
    for (let i = ref.startIdx; i < ref.endIdx; i++) {
      const reg = r.results[i];
      const expected = ref.keys[i - ref.startIdx].disable;
      if (!reg.hasValue || String(reg.value) !== String(expected)) { allDisabled = false; break; }
    }
    out[ref.group][ref.tweakKey] = { disabled: allDisabled };
  }
  return out;
}

async function setToggleStateFromKeys(keys, disable) {
  for (const k of keys) {
    const target = disable ? k.disable : k.enable;
    const r = await writeRegValue(k.hive, k.subkey, k.name, target, k.type);
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function getPrivacyTweakState(key) {
  const cfg = PRIVACY_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  return getToggleStateFromKeys(cfg.keys);
}
async function setPrivacyTweak(key, disable) {
  const cfg = PRIVACY_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  return setToggleStateFromKeys(cfg.keys, disable);
}

async function getExplorerTweakState(key) {
  const cfg = EXPLORER_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  return getToggleStateFromKeys(cfg.keys);
}
async function setExplorerTweak(key, disable) {
  const cfg = EXPLORER_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  const r = await setToggleStateFromKeys(cfg.keys, disable);
  return r;
}

async function getEdgeTweakState(key) {
  const cfg = EDGE_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  return getToggleStateFromKeys(cfg.keys);
}
async function setEdgeTweak(key, disable) {
  const cfg = EDGE_TWEAKS[key]; if (!cfg) return { ok: false, error: "unknown" };
  return setToggleStateFromKeys(cfg.keys, disable);
}

async function restartExplorer() {
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue;" +
    "Start-Sleep -Milliseconds 600;" +
    "if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }; 'OK'";
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], { windowsHide: true, timeout: 15 * 1000 }, (err) => {
      resolve({ ok: !err });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Scheduled tasks to disable. Each entry is { taskPath, taskName, label }.
// Use Disable-ScheduledTask. These are the well-known telemetry / CEIP tasks.
// ─────────────────────────────────────────────────────────────────────────
const TELEMETRY_TASKS = [
  { path: "\\Microsoft\\Windows\\Application Experience\\",          name: "Microsoft Compatibility Appraiser",            label: "Compatibility Appraiser" },
  { path: "\\Microsoft\\Windows\\Application Experience\\",          name: "ProgramDataUpdater",                           label: "Program Data Updater" },
  { path: "\\Microsoft\\Windows\\Application Experience\\",          name: "StartupAppTask",                               label: "Startup App Telemetry" },
  { path: "\\Microsoft\\Windows\\Autochk\\",                         name: "Proxy",                                        label: "Autochk Proxy (CEIP)" },
  { path: "\\Microsoft\\Windows\\Customer Experience Improvement Program\\", name: "Consolidator",                         label: "CEIP Consolidator" },
  { path: "\\Microsoft\\Windows\\Customer Experience Improvement Program\\", name: "UsbCeip",                              label: "USB CEIP" },
  { path: "\\Microsoft\\Windows\\DiskDiagnostic\\",                  name: "Microsoft-Windows-DiskDiagnosticDataCollector", label: "Disk Diagnostic Data Collector" },
  { path: "\\Microsoft\\Windows\\Feedback\\Siuf\\",                  name: "DmClient",                                     label: "Feedback DmClient" },
  { path: "\\Microsoft\\Windows\\Feedback\\Siuf\\",                  name: "DmClientOnScenarioDownload",                   label: "Feedback DmClient (Scenario)" },
];

async function getTelemetryTasksState() {
  // Returns one entry per task with state = "Disabled" | "Ready" | "NotFound"
  const tuples = TELEMETRY_TASKS.map(t => "@{Path='" + t.path + "';Name='" + t.name + "'}").join(",");
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$items = @(" + tuples + ");" +
    "$results = @();" +
    "foreach ($i in $items) {" +
    "  $t = Get-ScheduledTask -TaskPath $i.Path -TaskName $i.Name -ErrorAction SilentlyContinue;" +
    "  $state = if ($t) { [string]$t.State } else { 'NotFound' };" +
    "  $results += [PSCustomObject]@{ Name = $i.Name; State = $state };" +
    "}" +
    "$results | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 30 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  let arr = r.data || [];
  if (!Array.isArray(arr)) arr = [arr];
  return { ok: true, tasks: arr };
}

async function setTelemetryTasksState(disable) {
  const tuples = TELEMETRY_TASKS.map(t => "@{Path='" + t.path + "';Name='" + t.name + "'}").join(",");
  const verb = disable ? "Disable-ScheduledTask" : "Enable-ScheduledTask";
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$items = @(" + tuples + ");" +
    "$ok = 0; $fail = 0;" +
    "foreach ($i in $items) {" +
    "  try { " + verb + " -TaskPath $i.Path -TaskName $i.Name -ErrorAction Stop | Out-Null; $ok++ }" +
    "  catch { $fail++ }" +
    "}" +
    "[PSCustomObject]@{ Ok = $ok; Fail = $fail } | ConvertTo-Json -Compress";
  const r = await runElevatedPs(ps);
  if (!r.ok) return { ok: false, error: r.error || `elevation failed (exit ${r.exitCode})` };
  try {
    const m = (r.stdout || "").match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, succeeded: 0, failed: 0 };
    const d = JSON.parse(m[0]);
    return { ok: true, succeeded: d.Ok || 0, failed: d.Fail || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OneDrive uninstall. Kill, then run the OneDriveSetup uninstaller.
// 64-bit OneDriveSetup.exe lives in System32; 32-bit in SysWOW64.
// ─────────────────────────────────────────────────────────────────────────
async function uninstallOneDrive() {
  const sysroot = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(sysroot, "System32", "OneDriveSetup.exe"),
    path.join(sysroot, "SysWOW64", "OneDriveSetup.exe"),
  ];
  const exe = candidates.find(p => fs.existsSync(p));
  if (!exe) return { ok: false, error: "OneDriveSetup.exe not found in System32 or SysWOW64." };

  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "Stop-Process -Name OneDrive -Force -ErrorAction SilentlyContinue;" +
    "Start-Sleep -Milliseconds 400;" +
    "Start-Process -FilePath '" + exe.replace(/'/g, "''") + "' -ArgumentList '/uninstall' -Wait;" +
    "'OK'";
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 5 * 60 * 1000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = (stdout || "").trim();
      resolve({ ok: out === "OK" || out.endsWith("OK"), output: out });
    });
  });
}

async function isOneDriveInstalled() {
  // OneDriveSetup.exe in System32 ships with Windows itself and is NEVER
  // removed; checking for it is wrong. Only OneDrive.exe (the actual user
  // binary) is meaningful. Standard locations:
  //   - Per-user (default for consumer): %LOCALAPPDATA%\Microsoft\OneDrive\OneDrive.exe
  //   - Machine-wide 64-bit:             %PROGRAMFILES%\Microsoft OneDrive\OneDrive.exe
  //   - Machine-wide 32-bit on x64:      %PROGRAMFILES(X86)%\Microsoft OneDrive\OneDrive.exe
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    path.join(localAppData,    "Microsoft", "OneDrive", "OneDrive.exe"),
    path.join(programFiles,    "Microsoft OneDrive", "OneDrive.exe"),
    path.join(programFilesX86, "Microsoft OneDrive", "OneDrive.exe"),
  ];
  return { ok: true, installed: candidates.some(p => fs.existsSync(p)) };
}

// ─────────────────────────────────────────────────────────────────────────
// System Restore Point (Checkpoint-Computer). Requires System Protection
// to be enabled on the system drive; we try to enable it first.
// ─────────────────────────────────────────────────────────────────────────
async function createSystemRestorePoint(description) {
  const desc = (description || "Disk Reaper Boost PC").replace(/'/g, "''").slice(0, 64);
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "try { Enable-ComputerRestore -Drive ($env:SystemDrive + '\\') -ErrorAction SilentlyContinue } catch {};" +
    // Windows throttles restore-point creation to one per 24h by default.
    // Lower the throttle so the user actually gets a checkpoint when they ask.
    "try { New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore' -Name 'SystemRestorePointCreationFrequency' -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null } catch {};" +
    "try {" +
    "  Checkpoint-Computer -Description '" + desc + "' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop;" +
    "  '{\"ok\":true}'" +
    "} catch {" +
    "  $msg = $_.Exception.Message -replace '\"','`\"';" +
    "  '{\"ok\":false,\"error\":\"' + $msg + '\"}'" +
    "}";
  const r = await runPsJson(ps, 3 * 60 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  if (d.ok === false) return { ok: false, error: d.error || "Restore point creation failed" };
  return { ok: true };
}

// Delete all System Restore Points (and shadow copies) on the system drive.
// Uses vssadmin which is the documented Microsoft tool for this.
async function deleteAllRestorePoints() {
  const drive = process.env.SystemDrive || "C:";
  return new Promise((resolve) => {
    execFile("vssadmin", ["delete", "shadows", "/for=" + drive, "/all", "/quiet"], {
      windowsHide: true, timeout: 2 * 60 * 1000,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = ((stderr || "").toString().trim()) || ((stdout || "").toString().trim()) || err.message || "vssadmin failed";
        // vssadmin returns non-zero with "No items found that satisfy the query"
        // when there's nothing to delete; treat that as success.
        if (/no items found/i.test(msg)) return resolve({ ok: true, output: "Nothing to delete (no shadow copies present)." });
        return resolve({ ok: false, error: msg });
      }
      resolve({ ok: true, output: (stdout || "").toString().trim() });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Hibernation toggle. powercfg /hibernate on|off.
// ─────────────────────────────────────────────────────────────────────────
async function getHibernationState() {
  // HKLM\SYSTEM\CurrentControlSet\Control\Power\HibernateEnabled (DWORD 0/1).
  const r = await readRegValue("HKLM", "SYSTEM\\CurrentControlSet\\Control\\Power", "HibernateEnabled");
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, disabled: r.hasValue && Number(r.value) === 0 };
}

async function setHibernationState(disable) {
  const arg = disable ? "off" : "on";
  const results = await runElevatedBatch([
    { id: "powercfg-hibernate", cmd: "powercfg", args: ["/hibernate", arg] },
  ]);
  const r = results[0];
  if (!r.ok) return { ok: false, error: r.error || `powercfg exit ${r.exitCode}` };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Background Apps mass-disable.
// HKCU\Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications\GlobalUserDisabled = 1
// ─────────────────────────────────────────────────────────────────────────
const BG_APPS_KEY    = "Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications";
const BG_APPS_NAME   = "GlobalUserDisabled";

async function getBackgroundAppsState() {
  const r = await readRegValue("HKCU", BG_APPS_KEY, BG_APPS_NAME);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, disabled: r.hasValue && Number(r.value) === 1 };
}
async function setBackgroundAppsState(disable) {
  const target = disable ? 1 : 0;
  return writeRegValue("HKCU", BG_APPS_KEY, BG_APPS_NAME, target, "DWord");
}

// ─────────────────────────────────────────────────────────────────────────
// IPC wiring
// ─────────────────────────────────────────────────────────────────────────
ipcMain.handle("get-uwp-bloat-list",       () => getUwpBloatList());
ipcMain.handle("remove-uwp-packages",      (_, keys) => removeUwpPackages(keys || []));

ipcMain.handle("get-privacy-tweak-state",  (_, key) => getPrivacyTweakState(key));
ipcMain.handle("set-privacy-tweak",        (_, { key, disable }) => setPrivacyTweak(key, disable));
ipcMain.handle("get-all-debloat-states",   () => getAllDebloatStates());

ipcMain.handle("get-explorer-tweak-state", (_, key) => getExplorerTweakState(key));
ipcMain.handle("set-explorer-tweak",       (_, { key, disable }) => setExplorerTweak(key, disable));
ipcMain.handle("restart-explorer",         () => restartExplorer());

ipcMain.handle("get-edge-tweak-state",     (_, key) => getEdgeTweakState(key));
ipcMain.handle("set-edge-tweak",           (_, { key, disable }) => setEdgeTweak(key, disable));

ipcMain.handle("get-telemetry-tasks-state",() => getTelemetryTasksState());
ipcMain.handle("set-telemetry-tasks-state",(_, disable) => setTelemetryTasksState(!!disable));

ipcMain.handle("get-onedrive-installed",   () => isOneDriveInstalled());
ipcMain.handle("uninstall-onedrive",       () => uninstallOneDrive());

ipcMain.handle("create-restore-point",     (_, desc) => createSystemRestorePoint(desc));
ipcMain.handle("delete-all-restore-points", () => deleteAllRestorePoints());

ipcMain.handle("get-hibernation-state",    () => getHibernationState());
ipcMain.handle("set-hibernation-state",    (_, { disable }) => setHibernationState(disable));

ipcMain.handle("get-bgapps-state",         () => getBackgroundAppsState());
ipcMain.handle("set-bgapps-state",         (_, { disable }) => setBackgroundAppsState(disable));
