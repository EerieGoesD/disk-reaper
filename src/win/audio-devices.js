const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const { runElevatedBatch } = require("./run-elevated");

// ── Extra audio devices ──────────────────────────────────────────
// Inputs and outputs that other apps add to Sound settings (virtual cables,
// meeting, streaming or EQ devices) are sound devices that software created,
// not hardware: Windows lists them under ROOT\ in Device Manager. The PC's
// own speakers, microphone, headphones and HDMI sound are hardware and never
// are. Windows' own software devices are left out too.

function runPsJson(script, timeoutMs = 60 * 1000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout) => {
      try { resolve(JSON.parse((stdout || "").trim() || "null")); } catch { resolve(null); }
    });
  });
}

// PowerShell turns a one-item list into a bare value, and an empty one into nothing.
const list = v => Array.isArray(v) ? v : (v ? [v] : []);

// Each software sound device, its driver, and the names it shows under in
// Sound settings ("CABLE Input (VB-Audio Virtual Cable)" belongs to the
// device called "VB-Audio Virtual Cable").
const SCAN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ends = @(Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' })
$out = foreach ($d in @(Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'ROOT\\*' })) {
  $props = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverInfPath','DEVPKEY_Device_DriverProvider' -ErrorAction SilentlyContinue
  $inf  = [string](($props | Where-Object KeyName -eq 'DEVPKEY_Device_DriverInfPath').Data)
  $prov = [string](($props | Where-Object KeyName -eq 'DEVPKEY_Device_DriverProvider').Data)
  if ($prov -match '^Microsoft') { continue }
  $name = [string]$d.FriendlyName
  $shows = @($ends | Where-Object { ([string]$_.FriendlyName).EndsWith("($name)") } | ForEach-Object { [string]$_.FriendlyName })
  [PSCustomObject]@{ id = [string]$d.InstanceId; name = $name; provider = $prov; inf = $inf; present = ($d.Status -eq 'OK'); shows = $shows }
}
@($out) | ConvertTo-Json -Compress -Depth 3
`;

// Devices the last scan offered, so the window can only ever remove those.
let lastScan = new Map();

async function findAudioDevices() {
  const data = await runPsJson(SCAN_SCRIPT);
  if (data === null) return { ok: false, error: "Could not read the list of sound devices." };
  const devices = list(data).map(d => ({
    id: String(d.id),
    name: String(d.name || d.id),
    provider: String(d.provider || ""),
    inf: String(d.inf || ""),
    present: !!d.present,
    shows: list(d.shows).map(String),
  }));
  lastScan = new Map(devices.map(d => [d.id, d]));
  return { ok: true, devices };
}

// Removes the chosen devices, then their drivers, under one admin prompt.
// A driver is only deleted once no device uses it any more, so a driver
// shared with a device that was left ticked off stays.
async function removeAudioDevices(ids) {
  const chosen = (ids || []).map(id => lastScan.get(id)).filter(Boolean);
  if (!chosen.length) return { ok: false, error: "Nothing from the last scan was chosen." };
  const infs = [...new Set(chosen.map(d => d.inf).filter(inf => /^oem\d+\.inf$/i.test(inf)))];
  const commands = [
    ...chosen.map((d, i) => ({ id: `device${i}`, cmd: "pnputil", args: ["/remove-device", d.id] })),
    ...infs.map((inf, i) => ({ id: `driver${i}`, cmd: "pnputil", args: ["/delete-driver", inf] })),
  ];
  const results = await runElevatedBatch(commands);
  if (results.every(r => r.error)) return { ok: false, error: results[0].error || "Cancelled at the admin prompt." };

  // What is actually gone, read back from Windows rather than trusted.
  const left = await runPsJson(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.InstanceId }) | ConvertTo-Json -Compress
`);
  const stillThere = new Set(list(left).map(String));
  const devices = chosen.map((d, i) => {
    // If the read-back fails, fall back to what the removal itself reported.
    const gone = left === null ? !!(results.find(r => r.id === `device${i}`) || {}).ok : !stillThere.has(d.id);
    if (gone) lastScan.delete(d.id);
    return { id: d.id, name: d.name, ok: gone };
  });
  const drivers = infs.map((inf, i) => ({ inf, ok: !!(results.find(r => r.id === `driver${i}`) || {}).ok }));
  return { ok: true, devices, drivers };
}

ipcMain.handle("find-audio-devices", () => findAudioDevices());
ipcMain.handle("remove-audio-devices", (_, ids) => removeAudioDevices(ids));

module.exports = { findAudioDevices, removeAudioDevices };
