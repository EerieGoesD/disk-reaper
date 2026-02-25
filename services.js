const { ipcMain } = require("electron");
const { exec } = require("child_process");

function parseCSV(line) {
  const cols = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += c;
  }
  cols.push(cur);
  return cols;
}

function getServices() {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-Service | Select-Object Name,DisplayName,Status | ConvertTo-Csv -NoTypeInformation"`,
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const services = [];
        for (const line of stdout.trim().split("\n").slice(1)) {
          const cols = parseCSV(line.trim());
          if (cols.length < 3 || !cols[0]) continue;
          services.push({ name: cols[0], displayName: cols[1], status: cols[2] });
        }
        services.sort((a, b) => a.displayName.localeCompare(b.displayName));
        resolve(services);
      }
    );
  });
}

function controlService(name, action) {
  const cmd = action === "start"
    ? `powershell -NoProfile -Command "Start-Service -Name '${name}'"`
    : `powershell -NoProfile -Command "Stop-Service -Name '${name}' -Force"`;
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

ipcMain.handle("get-services", () => getServices());
ipcMain.handle("control-service", (_, { name, action }) => controlService(name, action));