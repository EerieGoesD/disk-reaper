const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");

function runPS(scriptPath, args) {
  return new Promise((resolve) => {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])];
    execFile("powershell", psArgs,
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout);
      }
    );
  });
}

async function getStartupItems() {
  const script = path.join(__dirname, "scripts", "get-startup.ps1");
  const stdout = await runPS(script);
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
    return items;
  } catch { return []; }
}

async function setStartupEnabled(name, source, enabled, uwpPath) {
  const script = path.join(__dirname, "scripts", "set-startup.ps1");
  const args = [
    "-Name", name,
    "-Source", source,
    "-UwpPath", uwpPath || "",
    "-Enabled", enabled ? "1" : "0",
  ];
  const stdout = await runPS(script, args);
  if (stdout === null) return { ok: false, error: "PowerShell command failed" };
  return { ok: true };
}

ipcMain.handle("get-startup-items", () => getStartupItems());
ipcMain.handle("set-startup-enabled", (_, { name, source, enabled, uwpPath }) => setStartupEnabled(name, source, enabled, uwpPath));
