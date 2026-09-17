const { ipcMain } = require("electron");
const { exec, execFile } = require("child_process");
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

// Startup type keys used across the app and the values sc.exe expects.
const START_TYPES = {
  Automatic:        { label: "Automatic",                 sc: "auto" },
  AutomaticDelayed: { label: "Automatic (Delayed Start)", sc: "delayed-auto" },
  Manual:           { label: "Manual",                    sc: "demand" },
  Disabled:         { label: "Disabled",                  sc: "disabled" },
};

const LIST_SERVICES_PS = [
  "$delayed = @{};",
  "Get-ChildItem 'HKLM:/SYSTEM/CurrentControlSet/Services' -ErrorAction SilentlyContinue | ForEach-Object {",
  "  if ($_.GetValue('DelayedAutostart') -eq 1) { $delayed[$_.PSChildName] = $true } };",
  "Get-Service -ErrorAction SilentlyContinue |",
  "  Select-Object Name, DisplayName, Status, @{n='StartType';e={",
  "    if ($_.StartType -eq 'Automatic' -and $delayed.ContainsKey($_.Name)) { 'AutomaticDelayed' }",
  "    else { [string]$_.StartType } }} |",
  "  ConvertTo-Csv -NoTypeInformation",
].join("\n");

function getServices() {
  // Windows reports a delayed-start service as "Automatic", so the delayed
  // flag is read from each service's registry entry and merged in.
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", LIST_SERVICES_PS],
      { windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const services = [];
        for (const line of stdout.trim().split("\n").slice(1)) {
          const cols = parseCSV(line.trim());
          if (cols.length < 3 || !cols[0]) continue;
          const key = (cols[3] || "").trim();
          services.push({
            name: cols[0],
            displayName: cols[1],
            status: cols[2],
            startType: key,
            startTypeLabel: (START_TYPES[key] && START_TYPES[key].label) || key || "Unknown",
          });
        }
        services.sort((a, b) => a.displayName.localeCompare(b.displayName));
        resolve(services);
      }
    );
  });
}

// Change how a service starts with Windows. Stopping a service is temporary:
// an Automatic service starts again on the next boot, so the startup type is
// what actually keeps it off. Needs admin, same as start/stop.
async function setServiceStartType(name, startType) {
  const cfg = START_TYPES[startType];
  if (!cfg) return { ok: false, error: `Unknown startup type: ${startType}` };

  const results = await runElevatedBatch([{
    id: "set-service-start-type",
    cmd: "sc.exe",
    args: ["config", String(name), "start=", cfg.sc],
  }]);
  const r = results[0];
  if (!r || !r.ok) {
    const out = (r && r.stdout ? String(r.stdout).trim() : "");
    const reason = (r && r.error) || out || `exit ${r && r.exitCode}`;
    return { ok: false, error: reason };
  }
  return { ok: true };
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
ipcMain.handle("set-service-start-type", (_, { name, startType }) => setServiceStartType(name, startType));