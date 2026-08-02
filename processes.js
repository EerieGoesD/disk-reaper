const { ipcMain } = require("electron");
const { execFile } = require("child_process");

function runPS(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => resolve(stdout || "")
    );
  });
}

async function getProcesses(withCpu) {
  // CPU % needs two readings a second apart; only sampled when asked for.
  const sample = withCpu ? `
$cores = [Environment]::ProcessorCount
$t0 = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  try { $t0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {}
}
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 700
$sw.Stop()
$span = $sw.Elapsed.TotalMilliseconds
` : `
$t0 = @{}
$cores = 1
$span = 0
`;
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${sample}
Get-Process -ErrorAction SilentlyContinue |
  Select-Object Name, Id,
    @{n='memBytes';    e={ $_.WorkingSet64 }},
    @{n='cpuPct';      e={
        $prev = $t0[$_.Id]
        if ($span -le 0 -or $null -eq $prev) { 0 }
        else {
          try {
            $d = $_.TotalProcessorTime.TotalMilliseconds - $prev
            if ($d -lt 0) { 0 } else { [math]::Round(($d / $span) * 100 / $cores, 1) }
          } catch { 0 }
        }
      }},
    @{n='description'; e={ if ($_.Description) { $_.Description } else { '' } }} |
  Sort-Object memBytes -Descending |
  ConvertTo-Json -Compress -Depth 1
`;
  const stdout = await runPS(script);
  const s = stdout.indexOf("["), e = stdout.lastIndexOf("]");
  if (s === -1 || e === -1) return [];
  try {
    let arr = JSON.parse(stdout.slice(s, e + 1));
    if (!Array.isArray(arr)) arr = [arr];
    return arr.filter((p) => p && p.Name).map((p) => ({
      name:        String(p.Name        || ""),
      pid:         parseInt(p.Id)       || 0,
      memBytes:    parseInt(p.memBytes) || 0,
      cpuPct:      parseFloat(p.cpuPct) || 0,
      description: String(p.description || ""),
    }));
  } catch { return []; }
}

function killProcess(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/PID", String(pid)], (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

ipcMain.handle("get-processes", (_, withCpu) => getProcesses(withCpu));
ipcMain.handle("kill-process",  (_, pid) => killProcess(pid));
