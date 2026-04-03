const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Known bloatware signatures ──
const BLOATWARE = [
  // HP
  { process: "TouchpointAnalyticsClientService", service: "HpTouchpointAnalyticsService", label: "HP Telemetry", cat: "HP" },
  { process: "HP.HPX", service: "", label: "HP Experience", cat: "HP" },
  { process: "TouchpointGpuInfo", service: "", label: "HP Insights Graphics", cat: "HP" },
  { process: "OverlayHelper", service: "", label: "HP OMEN Overlay", cat: "HP" },
  { process: "SystemOptimizer", service: "", label: "HP OMEN Optimizer", cat: "HP" },
  { process: "hp-one-agent-service", service: "hp-one-agent-service", label: "HP One Agent", cat: "HP" },
  { process: "OmenInstallMonitor", service: "", label: "HP OMEN Install Monitor", cat: "HP" },
  { process: "HPCommRecovery", service: "HP Comm Recover", label: "HP Recovery", cat: "HP" },
  { process: "SysInfoCap", service: "HPSysInfoCap", label: "HP SysInfo Cap", cat: "HP" },
  { process: "AppHelperCap", service: "HPAppHelperCap", label: "HP AppHelper Cap", cat: "HP" },
  { process: "NetworkCap", service: "HPNetworkCap", label: "HP Network Cap", cat: "HP" },
  { process: "DiagsCap", service: "HPDiagsCap", label: "HP Diagnostics Cap", cat: "HP" },
  { process: "OmenCap", service: "HPOmenCap", label: "HP OMEN Cap", cat: "HP" },
  { process: "HPPrintScanDoctorService", service: "HPPrintScanDoctorService", label: "HP Print Scan Doctor", cat: "HP" },
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
  // Other
  { process: "PresentationFontCache", service: "FontCache3.0.0.0", label: "WPF Font Cache", cat: "Other" },
];

// ── Stop and disable services (elevated) ──
function stopAndDisableServices(serviceNames) {
  const namesArg = serviceNames.filter(Boolean).join(",");
  const outFile = path.join(os.tmpdir(), "diskreaper_svc_" + Date.now() + ".json");
  const elevatedScript = path.join(__dirname, "scripts", "stop-services-elevated.ps1");

  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", elevatedScript,
      "-ServiceNames", namesArg,
      "-OutFile", outFile,
    ], { maxBuffer: 5 * 1024 * 1024, windowsHide: true }, () => {
      try {
        const raw = fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "").trim();
        fs.unlinkSync(outFile);
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : [data];
        resolve(arr.map(r => ({ name: r.Name, ok: r.Ok, error: r.Error || "" })));
      } catch {
        try { fs.unlinkSync(outFile); } catch {}
        resolve(serviceNames.map(n => ({ name: n, ok: false, error: "Elevation cancelled or failed" })));
      }
    });
  });
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

ipcMain.handle("get-bloatware-list", () => BLOATWARE);
ipcMain.handle("stop-disable-services", (_, names) => stopAndDisableServices(names));
ipcMain.handle("kill-bloatware", (_, pids) => killBloatwareProcesses(pids));
