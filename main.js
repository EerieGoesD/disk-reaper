const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Worker } = require("worker_threads");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 740,
    minHeight: 440,
    backgroundColor: "#0a0a0c",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0c",
      symbolColor: "#777",
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);
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

ipcMain.handle("start-scan", (event, { limit, mode }) => {
  const drives = process.platform === "win32" ? getWindowsDrives() : ["/"];

  // Fresh shared state buffer for every scan
  sharedState = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(sharedState, 0, 0); // running

  return new Promise((resolve) => {
    scanWorker = new Worker(path.join(__dirname, "scanner.js"), {
      workerData: { limit, mode, drives, sharedState },
    });

    scanWorker.on("message", (msg) => {
      if (msg.type === "progress") {
        mainWindow.webContents.send("scan-progress", {
          scanned: msg.scanned,
          label: msg.label,
        });
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
