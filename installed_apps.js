const { ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");

function runPS(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => resolve(stdout || "")
    );
  });
}

async function getInstalledApps() {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$seen   = @{}
$result = [System.Collections.Generic.List[PSCustomObject]]::new()

$regPaths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)

foreach ($regPath in $regPaths) {
  try {
    $keys = Get-ChildItem $regPath -ErrorAction SilentlyContinue
    if (-not $keys) { continue }
    foreach ($key in $keys) {
      try {
        $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
        if (-not $p -or -not $p.DisplayName -or $p.DisplayName.Trim() -eq '') { continue }
        $name  = $p.DisplayName.Trim()
        $lower = $name.ToLower()
        if ($seen.ContainsKey($lower)) { continue }
        $seen[$lower] = $true
        $loc = if ($p.InstallLocation) { $p.InstallLocation.TrimEnd('\\') } else { '' }
        $result.Add([PSCustomObject]@{
          name            = $name
          publisher       = if ($p.Publisher)      { $p.Publisher.Trim() }      else { '' }
          sizeKB          = if ($p.EstimatedSize)  { [long]$p.EstimatedSize }   else { 0 }
          version         = if ($p.DisplayVersion) { $p.DisplayVersion.Trim() } else { '' }
          uninstallString = if ($p.UninstallString){ $p.UninstallString }       else { '' }
          installLocation = $loc
          dataLocation    = ''
        })
      } catch {}
    }
  } catch {}
}

try {
  $pkgs = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework }
  foreach ($pkg in $pkgs) {
    $displayName = $pkg.Name
    try {
      $mf = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
      if (Test-Path $mf -ErrorAction SilentlyContinue) {
        [xml]$xml = Get-Content $mf -Raw -ErrorAction SilentlyContinue
        $dn = $xml.Package.Properties.DisplayName
        if ($dn -and $dn.Trim() -ne '' -and $dn -notmatch '^ms-resource') { $displayName = $dn.Trim() }
      }
    } catch {}
    $lower = $displayName.ToLower()
    if (-not $seen.ContainsKey($lower)) {
      $seen[$lower] = $true
      $loc     = if ($pkg.InstallLocation) { $pkg.InstallLocation.TrimEnd('\\') } else { '' }
      $dataLoc = Join-Path $env:LOCALAPPDATA "Packages\\$($pkg.PackageFamilyName)"
      $result.Add([PSCustomObject]@{
        name            = $displayName
        publisher       = $pkg.Publisher
        sizeKB          = 0
        version         = $pkg.Version.ToString()
        uninstallString = ''
        installLocation = $loc
        dataLocation    = $dataLoc
      })
    }
  }
} catch {}

$result | ConvertTo-Json -Compress -Depth 1
`;

  const stdout = await runPS(script);
  const s = stdout.indexOf("["), e = stdout.lastIndexOf("]");
  if (s === -1 || e === -1) return [];
  try {
    let arr = JSON.parse(stdout.slice(s, e + 1));
    if (!Array.isArray(arr)) arr = [arr];
    return arr
      .filter((a) => a && a.name)
      .map((a) => ({
        name:            String(a.name            || ""),
        publisher:       String(a.publisher       || ""),
        appSizeBytes:    (parseInt(a.sizeKB) || 0) * 1024,
        dataSizeBytes:   0,
        version:         String(a.version         || ""),
        uninstallString: String(a.uninstallString || ""),
        installLocation: String(a.installLocation || ""),
        dataLocation:    String(a.dataLocation    || ""),
      }))
      .sort((a, b) => b.appSizeBytes - a.appSizeBytes);
  } catch { return []; }
}

// ── Background folder-size streaming ─────────────────────────────
// Jobs format: [{ index, path, kind }]  kind = 'app' | 'data'
// Output line: "index|kind|bytes"
let sizeProc = null;

ipcMain.handle("start-size-calc", (event, jobs) => {
  if (sizeProc) { try { sizeProc.kill(); } catch {} sizeProc = null; }

  return new Promise((resolve) => {
    const ps1 = [
      '$input_data = $input | Out-String',
      '$jobs = $input_data.Trim() | ConvertFrom-Json',
      'foreach ($job in $jobs) {',
      '  $size = 0',
      '  try {',
      '    if ($job.path) {',
      '      $items = Get-ChildItem -LiteralPath $job.path -Recurse -Force -ErrorAction SilentlyContinue',
      '      if ($items) {',
      '        $sum = ($items | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum',
      '        if ($sum) { $size = [long]$sum }',
      '      }',
      '    }',
      '  } catch { $size = 0 }',
      '  $k = if ($job.kind) { $job.kind } else { "app" }',
      '  Write-Output "$($job.index)|$k|$size"',
      '  [Console]::Out.Flush()',
      '}',
    ].join('\n');

    const encoded = Buffer.from(ps1, "utf16le").toString("base64");
    sizeProc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "ignore"] });

    sizeProc.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        const parts = line.split("|");
        if (parts.length >= 3) {
          event.sender.send("app-size-update", {
            index:     parseInt(parts[0]),
            kind:      parts[1],
            sizeBytes: parseInt(parts[2]) || 0,
          });
        }
      }
    });

    sizeProc.on("close", () => { sizeProc = null; resolve(); });
    sizeProc.stdin.write(JSON.stringify(jobs));
    sizeProc.stdin.end();
  });
});

ipcMain.handle("stop-size-calc", () => {
  if (sizeProc) { try { sizeProc.kill(); } catch {} sizeProc = null; }
});

// ── Uninstall ─────────────────────────────────────────────────────
function uninstallApp(uninstallString) {
  return new Promise((resolve) => {
    if (!uninstallString) return resolve({ ok: false, error: "No uninstall command available." });
    try {
      const child = spawn(uninstallString, [], { shell: true, detached: true, stdio: "ignore" });
      child.on("error", err => resolve({ ok: false, error: err.message }));
      child.unref();
      setTimeout(() => resolve({ ok: true }), 200);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

ipcMain.handle("get-installed-apps", () => getInstalledApps());
ipcMain.handle("uninstall-app",      (_, s) => uninstallApp(s));