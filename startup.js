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
      win.webContents.send("startup-log", { text, level: level || "info" });
    }
  } catch {}
}

function runPS(event, scriptName, args) {
  const script = scriptPath(scriptName);
  const exists = fs.existsSync(script);
  emitLog(event, `Running ${scriptName} (exists=${exists}) at ${script}`, "info");
  return new Promise((resolve) => {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(args || [])];
    execFile("powershell", psArgs, { maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        emitLog(event, `${scriptName} failed: ${err.message}`, "err");
        if (stderr) emitLog(event, `stderr: ${String(stderr).trim()}`, "err");
        return resolve(null);
      }
      if (stderr && String(stderr).trim()) {
        emitLog(event, `${scriptName} stderr: ${String(stderr).trim()}`, "warn");
      }
      resolve(stdout);
    });
  });
}

async function getStartupItems(event) {
  const stdout = await runPS(event, "get-startup.ps1");
  if (!stdout) return [];
  try {
    const raw = JSON.parse(stdout.trim());
    const arr = Array.isArray(raw) ? raw : [raw];
    const items = arr.map(i => ({
      name:    i.Name || "",
      command: i.Command || "",
      source:  i.Source || "",
      type:    i.Type || "",
      enabled: i.Enabled !== false,
      uwpPath: i.UwpPath || "",
    }));
    items.sort((a, b) => a.name.localeCompare(b.name));
    emitLog(event, `get-startup.ps1 returned ${items.length} item(s)`, "ok");
    return items;
  } catch (e) {
    emitLog(event, `get-startup.ps1 JSON parse failed: ${e.message}`, "err");
    emitLog(event, `stdout (first 300 chars): ${String(stdout).slice(0, 300)}`, "err");
    return [];
  }
}

async function setStartupEnabled(event, name, source, enabled, uwpPath) {
  const args = [
    "-Name", name,
    "-Source", source,
    "-UwpPath", uwpPath || "",
    "-Enabled", enabled ? "1" : "0",
  ];
  const stdout = await runPS(event, "set-startup.ps1", args);
  if (stdout === null) return { ok: false, error: "PowerShell command failed" };
  return { ok: true };
}

ipcMain.handle("get-startup-items", (event) => getStartupItems(event));
ipcMain.handle("set-startup-enabled", (event, { name, source, enabled, uwpPath }) =>
  setStartupEnabled(event, name, source, enabled, uwpPath)
);
