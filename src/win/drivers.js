const { ipcMain } = require("electron");
const { exec } = require("child_process");

// Microsoft Update service ID (covers most third-party drivers Microsoft
// distributes — Intel, Realtek, etc.). Windows Update alone has a much
// thinner driver catalog.
const MS_UPDATE_SERVICE_ID = "7971f918-a847-4430-9279-4a52d1efe18d";

// PowerShell scripts are passed via -EncodedCommand (UTF-16 LE base64) to avoid
// the quoting nightmare you get when embedding multi-line PS in a -Command string.
function psEncode(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPs(script, { maxBufferMB = 50, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -EncodedCommand ${psEncode(script)}`,
      {
        maxBuffer: maxBufferMB * 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
      },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message, raw: "" });
        resolve({ ok: true, raw: (stdout || "").trim() });
      }
    );
  });
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function normHwIds(v) {
  return toArray(v).map(s => String(s).toLowerCase()).filter(Boolean);
}

function parseCimDate(v) {
  if (!v) return "";
  if (typeof v === "string") {
    const m = v.match(/\/Date\((-?\d+)/);
    if (m) {
      const ms = parseInt(m[1], 10);
      // Skip the bogus 1601 sentinel some PnP entries return.
      if (ms < 0) return "";
      const d = new Date(ms);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return v.slice(0, 10);
  }
  return String(v).slice(0, 10);
}

// One row per PnP device instance is what Win32_PnPSignedDriver returns; group
// by INF + version so the UI shows one row per driver package with an instance
// count (12 "Intel Processor" rows collapse into a single cpu.inf row).
function groupByDriverPackage(drivers) {
  const groups = new Map();
  for (const d of drivers) {
    const groupKey = (d.infName || `__noinf__|${d.deviceName}|${d.manufacturer}`) + "|" + d.version;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        ...d,
        instances:     1,
        instanceNames: [d.deviceName],
        hardwareIDs:   [...d.hardwareIDs],
      });
    } else {
      const g = groups.get(groupKey);
      g.instances += 1;
      if (g.instanceNames.length < 12) g.instanceNames.push(d.deviceName);
      const seen = new Set(g.hardwareIDs);
      for (const h of d.hardwareIDs) seen.add(h);
      g.hardwareIDs = [...seen];
    }
  }
  return [...groups.values()];
}

async function listDrivers() {
  const script = `
$ErrorActionPreference='SilentlyContinue';
$drivers = Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceName } |
  Select-Object DeviceName, Manufacturer, DriverVersion, DriverDate, DeviceClass, DeviceID, HardWareID, InfName, DriverProviderName;
$drivers | ConvertTo-Json -Depth 4 -Compress
`;
  const r = await runPs(script);
  if (!r.ok || !r.raw) return [];
  try {
    let parsed = JSON.parse(r.raw);
    parsed = toArray(parsed);
    const drivers = parsed.map(d => ({
      deviceName:   d.DeviceName         || "",
      manufacturer: d.Manufacturer       || "",
      version:      d.DriverVersion      || "",
      date:         parseCimDate(d.DriverDate),
      deviceClass:  d.DeviceClass        || "",
      deviceID:     d.DeviceID           || "",
      hardwareIDs:  normHwIds(d.HardWareID),
      infName:      (d.InfName           || "").toLowerCase(),
      provider:     d.DriverProviderName || "",
    }));
    const grouped = groupByDriverPackage(drivers);
    grouped.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
    return grouped;
  } catch {
    return [];
  }
}

async function getRegisteredServices() {
  const script = `
$ErrorActionPreference='SilentlyContinue';
try {
  $mgr = New-Object -ComObject Microsoft.Update.ServiceManager;
  $svcs = $mgr.Services | Select-Object Name, ServiceID;
  $svcs | ConvertTo-Json -Depth 3 -Compress
} catch { '[]' }
`;
  const r = await runPs(script);
  if (!r.ok || !r.raw) return [];
  try {
    return toArray(JSON.parse(r.raw));
  } catch {
    return [];
  }
}

async function checkDriverUpdates() {
  // Prefer Microsoft Update when registered; fall back to default (Windows Update).
  const services = await getRegisteredServices();
  const hasMsUpdate = services.some(s => (s.ServiceID || "").toLowerCase() === MS_UPDATE_SERVICE_ID);

  const script = `
$ErrorActionPreference='SilentlyContinue';
try {
  $session = New-Object -ComObject Microsoft.Update.Session;
  $searcher = $session.CreateUpdateSearcher();
  $serviceUsed = 'Windows Update (default)';
  ${hasMsUpdate ? `
  try {
    $searcher.ServerSelection = 3;
    $searcher.ServiceID = "${MS_UPDATE_SERVICE_ID}";
    $serviceUsed = 'Microsoft Update';
  } catch {}
  ` : ""}
  $result = $searcher.Search("IsInstalled=0 and Type='Driver'");
  $out = New-Object System.Collections.ArrayList;
  foreach ($u in $result.Updates) {
    $hw = New-Object System.Collections.ArrayList;
    try {
      foreach ($d in $u.DriverEntries) { [void]$hw.Add($d.DriverHardwareID) }
    } catch {}
    $verDate = '';
    try { if ($u.DriverVerDate) { $verDate = $u.DriverVerDate.ToString('yyyy-MM-dd') } } catch {}
    $sizeMB = 0;
    try { $sizeMB = [math]::Round($u.MaxDownloadSize / 1MB, 2) } catch {}
    [void]$out.Add([PSCustomObject]@{
      Title        = $u.Title;
      Manufacturer = $u.DriverManufacturer;
      Model        = $u.DriverModel;
      Class        = $u.DriverClass;
      VerDate      = $verDate;
      SizeMB       = $sizeMB;
      HardwareIDs  = $hw.ToArray();
    });
  }
  [PSCustomObject]@{
    ServiceUsed = $serviceUsed;
    Updates     = $out.ToArray();
  } | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"__error":"' + ($_.Exception.Message -replace '"','\\\"') + '"}')
}
`;
  const r = await runPs(script, { timeoutMs: 5 * 60 * 1000 });
  if (!r.ok) return { ok: false, error: r.error || "Windows Update search failed", updates: [], serviceUsed: "" };
  if (!r.raw) return { ok: true, updates: [], serviceUsed: "" };
  try {
    const parsed = JSON.parse(r.raw);
    if (parsed && parsed.__error) return { ok: false, error: parsed.__error, updates: [], serviceUsed: "" };
    const updates = toArray(parsed.Updates).map(u => ({
      title:        u.Title        || "",
      manufacturer: u.Manufacturer || "",
      model:        u.Model        || "",
      deviceClass:  u.Class        || "",
      verDate:      u.VerDate      || "",
      sizeMB:       u.SizeMB       || 0,
      hardwareIDs:  normHwIds(u.HardwareIDs),
    }));
    return { ok: true, updates, serviceUsed: parsed.ServiceUsed || "" };
  } catch (e) {
    return { ok: false, error: e.message, updates: [], serviceUsed: "" };
  }
}

async function enableMicrosoftUpdate() {
  const script = `
$ErrorActionPreference='SilentlyContinue';
try {
  $mgr = New-Object -ComObject Microsoft.Update.ServiceManager;
  $mgr.ClientApplicationID = 'DiskReaper';
  $existing = $mgr.Services | Where-Object { $_.ServiceID -eq '${MS_UPDATE_SERVICE_ID}' };
  if ($existing) {
    Write-Output '{"ok":true,"alreadyEnabled":true}'
  } else {
    # flags = asfAllowPendingRegistration(1) | asfAllowOnlineRegistration(2) | asfRegisterServiceWithAU(4) = 7
    $null = $mgr.AddService2('${MS_UPDATE_SERVICE_ID}', 7, '');
    Write-Output '{"ok":true,"alreadyEnabled":false}'
  }
} catch {
  $msg = ($_.Exception.Message -replace '"','\\\\"');
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
`;
  const r = await runPs(script);
  if (!r.ok) return { ok: false, error: r.error || "Failed to enable Microsoft Update" };
  try {
    return JSON.parse(r.raw || "{}");
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getUpdateServicesStatus() {
  const services = await getRegisteredServices();
  return {
    services,
    microsoftUpdateEnabled: services.some(s => (s.ServiceID || "").toLowerCase() === MS_UPDATE_SERVICE_ID),
  };
}

ipcMain.handle("list-drivers", () => listDrivers());
ipcMain.handle("check-driver-updates", () => checkDriverUpdates());
ipcMain.handle("enable-microsoft-update", () => enableMicrosoftUpdate());
ipcMain.handle("get-update-services-status", () => getUpdateServicesStatus());
