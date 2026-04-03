const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");

function getSysInfo() {
  const script = path.join(__dirname, "scripts", "get-sysinfo.ps1");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch { resolve(null); }
      }
    );
  });
}

function getLiveStats() {
  const script = path.join(__dirname, "scripts", "get-live-stats.ps1");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch { resolve(null); }
      }
    );
  });
}

ipcMain.handle("get-sysinfo", () => getSysInfo());
ipcMain.handle("get-live-stats", () => getLiveStats());
