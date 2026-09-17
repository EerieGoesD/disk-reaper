const { ipcMain, BrowserWindow } = require("electron");
const { execFile, exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { scriptPath } = require("./script-path");
const { runElevatedPs, runElevatedBatch } = require("./run-elevated");

// ── Temp file cleanup paths (whitelisted; no arbitrary paths from renderer) ──
function knownPath(key) {
  if (key === "userTemp") {
    return process.env.TEMP || path.join(os.homedir(), "AppData", "Local", "Temp");
  }
  if (key === "windowsTemp") {
    return path.join(process.env.SystemRoot || "C:\\Windows", "Temp");
  }
  if (key === "windowsOld") {
    return path.join((process.env.SystemDrive || "C:") + "\\", "Windows.old");
  }
  return null;
}

// ── Known bloatware signatures ──
const BLOATWARE = [
  // HP
  { process: "TouchpointAnalyticsClientService", service: "HpTouchpointAnalyticsService", label: "HP Telemetry", cat: "HP" },
  { process: "HP.HPX", service: "", label: "HP Experience", cat: "HP" },
  { process: "TouchpointGpuInfo", service: "", label: "HP Insights Graphics", cat: "HP" },
  { process: "OverlayHelper", service: "", label: "HP OMEN Overlay", cat: "HP" },
  { process: "SystemOptimizer", service: "", label: "HP OMEN Optimizer", cat: "HP" },
  { process: "OmenCommandCenterBackground", service: "", label: "HP OMEN Command Center BG", cat: "HP" },
  { process: "hp-one-agent-service", service: "hp-one-agent-service", label: "HP One Agent", cat: "HP" },
  { process: "OmenInstallMonitor", service: "", label: "HP OMEN Install Monitor", cat: "HP" },
  { process: "HPCommRecovery", service: "HP Comm Recover", label: "HP Recovery", cat: "HP" },
  { process: "SysInfoCap", service: "HPSysInfoCap", label: "HP SysInfo Cap", cat: "HP" },
  { process: "AppHelperCap", service: "HPAppHelperCap", label: "HP AppHelper Cap", cat: "HP" },
  { process: "NetworkCap", service: "HPNetworkCap", label: "HP Network Cap", cat: "HP" },
  { process: "DiagsCap", service: "HPDiagsCap", label: "HP Diagnostics Cap", cat: "HP" },
  { process: "OmenCap", service: "HPOmenCap", label: "HP OMEN Cap", cat: "HP" },
  { process: "HPPrintScanDoctorService", service: "HPPrintScanDoctorService", label: "HP Print Scan Doctor", cat: "HP" },
  { process: "HPSystemEventUtilityBackground", service: "", label: "HP System Event Utility BG", cat: "HP" },
  { process: "HPSystemEventUtilityHost", service: "", label: "HP System Event Utility Host", cat: "HP" },
  { process: "HPAudioSwitch", service: "", label: "HP Audio Switch", cat: "HP" },
  // McAfee
  { process: "mcafee-security", service: "", label: "McAfee Security", cat: "McAfee" },
  { process: "mcafee-security-ft", service: "", label: "McAfee Security FT", cat: "McAfee" },
  // Brave
  { process: "BraveCrashHandler", service: "brave", label: "Brave Crash Handler", cat: "Brave" },
  { process: "BraveCrashHandler64", service: "bravem", label: "Brave Crash Handler 64", cat: "Brave" },
  // Edge
  { process: "EdgeGameAssist", service: "", label: "Edge Game Assist", cat: "Edge" },
  { process: "MicrosoftEdgeUpdate", service: "edgeupdate", label: "Edge Auto-Updater", cat: "Edge" },
  // IObit
  { process: "ASCService", service: "AdvancedSystemCareService19", label: "Advanced SystemCare", cat: "IObit" },
  // Microsoft Phone Link / Cross Device sync (only background-y, not the Phone Link app itself)
  { process: "CrossDeviceService", service: "CrossDeviceService", label: "MS Cross Device Service", cat: "Phone Link" },
  { process: "CrossDeviceResume", service: "", label: "MS Cross Device Resume", cat: "Phone Link" },
  // Apple Bonjour (zero-config networking; installed via iTunes / Adobe / some printers)
  { process: "mDNSResponder", service: "Bonjour Service", label: "Apple Bonjour (mDNS)", cat: "Apple" },
  // Sonitude audio enhancement (OEM-bundled audio EQ, often unused)
  { process: "SECOCL64", service: "SECOMNService", label: "Sonitude SECOCL", cat: "Audio OEM" },
  { process: "SECOMN64", service: "SECOMNService", label: "Sonitude SECOMN", cat: "Audio OEM" },
  // Other
  { process: "PresentationFontCache", service: "FontCache3.0.0.0", label: "WPF Font Cache", cat: "Other" },
];

// ── Stop and disable services (elevated) ──
async function stopAndDisableServices(serviceNames) {
  const namesArg = serviceNames.filter(Boolean).join(",");
  const outFile = path.join(os.tmpdir(), "diskreaper_svc_" + Date.now() + ".json");
  const elevatedScript = scriptPath("stop-services-elevated.ps1");

  const results = await runElevatedBatch([{
    id: "stop-services",
    cmd: "powershell",
    args: [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", elevatedScript,
      "-ServiceNames", namesArg,
      "-OutFile", outFile,
    ],
  }]);

  try {
    const raw = fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "").trim();
    fs.unlinkSync(outFile);
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : [data];
    return arr.map(r => ({ name: r.Name, ok: r.Ok, error: r.Error || "" }));
  } catch {
    try { fs.unlinkSync(outFile); } catch {}
    const reason = results[0] && results[0].error
      ? results[0].error
      : "Elevation cancelled or failed";
    return serviceNames.map(n => ({ name: n, ok: false, error: reason }));
  }
}

