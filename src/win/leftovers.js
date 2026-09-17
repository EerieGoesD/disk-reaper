const { ipcMain, shell } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── App leftovers ────────────────────────────────────────────────
// Folders that uninstalled programs left behind in AppData, ProgramData and
// Program Files. A folder is only listed when nothing installed or running
// claims its name. Store apps are matched exactly by their package name, so
// those come pre-ticked; every other folder is matched by name, so it is
// listed unticked for the user to check.

function runPsJson(script, timeoutMs = 60 * 1000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout) => {
      try { resolve(JSON.parse((stdout || "").trim() || "null")); } catch { resolve(null); }
    });
  });
}

// Everything that counts as installed: uninstall entries from the registry
// (names, publishers and the folders they live in), Store packages, and the
// folders of every program running right now.
const INSTALLED_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$names = New-Object System.Collections.Generic.List[string]
$dirs  = New-Object System.Collections.Generic.List[string]
$families = New-Object System.Collections.Generic.List[string]
$regPaths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($regPath in $regPaths) {
  Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p) { return }
    if ($p.DisplayName) { $names.Add([string]$p.DisplayName) }
    if ($p.Publisher)   { $names.Add([string]$p.Publisher) }
    $names.Add([string]$_.PSChildName)
    if ($p.InstallLocation) { $dirs.Add([string]$p.InstallLocation) }
    if ($p.DisplayIcon)     { $dirs.Add((([string]$p.DisplayIcon).Trim('"') -split ',')[0]) }
    if ($p.UninstallString) {
      $u = ([string]$p.UninstallString).Trim()
      if ($u -match '^"([^"]+)"') { $dirs.Add($matches[1]) } elseif ($u -match '^(\\S+\\.exe)') { $dirs.Add($matches[1]) }
    }
  }
}
Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
  $families.Add([string]$_.PackageFamilyName)
  $names.Add([string]$_.Name)
  if ($_.InstallLocation) { $dirs.Add([string]$_.InstallLocation) }
}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  try { if ($_.Path) { $dirs.Add([string]$_.Path) } } catch {}
}
[PSCustomObject]@{ names = $names; dirs = $dirs; families = $families } | ConvertTo-Json -Compress -Depth 3
`;

// Windows' own folders and shared tool caches. They are never an app's leftovers.
const SYSTEM_PREFIXES = ["microsoft", "windows", "msbuild", "referenceassemblies", "commonfiles",
  "internetexplorer", "uninstallinformation", "modifiablewindowsapps", "packagecache", "usoshared",
  "usoprivate", "regid"];
const SYSTEM_NAMES = new Set(["packages", "programs", "temp", "tmp", "crashdumps", "d3dscache",
  "connecteddevicesplatform", "comms", "publishers", "peernetworking", "placeholdertilelogofolder",
  "virtualstore", "history", "inetcache", "inetcookies", "applicationdata", "desktop", "documents",
  "favorites", "startmenu", "templates", "ssh", "squirreltemp", "elevateddiagnostics", "dotnet",
  "iis", "iisexpress", "installer", "identities", "npm", "npmcache", "nodegyp", "pip", "pypa",
  "yarn", "pnpm", "pnpmstore", "nuget", "gobuild", "cargo", "gradle", "fontconfig", "lowregistry",
  "softwaredistribution", "diagnostics", "grouppolicy", "sun", "oracle", "java", "package",
  "cef", "chromium", "electron", "updater", "logs", "cache", "caches", "data", "config"]);

// Words in program names that say what kind of thing it is, not which one.
const GENERIC_WORDS = new Set(["desktop", "update", "updater", "tools", "tool", "service", "services",
  "driver", "drivers", "manager", "launcher", "helper", "runtime", "redistributable", "package",
  "setup", "installer", "client", "player", "user", "machine", "edition", "version", "bit",
  "x64", "x86", "amd64", "arm64", "inc", "llc", "ltd", "corporation", "corp", "software", "systems",
  "technologies", "limited", "gmbh", "company", "games", "studio", "suite", "support", "plugin"]);

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// PowerShell turns a one-item list into a bare value, and an empty one into nothing.
const list = v => Array.isArray(v) ? v : (v ? [v] : []);

// Two names that are the same thing: equal, or one starts the other and both
// are long enough that it isn't a coincidence.
const sameName = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// The folder roots that uninstalled programs leave things in.
function leftoverRoots() {
  const env = process.env;
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return {
    folders: [
      { root: env.APPDATA || path.join(home, "AppData", "Roaming"), location: "AppData\\Roaming" },
      { root: local, location: "AppData\\Local" },
      { root: path.join(local, "Programs"), location: "AppData\\Local\\Programs" },
      { root: env.ProgramData || "C:\\ProgramData", location: "ProgramData" },
      { root: env.ProgramFiles || "C:\\Program Files", location: "Program Files" },
      { root: env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", location: "Program Files (x86)" },
    ],
    packages: path.join(local, "Packages"),
  };
}

// "5319275A.WhatsAppDesktop_cv1g1gvanyjgm" -> "WhatsAppDesktop"
function packageLabel(family) {
  const name = family.replace(/_[a-z0-9]+$/i, "");
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

async function folderSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += (await fs.promises.stat(full)).size; } catch {} }
    }
  }
  return total;
}

// Paths the last scan offered, so the renderer can only ever trash those.
let lastScanPaths = new Set();

async function findAppLeftovers() {
  const installed = await runPsJson(INSTALLED_SCRIPT);
  if (!installed) return { ok: false, error: "Could not read the list of installed programs." };

  const families = new Set(list(installed.families).map(f => String(f).toLowerCase()));
  const tokens = new Set();
  const addToken = t => { const n = norm(t); if (n.length >= 3) tokens.add(n); };
  for (const name of list(installed.names)) {
    addToken(name);
    // Each distinctive word answers too: "Brave Software Inc" claims Brave,
    // "Microsoft Visual Studio Code" claims Code, where it keeps its settings.
    for (const word of String(name).split(/[\s(),.\-_]+/)) {
      const n = norm(word);
      if (n.length >= 4 && !GENERIC_WORDS.has(n)) tokens.add(n);
    }
  }
  // Every folder along an installed program's path claims its own name.
  for (const dir of list(installed.dirs)) {
    for (const seg of String(dir).split(/[\\/]+/)) addToken(seg.replace(/\.exe$/i, ""));
  }
  const claimed = n => [...tokens].some(t => sameName(t, n));
  const isSystem = n => SYSTEM_NAMES.has(n) || SYSTEM_PREFIXES.some(p => n.startsWith(p));

  const { folders, packages } = leftoverRoots();
  const found = [];

  // Store apps: a package folder with no installed package of that exact name.
  let pkgEntries = [];
  try { pkgEntries = fs.readdirSync(packages, { withFileTypes: true }); } catch {}
  for (const e of pkgEntries) {
    if (!e.isDirectory()) continue;
    const family = e.name;
    const low = family.toLowerCase();
    if (families.has(low) || low.startsWith("microsoft") || low.startsWith("windows") || low.startsWith("ms-")) continue;
    const label = packageLabel(family);
    found.push({ label, key: norm(label), path: path.join(packages, family), location: "AppData\\Local\\Packages", sure: true });
  }

  // Program folders: nothing installed or running claims the name.
  const skipRoots = new Set(folders.map(f => path.resolve(f.root).toLowerCase()).concat(path.resolve(packages).toLowerCase()));
  for (const { root, location } of folders) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const full = path.join(root, e.name);
      if (skipRoots.has(path.resolve(full).toLowerCase())) continue;
      const n = norm(e.name);
      if (n.length < 3 || isSystem(n) || claimed(n)) continue;
      found.push({ label: e.name, key: n, path: full, location, sure: false });
    }
  }

  // One entry per app: folders with matching names across the roots group up,
  // and a Store package groups with a folder of the same name.
  const groups = [];
  for (const item of found) {
    const g = groups.find(x => sameName(x.key, item.key));
    if (g) {
      g.paths.push(item);
      g.sure = g.sure || item.sure;
      // A plain folder name reads better than a package name, and a
      // capitalised one better than "discord".
      if (!item.sure && (g.labelFromPackage || (g.app === g.app.toLowerCase() && item.label !== item.label.toLowerCase()))) {
        g.app = item.label; g.labelFromPackage = false;
      }
    } else {
      groups.push({ app: item.label, key: item.key, labelFromPackage: item.sure, sure: item.sure, paths: [item] });
    }
  }

  const sized = await Promise.all(groups.map(async g => {
    const paths = await Promise.all(g.paths.map(async p => ({ path: p.path, location: p.location, size: await folderSize(p.path) })));
    return { app: g.app, sure: g.sure, paths, size: paths.reduce((s, p) => s + p.size, 0) };
  }));

  lastScanPaths = new Set(sized.flatMap(g => g.paths.map(p => p.path)));
  return { ok: true, apps: sized.sort((a, b) => (b.sure - a.sure) || (b.size - a.size)) };
}

async function trashAppLeftovers(paths) {
  const results = [];
  for (const p of paths || []) {
    if (!lastScanPaths.has(p)) { results.push({ path: p, ok: false, error: "not part of the last scan" }); continue; }
    try {
      await shell.trashItem(p);
      lastScanPaths.delete(p);
      results.push({ path: p, ok: true });
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  return results;
}

ipcMain.handle("find-app-leftovers", () => findAppLeftovers());
ipcMain.handle("trash-app-leftovers", (_, paths) => trashAppLeftovers(paths));

module.exports = { findAppLeftovers, trashAppLeftovers, packageLabel, sameName, norm };
