const { ipcMain } = require("electron");
const { exec } = require("child_process");
const { runElevatedBatch } = require("./run-elevated");

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

// Starting or stopping a Windows service requires admin rights. The Store
// build never runs elevated, so ask for permission and run the command there
// instead of failing with "Cannot open <service> service on computer".
async function controlService(name, action) {
  const verb = action === "start" ? "Start-Service" : "Stop-Service";
  const safe = String(name).replace(/'/g, "''");
  const ps = action === "start"
    ? `${verb} -Name '${safe}' -ErrorAction Stop`
    : `${verb} -Name '${safe}' -Force -ErrorAction Stop`;

  const results = await runElevatedBatch([{
    id: "control-service",
    cmd: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
  }]);
  const r = results[0];
  if (!r || !r.ok) {
    const out = (r && r.stdout ? String(r.stdout).trim() : "");
    const reason = (r && r.error) || out || `exit ${r && r.exitCode}`;
    return { ok: false, error: reason };
  }
  return { ok: true };
}

ipcMain.handle("get-services", () => getServices());
ipcMain.handle("control-service", (_, { name, action }) => controlService(name, action));