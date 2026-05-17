const { ipcMain, BrowserWindow } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const { scriptPath } = require("./script-path");

function emitLog(event, text, level) {
  if (!text) return;
  try {
    const win = event && event.sender
      ? BrowserWindow.fromWebContents(event.sender)
      : BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send("sysinfo-log", { text, level: level || "info" });
    }
  } catch {}
}

function runScript(event, scriptName, opts) {
  const script = scriptPath(scriptName);
  const exists = fs.existsSync(script);
  emitLog(event, `Running ${scriptName} (exists=${exists}) at ${script}`, "info");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { maxBuffer: opts.maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          emitLog(event, `${scriptName} failed: ${err.message}`, "err");
          if (stderr) emitLog(event, `stderr: ${String(stderr).trim()}`, "err");
          return resolve(null);
        }
        if (stderr && String(stderr).trim()) {
          emitLog(event, `${scriptName} stderr: ${String(stderr).trim()}`, "warn");
        }
        const raw = (stdout || "").trim();
        if (!raw) {
          emitLog(event, `${scriptName} returned empty stdout`, "err");
          return resolve(null);
        }
        try {
          const data = JSON.parse(raw);
          emitLog(event, `${scriptName} parsed OK`, "ok");
          resolve(data);
        } catch (e) {
          emitLog(event, `${scriptName} JSON parse failed: ${e.message}`, "err");
          emitLog(event, `stdout (first 300 chars): ${raw.slice(0, 300)}`, "err");
          resolve(null);
        }
      }
    );
  });
}

ipcMain.handle("get-sysinfo", (event) =>
  runScript(event, "get-sysinfo.ps1", { maxBuffer: 5 * 1024 * 1024 })
);
ipcMain.handle("get-live-stats", (event) =>
  runScript(event, "get-live-stats.ps1", { maxBuffer: 1024 * 1024 })
);