// ── Batch kill processes ──
function killProcess(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/PID", String(pid)], (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

async function killBloatwareProcesses(pids) {
  const results = [];
  for (const pid of pids) {
    results.push({ pid, ...(await killProcess(pid)) });
  }
  return results;
}

// ── Combined elevated bloatware kill ──
// Stops + disables the backing services AND kills the leftover PIDs in a
// SINGLE elevated PowerShell run (one UAC prompt for the whole operation).
// Killing PIDs while elevated is required: bloatware processes frequently run
// as SYSTEM or another user, which a non-elevated taskkill cannot terminate
// (it fails with "Access is denied"). Services that don't exist on this
// machine are reported as missing (skipped), not as hard failures.
async function killBloatwareElevated(serviceNames, pids) {
  const svcList = (serviceNames || []).filter(Boolean);
  const pidList = (pids || [])
    .map(p => parseInt(p, 10))
    .filter(p => Number.isFinite(p) && p > 0);

  const svcArr = svcList.map(n => "'" + String(n).replace(/'/g, "''") + "'").join(",");
  const pidArr = pidList.join(",");

  const script = `
$svc = @()
foreach ($n in @(${svcArr})) {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if (-not $s) { $svc += [PSCustomObject]@{ Name = $n; Ok = $false; Missing = $true; Error = 'not installed' }; continue }
  try {
    Stop-Service -Name $n -Force -ErrorAction Stop
    Set-Service -Name $n -StartupType Disabled -ErrorAction Stop
    $svc += [PSCustomObject]@{ Name = $n; Ok = $true; Missing = $false; Error = '' }
  } catch {
    $svc += [PSCustomObject]@{ Name = $n; Ok = $false; Missing = $false; Error = $_.Exception.Message }
  }
}
$pidres = @()
foreach ($p in @(${pidArr})) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if (-not $proc) { $pidres += [PSCustomObject]@{ Pid = $p; Ok = $true; Gone = $true; Error = '' }; continue }
  try {
    Stop-Process -Id $p -Force -ErrorAction Stop
    $pidres += [PSCustomObject]@{ Pid = $p; Ok = $true; Gone = $false; Error = '' }
  } catch {
    $pidres += [PSCustomObject]@{ Pid = $p; Ok = $false; Gone = $false; Error = $_.Exception.Message }
  }
}
'##KILLBLOAT##' + (ConvertTo-Json -InputObject (@{ services = @($svc); pids = @($pidres) }) -Compress -Depth 5)
`;

  const fail = (reason) => ({
    ok: false,
    error: reason,
    services: svcList.map(n => ({ name: n, ok: false, missing: false, error: reason })),
    pids: pidList.map(p => ({ pid: p, ok: false, gone: false, error: reason })),
  });

  const r = await runElevatedPs(script);
  if (!r || !r.ok) return fail((r && r.error) || "Elevation cancelled or failed");

  const m = (r.stdout || "").match(/##KILLBLOAT##(\{[\s\S]*\})/);
  if (!m) return fail("Elevated process produced no result");
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return fail("Could not parse elevated result: " + e.message); }

  let svc = data.services || [];
  if (!Array.isArray(svc)) svc = [svc];
  let pr = data.pids || [];
  if (!Array.isArray(pr)) pr = [pr];

  return {
    ok: true,
    services: svc.map(s => ({ name: s.Name, ok: !!s.Ok, missing: !!s.Missing, error: s.Error || "" })),
    pids: pr.map(p => ({ pid: p.Pid, ok: !!p.Ok, gone: !!p.Gone, error: p.Error || "" })),
  };
}

ipcMain.handle("get-bloatware-list", () => BLOATWARE);
ipcMain.handle("stop-disable-services", (_, names) => stopAndDisableServices(names));
ipcMain.handle("kill-bloatware", (_, pids) => killBloatwareProcesses(pids));
ipcMain.handle("kill-bloatware-elevated", (_, { services, pids }) => killBloatwareElevated(services || [], pids || []));

// ── Folder info (path + exists + size in bytes). Computed via PowerShell so
//    the main process event loop is not blocked by deep recursion. ──────────
function getFolderInfo(key) {
  const target = knownPath(key);
  if (!target) return Promise.resolve({ ok: false, error: "unknown path key" });

  if (!fs.existsSync(target)) {
    return Promise.resolve({ ok: true, path: target, exists: false, sizeBytes: 0, fileCount: 0 });
  }

  const ps = `
$ErrorActionPreference='SilentlyContinue';
$items = Get-ChildItem -LiteralPath '${target.replace(/'/g, "''")}' -Recurse -Force -File;
$sum = ($items | Measure-Object -Property Length -Sum);
$bytes = if ($sum.Sum) { $sum.Sum } else { 0 };
[PSCustomObject]@{
  SizeBytes = [int64]$bytes;
  FileCount = [int64]$sum.Count;
} | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 60 * 1000,
    }, (err, stdout) => {
      if (err) {
        return resolve({ ok: true, path: target, exists: true, sizeBytes: 0, fileCount: 0, sizeUnknown: true });
      }
      try {
        const parsed = JSON.parse((stdout || "").trim() || "{}");
        resolve({
          ok: true,
          path: target,
          exists: true,
          sizeBytes: Number(parsed.SizeBytes) || 0,
          fileCount: Number(parsed.FileCount) || 0,
        });
      } catch {
        resolve({ ok: true, path: target, exists: true, sizeBytes: 0, fileCount: 0, sizeUnknown: true });
      }
    });
  });
}

// ── Clear contents of a whitelisted temp folder (keeps the folder itself).
//    The deletion runs in a PowerShell child process so the Electron main
//    process event loop stays responsive (no "Not Responding" on large temp
//    folders). Locked files are logged, not raised as errors. ───────────────
function clearTempFolder(key) {
  if (key !== "userTemp" && key !== "windowsTemp") {
    return Promise.resolve({ ok: false, error: "Only userTemp and windowsTemp are allowed here" });
  }
  const target = knownPath(key);
  if (!target || !fs.existsSync(target)) {
    return Promise.resolve({ ok: true, path: target, notFound: true, deleted: 0, failed: 0, freedBytes: 0, errors: [] });
  }

  const ps = `
$ErrorActionPreference='SilentlyContinue';
$root = '${target.replace(/'/g, "''")}';
$beforeSum = 0;
try {
  $b = Get-ChildItem -LiteralPath $root -Recurse -Force -File | Measure-Object -Property Length -Sum;
  if ($b.Sum) { $beforeSum = [int64]$b.Sum }
} catch {}
$deleted = 0; $failed = 0;
$errs = New-Object System.Collections.ArrayList;
$top = @();
try { $top = Get-ChildItem -LiteralPath $root -Force } catch {}
foreach ($item in $top) {
  try {
    Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop;
    $deleted++
  } catch {
    $failed++;
    if ($errs.Count -lt 20) {
      [void]$errs.Add([PSCustomObject]@{
        Path = $item.FullName;
        Error = $_.Exception.Message;
      })
    }
  }
}
$afterSum = 0;
try {
  $a = Get-ChildItem -LiteralPath $root -Recurse -Force -File | Measure-Object -Property Length -Sum;
  if ($a.Sum) { $afterSum = [int64]$a.Sum }
} catch {}
$freed = $beforeSum - $afterSum;
if ($freed -lt 0) { $freed = 0 }
[PSCustomObject]@{
  Deleted    = $deleted;
  Failed     = $failed;
  FreedBytes = [int64]$freed;
  Errors     = $errs.ToArray();
} | ConvertTo-Json -Depth 4 -Compress
`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");

  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    }, (err, stdout) => {
      if (err) {
        return resolve({ ok: false, error: err.message, path: target });
      }
      try {
        const parsed = JSON.parse((stdout || "").trim() || "{}");
        const errs = Array.isArray(parsed.Errors) ? parsed.Errors : (parsed.Errors ? [parsed.Errors] : []);
        resolve({
          ok: true,
          path: target,
          deleted:    Number(parsed.Deleted) || 0,
          failed:     Number(parsed.Failed) || 0,
          freedBytes: Number(parsed.FreedBytes) || 0,
          errors:     errs.map(e => ({ path: e.Path || "", error: e.Error || "" })),
        });
      } catch (e) {
        resolve({ ok: false, path: target, error: "Failed to parse cleanup result: " + e.message });
      }
    });
  });
}

// ── Windows.old needs takeown + icacls before rd because TrustedInstaller
//    owns most of it. The three commands are chained with `&` so later ones
//    still run if takeown fails on a subset of files. ───────────────────────
function deleteWindowsOld() {
  const target = knownPath("windowsOld");
  if (!target) return Promise.resolve({ ok: false, error: "Could not resolve Windows.old path" });
  if (!fs.existsSync(target)) {
    return Promise.resolve({ ok: true, path: target, notFound: true });
  }

  const quoted = `"${target}"`;
  const cmd =
    `takeown /F ${quoted} /A /R /D Y > NUL 2>&1 & ` +
    `icacls ${quoted} /grant *S-1-5-32-544:F /T /C > NUL 2>&1 & ` +
    `rd /s /q ${quoted}`;

  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30 * 60 * 1000 }, (err, _stdout, stderr) => {
      const stillThere = fs.existsSync(target);
      if (stillThere) {
        return resolve({
          ok: false,
          path: target,
          error: (err ? err.message : "") + (stderr ? " | " + stderr.toString().trim() : ""),
        });
      }
      resolve({ ok: true, path: target });
    });
  });
}

ipcMain.handle("get-folder-info",    (_, key) => getFolderInfo(key));
ipcMain.handle("clear-temp-folder",  (_, key) => clearTempFolder(key));
ipcMain.handle("delete-windows-old", () => deleteWindowsOld());

// ── Performance tweaks: services + Delivery Optimization ─────────────────
// Whitelisted service names; renderer cannot ask us to touch arbitrary services.
const PERF_SERVICES = {
  WSearch: { display: "Windows Search Indexer" },
  SysMain: { display: "SysMain (Superfetch)" },
  MSiSCSI: { display: "Microsoft iSCSI Initiator" },
  AxInstSV: { display: "ActiveX Installer" },
  AppMgmt: { display: "Application Management" },
  CscService: { display: "Offline Files" },
  RemoteRegistry: { display: "Remote Registry" },
  WebClient: { display: "WebClient (WebDAV)" },
  WinRM: { display: "Windows Remote Management" },
  WerSvc: { display: "Windows Error Reporting" },
  DiagTrack: { display: "Connected User Experiences and Telemetry" },
  TrkWks: { display: "Distributed Link Tracking Client" },
  dmwappushservice: { display: "Device Management WAP Push Routing" },
  SstpSvc: { display: "Secure Socket Tunneling Protocol (SSTP)" },
  InventorySvc: { display: "Inventory and Compatibility Appraisal" },
  wuqisvc: { display: "Microsoft Usage and Quality Insights" },
  CDPSvc: { display: "Connected Devices Platform Service" },
  ADPSvc: { display: "Aggregated Data Platform Service" },
};

function cleanPsError(err, stderr) {
  // Node's err.message for a child_process failure starts with
  // "Command failed: powershell -NoProfile -EncodedCommand <big base64>\n<stderr>".
  // That base64 makes the error unreadable in the UI; we want just the PS error.
  const raw = (stderr || (err && err.message) || "").toString();
  let s = raw.replace(/^Command failed:\s*powershell[^\n]*\r?\n?/i, "");
  // PS5 serializes stderr as CLIXML when not a TTY. The actual error text
  // lives in <S S="Error"> elements. Some PowerShell builds emit additional
  // <S> elements without an S= attribute too, so try multiple patterns.
  if (/^#<\s*CLIXML/i.test(s)) {
    const decode = txt => txt
      .replace(/_x000D_/g, "")
      .replace(/_x000A_/g, " ")
      .replace(/_x001B_\[[0-9;]*[A-Za-z]/g, "")   // ANSI color escape sequences
      .replace(/_x[0-9A-F]{4}_/g, "")              // any other hex escape
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    let msgs = [];
    for (const re of [/<S\s+S="Error">([\s\S]*?)<\/S>/g, /<S\s+S='Error'>([\s\S]*?)<\/S>/g]) {
      let m; while ((m = re.exec(s)) !== null) msgs.push(decode(m[1]));
    }
    // Fallback: any <S> element at all (warnings, informational, plain text)
    if (!msgs.length) {
      const re = /<S(?:\s[^>]*)?>([\s\S]*?)<\/S>/g;
      let m; while ((m = re.exec(s)) !== null) {
        const t = decode(m[1]);
        if (t) msgs.push(t);
      }
    }
    // Last resort: strip all XML and the CLIXML header so user sees SOMETHING
    if (!msgs.length) {
      s = decode(s.replace(/^#<\s*CLIXML\s*/i, "").replace(/<[^>]+>/g, " "));
    } else {
      s = msgs.join(" ").trim();
    }
  }
  s = s.trim();
  if (!s) s = (err && (err.code != null ? "powershell exited with code " + err.code : err.message)) || "powershell failed";
  return s.length > 400 ? s.slice(0, 400) + "..." : s;
}

function runPsJson(script, timeoutMs = 30 * 1000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: cleanPsError(err, stderr) });
      try {
        const raw = (stdout || "").trim();
        if (!raw) return resolve({ ok: true, data: null });
        resolve({ ok: true, data: JSON.parse(raw) });
      } catch (e) {
        resolve({ ok: false, error: "parse: " + e.message });
      }
    });
  });
}

async function getServiceInfo(name) {
  if (!PERF_SERVICES[name]) return { ok: false, error: "unknown service key" };
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$s = Get-CimInstance -ClassName Win32_Service -Filter \"Name='" + name + "'\";" +
    "if ($s) { [PSCustomObject]@{ Name=$s.Name; Status=$s.State; StartType=$s.StartMode } | ConvertTo-Json -Compress }" +
    " else { '{\"Name\":\"" + name + "\",\"Status\":\"NotFound\",\"StartType\":\"\"}' }";
  const r = await runPsJson(ps, 15 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return {
    ok: true,
    name: d.Name || name,
    display: PERF_SERVICES[name].display,
    status: d.Status || "Unknown",
    startType: d.StartType || "Unknown",
  };
}

async function setServiceState(name, action) {
  if (!PERF_SERVICES[name]) return { ok: false, error: "unknown service key" };
  if (action !== "disable" && action !== "enable") return { ok: false, error: "action must be enable or disable" };

  const ps = action === "disable"
    ? "$ErrorActionPreference='Stop'; try { Stop-Service -Name '" + name + "' -Force -ErrorAction SilentlyContinue; Set-Service -Name '" + name + "' -StartupType Disabled; 'OK' } catch { 'ERR: ' + $_.Exception.Message }"
    : "$ErrorActionPreference='Stop'; try { Set-Service -Name '" + name + "' -StartupType Automatic; Start-Service -Name '" + name + "' -ErrorAction SilentlyContinue; 'OK' } catch { 'ERR: ' + $_.Exception.Message }";

  const r = await runElevatedPs(ps);
  if (!r.ok) return { ok: false, error: r.error || `elevation failed (exit ${r.exitCode})` };
  const out = (r.stdout || "").trim();
  if (out.includes("ERR:")) {
    const msg = out.split("ERR:").pop().trim();
    return { ok: false, error: msg };
  }
  return { ok: true };
}

// Delivery Optimization peer-to-peer toggle (Settings -> Windows Update ->
// Advanced -> Delivery Optimization -> Allow downloads from other PCs). We
// write the Group Policy registry value because it is documented and
// authoritative across both Windows 10 and 11. Setting it to 0 = HTTP only
// (no peer sharing). Removing the value restores Windows' default.
const DO_POLICY_KEY = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization";
const DO_VALUE      = "DODownloadMode";

async function getDeliveryOptimizationState() {
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$v = (Get-ItemProperty -Path '" + DO_POLICY_KEY + "' -Name '" + DO_VALUE + "' -ErrorAction SilentlyContinue).'" + DO_VALUE + "';" +
    "[PSCustomObject]@{ HasPolicy = ($v -ne $null); Value = $v } | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 10 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  // p2pDisabled = true when policy is set to 0 (HTTP only)
  const policyValue = (d.Value === null || d.Value === undefined) ? null : Number(d.Value);
  return {
    ok: true,
    hasPolicy:    !!d.HasPolicy,
    policyValue,
    p2pDisabled:  d.HasPolicy && policyValue === 0,
  };
}

async function setDeliveryOptimizationP2P(disable) {
  let ps;
  if (disable) {
    ps =
      "$ErrorActionPreference='Stop';" +
      "try { if (-not (Test-Path '" + DO_POLICY_KEY + "')) { New-Item -Path '" + DO_POLICY_KEY + "' -Force | Out-Null };" +
      "Set-ItemProperty -Path '" + DO_POLICY_KEY + "' -Name '" + DO_VALUE + "' -Value 0 -Type DWord;" +
      "'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  } else {
    ps =
      "$ErrorActionPreference='Stop';" +
      "try { Remove-ItemProperty -Path '" + DO_POLICY_KEY + "' -Name '" + DO_VALUE + "' -ErrorAction SilentlyContinue;" +
      "'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  }
  const r = await runElevatedPs(ps);
  if (!r.ok) return { ok: false, error: r.error || `elevation failed (exit ${r.exitCode})` };
  const out = (r.stdout || "").trim();
  if (out.includes("ERR:")) {
    const msg = out.split("ERR:").pop().trim();
    return { ok: false, error: msg };
  }
  return { ok: true };
}

// ── Streaming command runner for SFC / DISM / chkdsk / wsreset ──────────
// Output is sent line-by-line on the "perf-cmd-output" channel so the
// renderer can stream it into the Activity Log. The main process event
// loop stays free because we are awaiting a spawn, not blocking on it.
const PERF_COMMANDS = {
  sfcScan:               { exe: "sfc.exe",  args: ["/scannow"],                                            label: "sfc /scannow",                          longRunning: true  },
  dismCheckHealth:       { exe: "dism.exe", args: ["/online", "/cleanup-image", "/checkhealth"],            label: "DISM /CheckHealth",                     longRunning: false },
  dismScanHealth:        { exe: "dism.exe", args: ["/online", "/cleanup-image", "/scanhealth"],             label: "DISM /ScanHealth",                      longRunning: true  },
  dismRestoreHealth:     { exe: "dism.exe", args: ["/online", "/cleanup-image", "/restorehealth"],          label: "DISM /RestoreHealth",                   longRunning: true  },
  dismAnalyzeComponent:  { exe: "dism.exe", args: ["/online", "/cleanup-image", "/AnalyzeComponentStore"],  label: "DISM /AnalyzeComponentStore",           longRunning: false },
  dismCleanupComponent:  { exe: "dism.exe", args: ["/online", "/cleanup-image", "/StartComponentCleanup"],  label: "DISM /StartComponentCleanup",           longRunning: true  },
  // chkdsk on C: cannot lock the drive; we pipe "Y" via cmd to auto-accept
  // the "schedule for next reboot" prompt. Bound to system drive only.
  chkdskSystem:          { exe: "cmd.exe",  args: ["/c", "echo Y | chkdsk %SystemDrive% /f /r /x"],         label: "chkdsk /f /r /x (system drive)",        longRunning: false },
  // wsreset opens a Microsoft Store window when finished; that is expected.
  wsreset:               { exe: "wsreset.exe", args: [],                                                    label: "wsreset",                               longRunning: false },
};

function runPerfCommand(event, key) {
  const cmd = PERF_COMMANDS[key];
  if (!cmd) return Promise.resolve({ ok: false, error: "unknown command key: " + key });

  const win = BrowserWindow.fromWebContents(event.sender);
  const emit = (text, level) => {
    if (!text) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send("perf-cmd-output", { key, text, level: level || "info" });
    }
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd.exe, cmd.args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }

    let buf = "";
    const onChunk = (data) => {
      buf += data.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.replace(/\s+$/g, "");
        if (trimmed.trim()) emit(trimmed, "info");
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (err) => {
      emit("Failed to launch: " + err.message, "err");
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (buf && buf.trim()) emit(buf.replace(/\s+$/g, ""), "info");
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}

ipcMain.handle("get-service-info",       (_, name) => getServiceInfo(name));
ipcMain.handle("set-service-state",      (_, { name, action }) => setServiceState(name, action));
ipcMain.handle("get-delivery-opt-state", () => getDeliveryOptimizationState());
ipcMain.handle("set-delivery-opt-p2p",   (_, { disable }) => setDeliveryOptimizationP2P(disable));
ipcMain.handle("run-perf-command",       (event, key) => runPerfCommand(event, key));

// ── Quick tweaks ─────────────────────────────────────────────────────────
// Sets VisualFXSetting to 2 = "Adjust for best performance" (turns off
// animations, shadows, smooth scrolling, etc). HKCU per-user setting; takes
// effect on next sign-in for some UI bits, immediate for others.
async function applyBestPerformanceVisuals() {
  const ps =
    "$ErrorActionPreference='Stop'; try {" +
    "$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects';" +
    "if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null };" +
    "Set-ItemProperty -Path $p -Name 'VisualFXSetting' -Value 2 -Type DWord;" +
    "$wm = 'HKCU:\\Control Panel\\Desktop\\WindowMetrics';" +
    "if (-not (Test-Path $wm)) { New-Item -Path $wm -Force | Out-Null };" +
    "Set-ItemProperty -Path $wm -Name 'MinAnimate' -Value '0' -Type String;" +
    "'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 15 * 1000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = (stdout || "").trim();
      if (out.startsWith("ERR:")) return resolve({ ok: false, error: out.replace(/^ERR:\s*/, "") });
      resolve({ ok: true });
    });
  });
}

// bcdedit /timeout 3 + quietboot Yes (the real BCD value name; "nogui" is
// not a valid identifier and bcdedit rejects it). Skips "numproc" entirely
// (myth that more cores = faster boot; that setting is a debugging knob).
async function applyBootTweaks() {
  const results = await runElevatedBatch([
    { id: "bcd-timeout", cmd: "bcdedit", args: ["/timeout", "3"] },
    { id: "bcd-quiet",   cmd: "bcdedit", args: ["/set", "{current}", "quietboot", "Yes"] },
  ]);
  const fail = results.find(r => !r.ok);
  if (fail) return { ok: false, error: fail.error || `${fail.id} exit ${fail.exitCode}` };
  return { ok: true, output: results.map(r => r.stdout).join("\n").trim() };
}

// Activate the well-known High Performance plan. On some Win11 SKUs it is
// hidden by default; if setactive fails we duplicate the scheme first.
async function setHighPerformancePowerPlan() {
  const HIGH_PERF_GUID = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
  const firstTry = () => new Promise(r => exec(`powercfg /setactive ${HIGH_PERF_GUID}`, { windowsHide: true, timeout: 10000 }, (e) => r(!e)));
  const dupAndActivate = () => new Promise(r => {
    exec(`powercfg /duplicatescheme ${HIGH_PERF_GUID}`, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      // Output looks like: "Power Scheme GUID: <newguid>  (High performance)"
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(stdout || "");
      if (err || !m) return r({ ok: false, error: err ? err.message : "Could not parse duplicated scheme GUID" });
      exec(`powercfg /setactive ${m[1]}`, { windowsHide: true, timeout: 10000 }, (e2) => {
        if (e2) return r({ ok: false, error: e2.message });
        r({ ok: true, duplicated: true, guid: m[1] });
      });
    });
  });

  if (await firstTry()) return { ok: true, activated: HIGH_PERF_GUID };
  return dupAndActivate();
}

// Optimize-Volume on the system drive. Windows decides TRIM (SSD) vs defrag
// (HDD) based on the volume's media type.
async function optimizeSystemDrive() {
  const sysDrive = (process.env.SystemDrive || "C:").replace(":", "");
  const ps =
    "$ErrorActionPreference='Stop'; try {" +
    "Optimize-Volume -DriveLetter '" + sysDrive + "' -Verbose;" +
    "'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    // Defrag passes can be long on HDDs; we use a 30 minute budget.
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = (stdout || "").trim();
      if (out.includes("ERR:")) {
        const m = out.match(/ERR:\s*(.+)$/);
        return resolve({ ok: false, error: m ? m[1] : out });
      }
      resolve({ ok: true, drive: sysDrive + ":" });
    });
  });
}

// Spawned launchers (open a Windows UI, do not block our process). We use
// detached/unref so closing Disk Reaper does not kill the launched UI.
function launchDiskCleanup() {
  return new Promise((resolve) => {
    try {
      const child = spawn("cleanmgr.exe", [], { windowsHide: false, detached: true, stdio: "ignore" });
      child.unref();
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

ipcMain.handle("apply-best-perf-visuals",  () => applyBestPerformanceVisuals());
ipcMain.handle("apply-boot-tweaks",        () => applyBootTweaks());
ipcMain.handle("set-high-perf-power-plan", () => setHighPerformancePowerPlan());
ipcMain.handle("optimize-system-drive",    () => optimizeSystemDrive());
ipcMain.handle("launch-disk-cleanup",      () => launchDiskCleanup());

// ── Registry-driven toggles ─────────────────────────────────────────────
// Per-tweak: a list of keys. Each key carries its own enable / disable value
// and (optionally) type ("DWord" by default, can be "String" for REG_SZ).
// Top-level enableValue / disableValue / valueType act as defaults when a
// key doesn't specify its own. "Disabled" = all listed values match their
// disableValue. Restore writes back the enableValue (or, when null, deletes
// the value so Windows uses its built-in default).
const GAMING_REGISTRY_TWEAKS = {
  gameDvr: {
    keys: [{ hive: "HKCU", subkey: "System\\GameConfigStore", name: "GameDVR_Enabled" }],
    enableValue: 1, disableValue: 0,
  },
  gameBar: {
    keys: [
      { hive: "HKCU", subkey: "Software\\Microsoft\\GameBar", name: "UseNexusForGameBarEnabled" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR", name: "AppCaptureEnabled" },
    ],
    enableValue: 1, disableValue: 0,
  },
  gameMode: {
    keys: [
      { hive: "HKCU", subkey: "Software\\Microsoft\\GameBar", name: "AllowAutoGameMode" },
      { hive: "HKCU", subkey: "Software\\Microsoft\\GameBar", name: "AutoGameModeEnabled" },
    ],
    enableValue: 1, disableValue: 0,
  },

  // ── Responsiveness tweaks ──
  fgLockTimeout: {
    keys: [{ hive: "HKCU", subkey: "Control Panel\\Desktop", name: "ForegroundLockTimeout" }],
    enableValue: 200000, disableValue: 0, valueType: "DWord",
  },
  menuShowDelay: {
    keys: [{ hive: "HKCU", subkey: "Control Panel\\Desktop", name: "MenuShowDelay" }],
    enableValue: "400", disableValue: "0", valueType: "String",
  },
  shutdownTimeouts: {
    keys: [
      { hive: "HKCU", subkey: "Control Panel\\Desktop", name: "WaitToKillAppTimeout", enableValue: "20000", disableValue: "5000", type: "String" },
      { hive: "HKCU", subkey: "Control Panel\\Desktop", name: "HungAppTimeout",       enableValue: "5000",  disableValue: "1000", type: "String" },
    ],
  },
  priorityScheduling: {
    keys: [{ hive: "HKLM", subkey: "SYSTEM\\CurrentControlSet\\Control\\PriorityControl", name: "Win32PrioritySeparation" }],
    enableValue: 2, disableValue: 38, valueType: "DWord", // 38 = 0x26 = "Programs" / foreground-biased
  },

  // ── File system tweaks ──
  autoPlay: {
    keys: [{ hive: "HKLM", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", name: "NoDriveTypeAutoRun" }],
    enableValue: 0, disableValue: 255, valueType: "DWord", // 255 = 0xFF = disable autoplay for ALL drive types
  },
  lowDiskSpace: {
    keys: [{ hive: "HKCU", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", name: "NoLowDiskSpaceChecks" }],
    enableValue: 0, disableValue: 1, valueType: "DWord",
  },
  maxCachedIcons: {
    keys: [{ hive: "HKLM", subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer", name: "Max Cached Icons" }],
    enableValue: null, disableValue: "4096", valueType: "String",
    // enableValue: null means "Restore" = delete the value so Windows uses
    // its internal default rather than overwrite with a guess.
  },
};

function effectiveKeyCfg(tweak, k) {
  return {
    enableValue:  (k.enableValue  !== undefined ? k.enableValue  : tweak.enableValue),
    disableValue: (k.disableValue !== undefined ? k.disableValue : tweak.disableValue),
    type:         (k.type || tweak.valueType || "DWord"),
  };
}

function psPath(hive, subkey) {
  return hive + ":\\" + subkey.replace(/\\/g, "\\");
}

async function readRegValue(hive, subkey, name) {
  const path = psPath(hive, subkey);
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$v = (Get-ItemProperty -Path '" + path + "' -Name '" + name + "' -ErrorAction SilentlyContinue).'" + name + "';" +
    "[PSCustomObject]@{ HasValue = ($v -ne $null); Value = $v } | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 10 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return {
    ok: true,
    hasValue: !!d.HasValue,
    value: (d.Value === null || d.Value === undefined) ? null : d.Value,
  };
}

async function writeRegValue(hive, subkey, name, value, type) {
  const path = psPath(hive, subkey);
  // HKLM/HKCR/HKU always need admin. HKCU policy paths also need admin in
  // MSIX context because the per-app virtualization layer rejects writes to
  // Software\Policies\* (Windows reserves those for Group Policy service).
  const isHkcuPolicy = hive === "HKCU" && /\\Policies\\/i.test("\\" + subkey + "\\");
  const needsElevation = hive === "HKLM" || hive === "HKCR" || hive === "HKU" || isHkcuPolicy;

  let ps;
  if (value === null || value === undefined) {
    ps =
      "$ErrorActionPreference='Stop';" +
      "try { Remove-ItemProperty -Path '" + path + "' -Name '" + name + "' -ErrorAction SilentlyContinue; 'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  } else {
    const psType = (type === "String") ? "String" : "DWord";
    const psValueLiteral = (typeof value === "string")
      ? "'" + value.replace(/'/g, "''") + "'"
      : String(value);
    ps =
      "$ErrorActionPreference='Stop';" +
      "try {" +
      " if (-not (Test-Path '" + path + "')) { New-Item -Path '" + path + "' -Force | Out-Null };" +
      " Set-ItemProperty -Path '" + path + "' -Name '" + name + "' -Value " + psValueLiteral + " -Type " + psType + ";" +
      " 'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  }

  if (needsElevation) {
    const r = await runElevatedPs(ps);
    if (!r.ok) return { ok: false, error: r.error || `elevation failed (exit ${r.exitCode})` };
    const out = (r.stdout || "").trim();
    if (out.includes("ERR:")) {
      const msg = out.split("ERR:").pop().trim();
      return { ok: false, error: msg };
    }
    return { ok: true };
  }

  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 10 * 1000,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: cleanPsError(err, stderr) });
      const out = (stdout || "").trim();
      if (out.startsWith("ERR:")) return resolve({ ok: false, error: out.replace(/^ERR:\s*/, "") });
      resolve({ ok: true });
    });
  });
}

async function getGamingTweakState(key) {
  const cfg = GAMING_REGISTRY_TWEAKS[key];
  if (!cfg) return { ok: false, error: "unknown tweak key" };
  let allDisabled = true;
  for (const k of cfg.keys) {
    const eff = effectiveKeyCfg(cfg, k);
    const r = await readRegValue(k.hive, k.subkey, k.name);
    if (!r.ok) return { ok: false, error: r.error };
    // Compare by stringified form so DWORD vs SZ doesn't mismatch on type.
    if (!r.hasValue || String(r.value) !== String(eff.disableValue)) { allDisabled = false; break; }
  }
  return { ok: true, disabled: allDisabled };
}

async function setGamingTweak(key, disable) {
  const cfg = GAMING_REGISTRY_TWEAKS[key];
  if (!cfg) return { ok: false, error: "unknown tweak key" };
  for (const k of cfg.keys) {
    const eff = effectiveKeyCfg(cfg, k);
    const target = disable ? eff.disableValue : eff.enableValue;
    const r = await writeRegValue(k.hive, k.subkey, k.name, target, eff.type);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// CPU Core Parking via powercfg. CPMINCORES = minimum percentage of cores
// available (i.e. NOT parked). 100 = nothing parked, 0 = system default.
const CORE_PARK_SUBGROUP = "SUB_PROCESSOR";
const CORE_PARK_SETTING  = "0cc5b647-c1df-4637-891a-dec35c318583"; // CPMINCORES
async function getCoreParkingState() {
  return new Promise((resolve) => {
    exec(`powercfg /q SCHEME_CURRENT ${CORE_PARK_SUBGROUP} ${CORE_PARK_SETTING}`, {
      windowsHide: true, timeout: 10 * 1000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      // Locale-independent: powercfg always emits "0x<hex>" for the Current
      // AC value (and Current DC right after). Possible Setting Indexes use
      // bare decimal "000" notation, so they don't match this regex. We take
      // the first "0x..." which is always the AC value.
      const matches = (stdout || "").match(/0x[0-9a-fA-F]+/g);
      if (!matches || matches.length === 0) {
        return resolve({ ok: false, error: "Could not parse core parking value (powercfg returned no hex indexes)" });
      }
      const pct = parseInt(matches[0].replace(/^0x/i, ""), 16);
      if (isNaN(pct)) return resolve({ ok: false, error: "Could not parse core parking hex value" });
      resolve({ ok: true, disabled: pct >= 100, percent: pct });
    });
  });
}
async function setCoreParkingState(disable) {
  const target = disable ? 100 : 0;
  const cmd =
    `powercfg /setacvalueindex SCHEME_CURRENT ${CORE_PARK_SUBGROUP} ${CORE_PARK_SETTING} ${target} && ` +
    `powercfg /setdcvalueindex SCHEME_CURRENT ${CORE_PARK_SUBGROUP} ${CORE_PARK_SETTING} ${target} && ` +
    `powercfg /setactive SCHEME_CURRENT`;
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 15 * 1000 }, (err, _stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message + (stderr ? " | " + stderr : "") });
      resolve({ ok: true });
    });
  });
}

// Disable Windows keys via Scancode Map: 3-entry remap, both Win keys -> 0.
// Reboot required for the change to take effect (keyboard driver loads it on
// boot only).
const WINKEY_DISABLE_BYTES = "00,00,00,00,00,00,00,00,03,00,00,00,00,00,5b,e0,00,00,5c,e0,00,00,00,00";
const WINKEY_PATH = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout";
const WINKEY_VALUE = "Scancode Map";
async function getWinKeyState() {
  // Avoid using `if (...)` as an expression inside a hashtable; that's
  // PowerShell 7+ syntax and breaks on the default Windows PowerShell 5.1.
  // Use statement-level if + local vars instead.
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$v = (Get-ItemProperty -Path '" + WINKEY_PATH + "' -Name '" + WINKEY_VALUE + "' -ErrorAction SilentlyContinue).'" + WINKEY_VALUE + "';" +
    "$has = ($v -ne $null);" +
    "$len = 0;" +
    "if ($v) { $len = $v.Length };" +
    "[PSCustomObject]@{ HasValue = $has; Length = $len } | ConvertTo-Json -Compress";
  const r = await runPsJson(ps, 8 * 1000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  // Heuristic: presence of a Scancode Map at least 24 bytes long (our pattern
  // is exactly 24 bytes). We don't validate every byte.
  const disabled = !!d.HasValue && Number(d.Length) >= 24;
  return { ok: true, disabled };
}
async function setWinKeyState(disable) {
  let ps;
  if (disable) {
    ps =
      "$ErrorActionPreference='Stop';" +
      "try {" +
      " $bytes = ([byte[]] (" + WINKEY_DISABLE_BYTES.split(",").map(h => "0x" + h).join(",") + "));" +
      " Set-ItemProperty -Path '" + WINKEY_PATH + "' -Name '" + WINKEY_VALUE + "' -Value $bytes -Type Binary;" +
      " 'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  } else {
    ps =
      "$ErrorActionPreference='Stop';" +
      "try {" +
      " Remove-ItemProperty -Path '" + WINKEY_PATH + "' -Name '" + WINKEY_VALUE + "' -ErrorAction SilentlyContinue;" +
      " 'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  }
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 10 * 1000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = (stdout || "").trim();
      if (out.startsWith("ERR:")) return resolve({ ok: false, error: out.replace(/^ERR:\s*/, "") });
      resolve({ ok: true });
    });
  });
}

// Clipboard history clearing via the WinRT projection in PowerShell.
async function clearClipboardHistory() {
  const ps =
    "$ErrorActionPreference='Stop';" +
    "try {" +
    " [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime] | Out-Null;" +
    " [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory() | Out-Null;" +
    " [Windows.ApplicationModel.DataTransfer.Clipboard]::Clear();" +
    " 'OK' } catch { 'ERR: ' + $_.Exception.Message }";
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 10 * 1000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const out = (stdout || "").trim();
      if (out.startsWith("ERR:")) return resolve({ ok: false, error: out.replace(/^ERR:\s*/, "") });
      resolve({ ok: true });
    });
  });
}

// NTFS 8.3 short filename behaviour. fsutil prints either:
//   "The registry state of NtfsDisable8dot3NameCreation is 0  (Enable 8dot3...)"
//   "The registry state of NtfsDisable8dot3NameCreation is 1  (Disable 8dot3...)"
// or "2  (Per volume setting)". We treat 1 as "disabled" (the optimization).
async function get8dot3State() {
  return new Promise((resolve) => {
    exec("fsutil 8dot3name query", { windowsHide: true, timeout: 10 * 1000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      // fsutil output (Win11 EN): "The registry state is: 1 (8dot3 ... )"
      // Older Win versions: "The registry state of NtfsDisable8dot3NameCreation is 1 (...)"
      // Either way the digit follows "is" (optionally with ":") and whitespace.
      const m = /is[:\s]+(\d)/.exec(stdout || "");
      if (!m) return resolve({ ok: false, error: "Could not parse fsutil output" });
      const v = parseInt(m[1], 10);
      resolve({ ok: true, disabled: v === 1, raw: v });
    });
  });
}
async function set8dot3State(disable) {
  const target = disable ? "1" : "0";
  const results = await runElevatedBatch([
    { id: "fsutil-8dot3", cmd: "fsutil", args: ["behavior", "set", "disable8dot3", target] },
  ]);
  const r = results[0];
  if (!r.ok) return { ok: false, error: r.error || `fsutil exit ${r.exitCode}` };
  return { ok: true };
}

// Autochk countdown is stored at HKLM\SYSTEM\CurrentControlSet\Control\
// Session Manager\AutoChkTimeout (REG_DWORD, seconds; Windows default 10).
// chkntfs.exe is the official tool, but invoking it via child_process from
// Electron consistently fails with "Access is denied" even when the parent
// is elevated. Writing the registry value directly bypasses that.
const AUTOCHK_HIVE   = "HKLM";
const AUTOCHK_SUBKEY = "SYSTEM\\CurrentControlSet\\Control\\Session Manager";
const AUTOCHK_NAME   = "AutoChkTimeout";
async function getAutochkState() {
  const r = await readRegValue(AUTOCHK_HIVE, AUTOCHK_SUBKEY, AUTOCHK_NAME);
  if (!r.ok) return { ok: false, error: r.error };
  // If the value is missing Windows still uses the built-in default of 10s,
  // so we treat that as "enabled" (countdown active).
  const seconds = r.hasValue ? Number(r.value) : 10;
  if (isNaN(seconds)) return { ok: false, error: "Could not parse AutoChkTimeout value" };
  return { ok: true, disabled: seconds === 0, seconds };
}
async function setAutochkState(disable) {
  const target = disable ? 0 : 10;
  return writeRegValue(AUTOCHK_HIVE, AUTOCHK_SUBKEY, AUTOCHK_NAME, target, "DWord");
}

ipcMain.handle("get-gaming-tweak-state", (_, key)         => getGamingTweakState(key));
ipcMain.handle("set-gaming-tweak",       (_, { key, disable }) => setGamingTweak(key, disable));
ipcMain.handle("get-8dot3-state",        ()                   => get8dot3State());
ipcMain.handle("set-8dot3-state",        (_, { disable })     => set8dot3State(disable));
ipcMain.handle("get-autochk-state",      ()                   => getAutochkState());
ipcMain.handle("set-autochk-state",      (_, { disable })     => setAutochkState(disable));
ipcMain.handle("get-core-parking-state", ()               => getCoreParkingState());
ipcMain.handle("set-core-parking-state", (_, { disable }) => setCoreParkingState(disable));
ipcMain.handle("get-winkey-state",       ()               => getWinKeyState());
ipcMain.handle("set-winkey-state",       (_, { disable }) => setWinKeyState(disable));
ipcMain.handle("clear-clipboard-history", ()              => clearClipboardHistory());

module.exports = { runPsJson, readRegValue, writeRegValue };
