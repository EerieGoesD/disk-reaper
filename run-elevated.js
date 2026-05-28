const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Broadcast progress events to the renderer so cleaner's activity log can
// display "Requesting elevation...", "UAC: accepted/declined", per-step
// results, etc. Best-effort - if Electron is not loaded (e.g. running in a
// test harness) this silently no-ops.
function broadcastLog(text, level) {
  if (!text) return;
  try {
    const { BrowserWindow } = require("electron");
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w && !w.isDestroyed()) {
        w.webContents.send("elevation-log", { text, level: level || "info" });
      }
    }
  } catch {}
}

function quote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// commands: [{ id: 'set-dns', cmd: 'netsh', args: [...] }]
// onLog:    optional (text, level) => void  - called with progress messages
// returns:  [{ id, ok, stdout, exitCode }]
async function runElevatedBatch(commands, onLog) {
  const log = (text, level) => {
    broadcastLog(text, level);
    if (typeof onLog === "function") onLog(text, level);
  };
  if (!commands || !commands.length) return [];
  const label = commands.map(c => c.id).join(", ");
  log(`Elevation requested for: ${label}`, "info");
  const outFile = path.join(
    os.tmpdir(),
    `dr_elev_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );

  const psBody = commands
    .map((c, i) => {
      const argsArr = (c.args || []).map(quote).join(",");
      return `
$id${i} = ${quote(c.id)};
$exe${i} = ${quote(c.cmd)};
$args${i} = @(${argsArr});
try {
  $out${i} = & $exe${i} @args${i} 2>&1 | Out-String;
  $ec${i} = $LASTEXITCODE;
  if ($null -eq $ec${i}) { $ec${i} = 0 }
} catch {
  $out${i} = $_.Exception.Message;
  $ec${i} = -1;
}
$results += [PSCustomObject]@{ id = $id${i}; ok = ($ec${i} -eq 0); stdout = $out${i}; exitCode = $ec${i} };`;
    })
    .join("\n");

  const fullScript = `
$ErrorActionPreference = 'Continue';
$results = @();
${psBody}
($results | ConvertTo-Json -Depth 5) | Set-Content -Path ${quote(outFile)} -Encoding UTF8;
`;

  const encoded = Buffer.from(fullScript, "utf16le").toString("base64");
  const outerCommand =
    `try { Start-Process powershell ` +
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' ` +
    `-Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop } ` +
    `catch { Write-Error $_.Exception.Message; exit 1 }`;

  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", outerCommand],
      { windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        const failAll = (reason) => {
          log(`Elevation failed: ${reason}`, "err");
          resolve(
            commands.map((c) => ({
              id: c.id,
              ok: false,
              stdout: "",
              exitCode: -1,
              error: reason,
            }))
          );
        };
        if (err) {
          try { fs.unlinkSync(outFile); } catch {}
          const reason = (stderr && String(stderr).trim()) || err.message || "";
          if (/canceled by the user|operation was canceled/i.test(reason)) {
            log("UAC: declined by user", "warn");
          } else {
            log(`UAC: failed (${reason || "unknown"})`, "err");
          }
          return failAll(reason || "UAC cancelled or elevation failed");
        }
        try {
          if (!fs.existsSync(outFile)) {
            return failAll("Elevated process produced no output file");
          }
          const raw = fs.readFileSync(outFile, "utf8").replace(/^﻿/, "").trim();
          fs.unlinkSync(outFile);
          if (!raw) return failAll("Elevated process produced empty output");
          log("UAC: accepted, elevated process completed", "ok");
          const data = JSON.parse(raw);
          const arr = Array.isArray(data) ? data : [data];
          const map = new Map(arr.map((r) => [r.id, r]));
          const out = commands.map((c) => {
            const r = map.get(c.id);
            if (!r) {
              log(`${c.id}: no result captured`, "err");
              return { id: c.id, ok: false, stdout: "", exitCode: -1, error: "No result captured" };
            }
            log(`${c.id}: ${r.ok ? "ok" : `failed (exit ${r.exitCode})`}`, r.ok ? "ok" : "err");
            return {
              id: c.id,
              ok: !!r.ok,
              stdout: r.stdout || "",
              exitCode: r.exitCode == null ? -1 : r.exitCode,
            };
          });
          resolve(out);
        } catch (e) {
          try { fs.unlinkSync(outFile); } catch {}
          failAll(e.message);
        }
      }
    );
  });
}

// Convenience: run a single PowerShell script elevated.
// Returns { ok, stdout, exitCode, error }.
async function runElevatedPs(psScript, onLog) {
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const results = await runElevatedBatch(
    [{ id: "ps", cmd: "powershell", args: ["-NoProfile", "-EncodedCommand", encoded] }],
    onLog
  );
  return results[0];
}

module.exports = { runElevatedBatch, runElevatedPs };
