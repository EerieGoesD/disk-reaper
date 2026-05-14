const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { runPsJson, readRegValue, writeRegValue } = require("./cleaner");

// ─────────────────────────────────────────────────────────────────────────
// Privacy registry tweaks (HKCU only - per-user privacy preferences).
// HKLM Group Policy keys (activityHistory, findMyDevice) were removed for
// the Microsoft Store branch because they touch enterprise policy paths.
// ─────────────────────────────────────────────────────────────────────────
const PRIVACY_TWEAKS = {
  advertisingId: {
    label: "Advertising ID",
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", name: "Enabled", enable: 1, disable: 0, type: "DWord" }],
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
// Taskbar / Explorer tweaks (HKCU only). HKLM Policy entries (hideWidgets,
// disableBingInStart) were removed for the Microsoft Store branch.
// ─────────────────────────────────────────────────────────────────────────
const EXPLORER_TWEAKS = {
  oldContextMenu: {
    label: "Restore Windows 10 Right-Click Menu",
    keys: [{ hive: "HKCU", subkey: "Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32", name: "(Default)", enable: null, disable: "", type: "String" }],
    requiresExplorerRestart: true,
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
};

// Generic toggle helpers
async function getToggleStateFromKeys(keys) {
  let allDisabled = true;
  for (const k of keys) {
    const r = await readRegValue(k.hive, k.subkey, k.name);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.hasValue || String(r.value) !== String(k.disable)) { allDisabled = false; break; }
  }
  return { ok: true, disabled: allDisabled };
}

async function setToggleStateFromKeys(keys, disable) {
  for (const k of keys) {
    const target = disable ? k.disable : k.enable;
    const r = await writeRegValue(k.hive, k.subkey, k.name, target, k.type);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// Batched read: one PowerShell spawn for the whole panel.
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
  const results = items.map((_, i) => byIdx[i] || { hasValue: false, value: null });
  return { ok: true, results };
}

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
  const r = await readManyRegValues(flat);
  if (!r.ok) return { ok: false, error: r.error };
  const out = { ok: true, privacy: {}, explorer: {} };
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
// System Restore Point (Checkpoint-Computer). Create only; deletion was
// removed for the Microsoft Store branch.
// ─────────────────────────────────────────────────────────────────────────
async function createSystemRestorePoint(description) {
  const desc = (description || "Disk Reaper Boost PC").replace(/'/g, "''").slice(0, 64);
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "try { Enable-ComputerRestore -Drive ($env:SystemDrive + '\\') -ErrorAction SilentlyContinue } catch {};" +
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

// ─────────────────────────────────────────────────────────────────────────
// Hibernation toggle. powercfg /hibernate on|off.
// ─────────────────────────────────────────────────────────────────────────
async function getHibernationState() {
  const r = await readRegValue("HKLM", "SYSTEM\\CurrentControlSet\\Control\\Power", "HibernateEnabled");
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, disabled: r.hasValue && Number(r.value) === 0 };
}
async function setHibernationState(disable) {
  const arg = disable ? "off" : "on";
  return new Promise((resolve) => {
    execFile("powercfg", ["/hibernate", arg], { windowsHide: true, timeout: 30 * 1000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).toString().trim() });
      resolve({ ok: true });
    });
  });
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
// IPC wiring (Microsoft Store edition - reduced surface)
// ─────────────────────────────────────────────────────────────────────────
ipcMain.handle("get-privacy-tweak-state",  (_, key) => getPrivacyTweakState(key));
ipcMain.handle("set-privacy-tweak",        (_, { key, disable }) => setPrivacyTweak(key, disable));
ipcMain.handle("get-all-debloat-states",   () => getAllDebloatStates());

ipcMain.handle("get-explorer-tweak-state", (_, key) => getExplorerTweakState(key));
ipcMain.handle("set-explorer-tweak",       (_, { key, disable }) => setExplorerTweak(key, disable));
ipcMain.handle("restart-explorer",         () => restartExplorer());

ipcMain.handle("create-restore-point",     (_, desc) => createSystemRestorePoint(desc));

ipcMain.handle("get-hibernation-state",    () => getHibernationState());
ipcMain.handle("set-hibernation-state",    (_, { disable }) => setHibernationState(disable));

ipcMain.handle("get-bgapps-state",         () => getBackgroundAppsState());
ipcMain.handle("set-bgapps-state",         (_, { disable }) => setBackgroundAppsState(disable));
