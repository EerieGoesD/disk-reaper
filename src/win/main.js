const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Worker } = require("worker_threads");
require("./processes");
require("./services");
require("./installed_apps");
require("./export");
require("./startup");
require("./sysinfo");
require("./cleaner");
require("./debloat");
require("./boost-batch");
require("./networking");
require("./drivers");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 740,
    minHeight: 440,
    backgroundColor: "#0a0a0c",
    icon: path.join(app.getAppPath(), "build", "icon.ico"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0c",
      symbolColor: "#777",
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Allow renderer window.open() calls (used by the Activity Log "Pop out"
  // feature). The popout windows have no Node integration and can only
  // display content the parent renderer writes into them.
  mainWindow.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 720,
      height: 520,
      autoHideMenuBar: true,
      backgroundColor: "#0a0a0c",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  }));
}

function isAdmin() {
  try { require("child_process").execSync("net session", { stdio: "ignore" }); return true; }
  catch { return false; }
}

app.whenReady().then(() => {
  if (process.platform === "win32" && !process.windowsStore && !isAdmin()) {
    const { execFile } = require("child_process");
    const appPath = app.getAppPath();
    execFile("powershell", [
      "-NoProfile", "-Command",
      `Start-Process -FilePath '${process.execPath}' -ArgumentList '"${appPath}"' -Verb RunAs -WorkingDirectory '${appPath}'`
    ], (err) => {
      if (err) {
        // elevation failed or was cancelled — just open without admin
        createWindow();
      }
    });
    // don't quit immediately — wait to see if elevation worked
    setTimeout(() => app.quit(), 3000);
    return;
  }
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ── Drive detection ──────────────────────────────────────────────
function getWindowsDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const p = `${letter}:\\`;
    try {
      fs.accessSync(p);
      drives.push(p);
    } catch {}
  }
  return drives.length ? drives : [os.homedir()];
}

// ── Scan engine ──────────────────────────────────────────────────
let scanWorker = null;
let sharedState = null; // Int32Array over SharedArrayBuffer
// Values: 0 = running, 1 = paused, 2 = stopped

ipcMain.handle("start-scan", (event, { limit, mode, root, exclude }) => {
  // A specific folder narrows the scan; otherwise sweep every drive.
  const drives = root
    ? [root]
    : (process.platform === "win32" ? getWindowsDrives() : ["/"]);

  // Fresh shared state buffer for every scan
  sharedState = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(sharedState, 0, 0); // running

  return new Promise((resolve) => {
    scanWorker = new Worker(path.join(__dirname, "scanner.js"), {
      workerData: { limit, mode, drives, sharedState, exclude },
    });

    scanWorker.on("message", (msg) => {
      if (msg.type === "progress") {
        mainWindow.webContents.send("scan-progress", {
          scanned: msg.scanned,
          label: msg.label,
          bytes: msg.bytes,
          total: msg.total,
        });
      } else if (msg.type === "partial") {
        mainWindow.webContents.send("scan-partial", msg.items);
      } else if (msg.type === "done") {
        scanWorker = null;
        resolve({ items: msg.items, scanned: msg.scanned, label: msg.label });
      }
    });

    scanWorker.on("error", () => {
      scanWorker = null;
      resolve({ items: [], scanned: 0, label: mode === "folders" ? "folders" : "files" });
    });
  });
});

ipcMain.handle("stop-scan", () => {
  if (sharedState) Atomics.store(sharedState, 0, 2); // 2 = stopped
});

ipcMain.handle("pause-scan", () => {
  if (sharedState) Atomics.store(sharedState, 0, 1); // 1 = paused
});

ipcMain.handle("resume-scan", () => {
  if (sharedState) {
    Atomics.store(sharedState, 0, 0); // 0 = running
    Atomics.notify(sharedState, 0);   // wake the worker if it's waiting
  }
});

ipcMain.handle("delete-files", async (event, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  return results;
});

ipcMain.handle("show-in-explorer", (event, filePath) => {
  shell.showItemInFolder(path.normalize(filePath));
});

ipcMain.handle("open-external", (event, url) => {
  shell.openExternal(url);
});

// ── App usage (version, CPU, memory, cache) ─────────────────────
ipcMain.handle("app-version", () => app.getVersion());

// Disk Reaper's own processes: the app itself, which also runs the scanner,
// and the process drawing its window. Chromium's GPU and network helpers are
// left out, matching what the macOS build reports.
function ownProcessIds() {
  const pids = new Set([process.pid]);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const pid = mainWindow.webContents.getOSProcessId();
    if (pid) pids.add(pid);
  }
  return pids;
}

// CPU share is a difference between two readings, so the previous CPU seconds
// of each process are kept here. The very first call has nothing to compare
// with and reports 0.0%, which is correct. Keyed by pid and start time, since
// a pid can be reused after a process dies.
let lastUsage = null;

ipcMain.handle("usage", () => {
  const pids = ownProcessIds();
  const now = Date.now();
  const cores = Math.max(1, os.cpus().length);
  const metrics = app.getAppMetrics().filter(m => pids.has(m.pid));

  let cpu = "n/a";
  if (metrics.length && metrics.every(m => typeof m.cpu.cumulativeCPUUsage === "number")) {
    const seconds = new Map(metrics.map(m => [m.pid + ":" + m.creationTime, m.cpu.cumulativeCPUUsage]));
    let share = 0;
    if (lastUsage) {
      const elapsed = (now - lastUsage.at) / 1000;
      if (elapsed > 0) {
        let spent = 0;
        for (const [key, s] of seconds) {
          const was = lastUsage.seconds.get(key);
          if (was !== undefined) spent += Math.max(0, s - was);
        }
        // Spread across every core, so 100% means the whole processor is busy.
        share = Math.min(100, Math.max(0, spent / elapsed / cores * 100));
      }
    }
    lastUsage = { at: now, seconds };
    cpu = share.toFixed(1) + "%";
  }

  // Working set as a share of the machine's memory. Electron reports it in KB.
  const totalKB = os.totalmem() / 1024;
  const workingKB = metrics.reduce((sum, m) => sum + (m.memory.workingSetSize || 0), 0);
  const ram = metrics.length && totalKB > 0 && workingKB > 0
    ? (workingKB / totalKB * 100).toFixed(1) + "%"
    : "n/a";

  return [cpu, ram];
});

// What Disk Reaper itself has saved: its settings, kept in Local Storage.
// Chromium's own caches in the same folder (GPU, code, network) are left out,
// since the app can't control them and Chromium clears them by itself.
ipcMain.handle("cache-size", () => {
  const walk = dir => {
    let sum = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) sum += walk(full);
      else if (e.isFile()) { try { sum += fs.statSync(full).size; } catch {} }
    }
    return sum;
  };
  return walk(path.join(app.getPath("userData"), "Local Storage"));
});

ipcMain.handle("pick-folder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder to scan",
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle("set-titlebar-theme", (event, theme) => {
  if (!mainWindow) return;
  try {
    if (theme === "light") {
      mainWindow.setTitleBarOverlay({ color: "#f4f4f6", symbolColor: "#333333", height: 32 });
    } else {
      mainWindow.setTitleBarOverlay({ color: "#0a0a0c", symbolColor: "#777777", height: 32 });
    }
  } catch {}
});
