const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeTheme } = require('electron');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { execSync, exec, execFile } = require('child_process');
const { Worker }         = require('worker_threads');
const windowState        = require('../window-state');

// ── Window ───────────────────────────────────────────────────────
let mainWindow;
let scanWorker = null;

function createWindow() {
  const state = windowState.load({ width: 1200, height: 720 });
  mainWindow = new BrowserWindow({
    width:  state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth:  900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (state.maximized) mainWindow.maximize();
  windowState.track(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Light or dark, chosen in the window. Native parts (menus, dialogs, scroll
// bars) follow it.
ipcMain.handle('setTheme', (_e, theme) => {
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Large Files ──────────────────────────────────────────────────
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

ipcMain.handle('startScan', (event, opts) => {
  if (scanWorker) { scanWorker.terminate(); scanWorker = null; }

  const { limit, mode, root = null, exclude = [] } = opts || {};
  const label = mode === 'folders' ? 'folders' : 'files';

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
      workerData: { limit, mode, root, exclude },
    });
    scanWorker = worker;
    const release = () => { if (scanWorker === worker) scanWorker = null; };

    worker.on('message', msg => {
      if (msg.type === 'progress') {
        sendToWindow('scan-progress', { scanned: msg.scanned, label: msg.label, bytes: msg.bytes, total: msg.total });
      } else if (msg.type === 'partial') {
        sendToWindow('scan-partial', msg.items);
      } else if (msg.type === 'result') {
        release();
        resolve({ items: msg.items, scanned: msg.scanned, label: msg.label });
      } else if (msg.type === 'error') {
        release();
        reject(new Error(msg.error));
      }
    });

    worker.on('error', err => { release(); reject(err); });
    // Only reached without a result when the worker was replaced by a newer
    // scan, so unblock the old await with an empty list.
    worker.on('exit', () => { release(); resolve({ items: [], scanned: 0, label }); });
  });
});

ipcMain.on('pauseScan',  () => scanWorker?.postMessage({ cmd: 'pause' }));
ipcMain.on('resumeScan', () => scanWorker?.postMessage({ cmd: 'resume' }));
// The worker winds down at its next check and sends what it found so far,
// the same way a finished scan does.
ipcMain.on('stopScan',   () => scanWorker?.postMessage({ cmd: 'stop' }));

ipcMain.handle('pickFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// ── File operations ──────────────────────────────────────────────
ipcMain.handle('deleteFiles', async (event, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  return results;
});

ipcMain.on('showInFinder', (event, p) => shell.showItemInFolder(p));

// ── Installed Apps ───────────────────────────────────────────────
ipcMain.handle('getInstalledApps', async () => {
  const apps   = [];
  const seen   = new Set();
  const appDirs = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
  ];

  for (const dir of appDirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (!entry.name.endsWith('.app')) continue;
      const appPath = path.join(dir, entry.name);
      if (seen.has(appPath)) continue;
      seen.add(appPath);

      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      let name      = entry.name.replace(/\.app$/, '');
      let version   = '';
      let publisher = '';

      try {
        const json = JSON.parse(
          execSync(`plutil -convert json -o - "${plistPath}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        );
        name      = json.CFBundleDisplayName || json.CFBundleName || name;
        version   = json.CFBundleShortVersionString || json.CFBundleVersion || '';
        publisher = json.NSHumanReadableCopyright || '';

        // Extract company from copyright string
        if (publisher) {
          publisher = publisher
            .replace(/Copyright\s+/i, '')
            .replace(/©|\(c\)/gi, '')
            .replace(/\d{4}[-–]\d{4}|\d{4}/g, '')
            .split('.')[0]
            .replace(/^[\s,]+|[\s,]+$/g, '')
            .trim();
        }
        if (!publisher && json.CFBundleIdentifier) {
          const parts = json.CFBundleIdentifier.split('.');
          if (parts.length >= 2) publisher = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
        }
      } catch { /* plist unreadable */ }

      const supportName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim() || entry.name.replace(/\.app$/, '');
      apps.push({
        name,
        version,
        publisher,
        installLocation: appPath,
        dataLocation:    path.join(os.homedir(), 'Library', 'Application Support', supportName),
        bundlePath:      appPath,
        appSizeBytes:    0,
        dataSizeBytes:   0,
        uninstallString: appPath, // on macOS: just the bundle path (we'll trash it)
      });
    }
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
});

// ── Size calculation ─────────────────────────────────────────────
let sizeCalcCancel = false;

ipcMain.handle('startSizeCalc', async (event, jobs) => {
  sizeCalcCancel = false;
  for (const job of jobs) {
    if (sizeCalcCancel) break;
    try {
      const out = execSync(`du -sk "${job.path.replace(/"/g, '\\"')}" 2>/dev/null`, { timeout: 10_000 }).toString();
      const kb  = parseInt(out.split('\t')[0]);
      if (!isNaN(kb)) {
        mainWindow.webContents.send('app-size-update', {
          index:     job.index,
          kind:      job.kind,
          sizeBytes: kb * 1024,
        });
      }
    } catch { /* path doesn't exist or no permission */ }
  }
});

ipcMain.on('stopSizeCalc', () => { sizeCalcCancel = true; });

ipcMain.handle('uninstallApp', async (event, bundlePath) => {
  try {
    await shell.trashItem(bundlePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Processes ────────────────────────────────────────────────────
ipcMain.handle('getProcesses', async () => {
  try {
    // pid, rss (KB), comm (short name), args (full cmd)
    const out = execSync('ps -A -o pid= -o rss= -o comm= -o args= 2>/dev/null', {
      maxBuffer: 10 * 1024 * 1024,
    }).toString();

    const procs = [];
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // Extract the two leading numeric fields (pid, rss) then treat the rest
      // as one string that contains "comm [args]". Splitting the whole line on
      // whitespace breaks names like "Brave Browser" or "Code Helper (Renderer)".
      const numMatch = line.match(/^(\d+)\s+(\d+)\s+([\s\S]+)/);
      if (!numMatch) continue;
      const pid = parseInt(numMatch[1]);
      const rss = parseInt(numMatch[2]);
      if (isNaN(pid) || isNaN(rss)) continue;

      const rest = numMatch[3];
      let name, desc;

      // macOS ps truncates comm to the first ~16 chars of argv[0], making names
      // like "/Applications/Brave Browser" become "/Applications/Br" or "Br".
      // Ignore comm entirely and extract the name from the full path in the args.
      const pathStart = rest.indexOf('/');

      if (pathStart >= 0) {
        const pathContent = rest.slice(pathStart);

        // Best case: find a .app bundle — gives the real user-facing app name
        const appMatch = pathContent.match(/\/([^/]+)\.app\//);
        if (appMatch) {
          name = appMatch[1]; // e.g. "Brave Browser", "Visual Studio Code", "Finder"
          const bundleIdx = pathContent.indexOf(appMatch[1] + '.app/');
          desc = bundleIdx >= 0 ? pathContent.slice(bundleIdx) : pathContent;
        } else {
          // Fallback: basename of the executable path, stopping before any flags
          const flagIdx = pathContent.search(/ --?[a-zA-Z]/);
          const execStr = (flagIdx > 0 ? pathContent.slice(0, flagIdx) : pathContent).trim();
          name = path.basename(execStr) || execStr.split('/').pop() || rest.trim();
          desc = pathContent;
        }
      } else {
        // No path at all — kernel threads, shell builtins, "npm start", etc.
        const words = rest.trim().split(/\s+/);
        name = words[0];
        desc = rest.trim();
      }
      if (!name) continue;

      procs.push({ pid, mem: rss * 1024, name, description: desc });
    }

    return procs.sort((a, b) => b.mem - a.mem);
  } catch {
    return [];
  }
});

ipcMain.handle('killProcess', async (event, { pid, killTree }) => {
  try {
    if (killTree) {
      killTreeRecursive(pid);
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function getChildPids(pid) {
  try {
    return execSync(`pgrep -P ${pid} 2>/dev/null`).toString().trim()
      .split('\n').map(Number).filter(n => !isNaN(n) && n > 0);
  } catch { return []; }
}

function killTreeRecursive(pid) {
  for (const child of getChildPids(pid)) {
    killTreeRecursive(child);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// ── Services (launchd) ───────────────────────────────────────────
ipcMain.handle('getServices', async () => {
  // 1. Get running labels from launchctl list
  const running = {};
  try {
    const listOut = execSync('launchctl list 2>/dev/null', { maxBuffer: 5 * 1024 * 1024 }).toString();
    for (const line of listOut.split('\n').slice(1)) {
      const parts = line.trim().split(/\t/);
      if (parts.length < 3) continue;
      const label = parts[2].trim();
      if (!label || label === 'Label') continue;
      running[label] = {
        pid:    parts[0] !== '-' ? parseInt(parts[0]) || null : null,
        exitCode: parts[1],
      };
    }
  } catch { /* launchctl unavailable */ }

  // 2. Scan plist directories
  const plistDirs = [
    { dir: '/Library/LaunchDaemons',                         type: 'Daemon' },
    { dir: '/Library/LaunchAgents',                          type: 'Agent' },
    { dir: path.join(os.homedir(), 'Library/LaunchAgents'),  type: 'User Agent' },
    { dir: '/System/Library/LaunchDaemons',                  type: 'System' },
    { dir: '/System/Library/LaunchAgents',                   type: 'System' },
  ];

  const services = [];
  const seen     = new Set();

  for (const { dir, type } of plistDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }

    for (const fname of entries) {
      if (!fname.endsWith('.plist')) continue;
      const plistPath  = path.join(dir, fname);
      const label      = fname.replace(/\.plist$/, '');
      if (seen.has(label)) continue;
      seen.add(label);

      let displayName = label;
      let description = '';

      try {
        const json = JSON.parse(
          execSync(`plutil -convert json -o - "${plistPath}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        );
        displayName = json.Label || label;
        description = json.ServiceDescription || '';
        if (!description && Array.isArray(json.ProgramArguments) && json.ProgramArguments.length > 0) {
          description = path.basename(json.ProgramArguments[0]);
        }
        if (!description && json.Program) {
          description = path.basename(json.Program);
        }
      } catch { /* plist unreadable */ }

      const runInfo  = running[label];
      const isRunning = runInfo != null && runInfo.pid != null;

      services.push({
        label,
        displayName,
        description,
        type,
        plistPath,
        status: isRunning ? 'running' : 'stopped',
      });
    }
  }

  return services.sort((a, b) => a.displayName.localeCompare(b.displayName));
});

ipcMain.handle('startService', async (event, { label, plistPath }) => {
  try {
    execSync(`launchctl load -w "${plistPath}" 2>&1`);
    return { ok: true };
  } catch (e1) {
    try {
      execSync(`launchctl start "${label}" 2>&1`);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e2.message || e1.message };
    }
  }
});

ipcMain.handle('stopService', async (event, { label, plistPath }) => {
  try {
    execSync(`launchctl unload "${plistPath}" 2>&1`);
    return { ok: true };
  } catch (e1) {
    try {
      execSync(`launchctl stop "${label}" 2>&1`);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e2.message || e1.message };
    }
  }
});

// ── Export ───────────────────────────────────────────────────────
ipcMain.handle('exportData', async (event, { format, filename, headers, rows }) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(os.homedir(), 'Desktop', filename),
      filters: format === 'csv'
        ? [{ name: 'CSV Files', extensions: ['csv'] }]
        : [{ name: 'Text Files', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'Cancelled' };

    let content;
    if (format === 'csv') {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      content = [
        headers.map(esc).join(','),
        ...rows.map(r => r.map(esc).join(',')),
      ].join('\r\n');
    } else {
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
      );
      const pad  = (s, w) => String(s ?? '').padEnd(w);
      const sep  = widths.map(w => '─'.repeat(w)).join('  ');
      content = [
        headers.map((h, i) => pad(h, widths[i])).join('  '),
        sep,
        ...rows.map(r => r.map((c, i) => pad(c, widths[i])).join('  ')),
      ].join('\n');
    }

    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Cleaner ───────────────────────────────────────────────────────
ipcMain.handle('runCleanerTask', async (event, taskId) => {
  // Wrap exec in a promise that always resolves (never rejects)
  const run = (cmd, timeout = 60_000) => new Promise(resolve => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || stderr || '').trim(), code: err?.code });
    });
  });

  // Run a shell command with a macOS admin-password prompt via osascript
  const adminRun = (shellCmd) => {
    const escaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run(`osascript -e 'do shell script "${escaped}" with administrator privileges'`, 300_000);
  };

  try {
    switch (taskId) {

      case 'maintenance': {
        const home = require('os').homedir();
        const lsreg = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
        const steps = [
          `echo "Clearing user app caches..."`,
          `rm -rf "${home}/Library/Caches/"* "${home}/.npm/_cacache" "${home}/.gradle/caches" 2>/dev/null || true`,
          `echo "Clearing system caches..."`,
          `rm -rf /Library/Caches/* 2>/dev/null || true`,
          `echo "Clearing temp files..."`,
          `rm -rf /private/tmp/* /private/var/tmp/* 2>/dev/null || true`,
          `echo "Rebuilding Launch Services database..."`,
          `"${lsreg}" -kill -r -domain local -domain system -domain user 2>&1 || true`,
          `echo "Clearing QuickLook thumbnail cache..."`,
          `qlmanage -r cache 2>/dev/null || true`,
          `echo "Rotating system logs..."`,
          `newsyslog 2>/dev/null || true`,
          `echo "Removing .DS_Store files from home folder..."`,
          `find "${home}" -name ".DS_Store" -delete 2>/dev/null || true`,
          `echo "Done."`,
        ];
        const r = await adminRun(steps.join('; '));
        if (/cancel/i.test(r.output)) return { ok: false, output: 'Cancelled.' };
        return { ok: true, output: r.output || 'Maintenance tasks completed.' };
      }

      case 'mail': {
        const mailBase = path.join(os.homedir(), 'Library', 'Mail');
        let versions;
        try { versions = fs.readdirSync(mailBase).filter(d => /^V\d+$/.test(d)).sort().reverse(); }
        catch { return { ok: false, output: 'Apple Mail is not configured on this Mac.' }; }
        for (const v of versions) {
          const dbPath = path.join(mailBase, v, 'MailData', 'Envelope Index');
          if (!fs.existsSync(dbPath)) continue;
          const r = await run(`sqlite3 "${dbPath.replace(/"/g, '\\"')}" vacuum`, 120_000);
          return { ok: r.ok, output: r.ok ? `Mail database compacted (${v}).` : (r.output || 'Failed.') };
        }
        return { ok: false, output: 'Mail database not found.' };
      }

      case 'spotlight': {
        // Searching is turned back on first. With it off for the volume macOS
        // itself lives on, Spotlight finds none of the built-in apps, so
        // typing "terminal" turns up nothing however often it is rebuilt.
        const steps = [
          'mdutil -i on / 2>&1 || true',
          'mdutil -i on /System/Volumes/Data 2>&1 || true',
          'mdutil -E / 2>&1 || true',
          'echo "---"',
          'mdutil -s / 2>&1',
          'mdutil -s /System/Volumes/Data 2>&1',
        ];
        const r = await adminRun(steps.join('; '));
        if (!r.ok) return { ok: false, output: /cancel/i.test(r.output) ? 'Cancelled.' : (r.output || 'Failed.') };
        return { ok: true, output: (r.output || 'Spotlight index erased.') + '\nRebuilding continues in the background.' };
      }

      case 'permissions': {
        const r = await run('diskutil verifyVolume / 2>&1', 120_000);
        return { ok: true, output: r.output || 'Disk verification complete.' };
      }

      case 'snapshots': {
        // Local snapshots are copies macOS keeps on this disk between backups.
        // Backups on the Time Machine disk itself are not touched.
        const listR = await run('tmutil listlocalsnapshots /', 30_000);
        const snaps = (listR.output || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!snaps.length) return { ok: true, output: 'No local Time Machine snapshots found.' };
        const lines = [];
        for (const snap of snaps) {
          const m = snap.match(/(\d{4}-\d{2}-\d{2}-\d{6})/);
          if (!m) continue;
          const r = await run(`tmutil deletelocalsnapshots ${m[1]}`, 30_000);
          lines.push(r.output || `Deleted ${m[1]}.`);
        }
        return { ok: true, output: lines.join('\n') || 'All snapshots deleted.' };
      }

      default:
        return { ok: false, output: `Unknown task: ${taskId}` };
    }
  } catch (e) {
    return { ok: false, output: e.message || String(e) };
  }
});

// ── App usage (version, CPU, memory, cache) ──────────────────────
ipcMain.handle('appVersion', () => app.getVersion());

// Disk Reaper's own processes: the app itself, which also runs the scanner,
// and the process drawing its window. Chromium's GPU and network helpers are
// left out, the same way a Tauri app's readout leaves out WebKit's helpers.
function ownProcessIds() {
  const pids = new Set([process.pid]);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const pid = mainWindow.webContents.getOSProcessId();
    if (pid) pids.add(pid);
  }
  return pids;
}

// CPU share is a difference between two readings, so the previous CPU seconds
// of each process are kept here. The very first call has nothing to compare
// with and reports 0.0, which is correct. Keyed by pid and start time, since a
// pid can be reused after a process dies.
let lastUsage = null;

ipcMain.handle('usage', async () => {
  const pids  = ownProcessIds();
  const now   = Date.now();
  const cores = Math.max(1, os.cpus().length);

  let cpu = null;
  const seconds = new Map();
  let readable = true;
  for (const m of app.getAppMetrics()) {
    if (!pids.has(m.pid)) continue;
    if (typeof m.cpu.cumulativeCPUUsage !== 'number') { readable = false; break; }
    seconds.set(m.pid + ':' + m.creationTime, m.cpu.cumulativeCPUUsage);
  }

  if (readable) {
    cpu = 0;
    if (lastUsage) {
      const elapsed = (now - lastUsage.at) / 1000;
      if (elapsed > 0) {
        let spent = 0;
        for (const [key, s] of seconds) {
          const was = lastUsage.seconds.get(key);
          if (was !== undefined) spent += Math.max(0, s - was);
        }
        // Spread across every core, so 100% means the whole processor is busy.
        cpu = Math.min(100, Math.max(0, spent / elapsed / cores * 100));
      }
    }
    lastUsage = { at: now, seconds };
  }

  // Physical footprint, the same number Activity Monitor prints in its Memory
  // column. The window's process adds its own reading on the other side.
  let footprintKB = null;
  try { footprintKB = (await process.getProcessMemoryInfo()).private; } catch {}

  return { cpu, footprintKB, totalKB: os.totalmem() / 1024 };
});

// What Disk Reaper itself has saved: its settings, kept in Local Storage.
// Chromium's own caches in the same folder (GPU, code, network) are left out,
// since the app can't control them and Chromium clears them by itself.
ipcMain.handle('cacheSize', () => {
  const walk = dir => {
    let sum = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) sum += walk(full);
      else if (e.isFile()) { try { sum += fs.statSync(full).size; } catch {} }
    }
    return sum;
  };
  return walk(path.join(app.getPath('userData'), 'Local Storage'));
});

// ── App leftovers ────────────────────────────────────────────────
// Files in ~/Library that belong to apps no longer on this Mac. Only entries
// named after a bundle ID (com.maker.App) are judged, because an ID ties data
// to one app for certain. A plain folder name is only added when it matches
// one of those leftover apps, which keeps macOS's own folders out of the list.
// Caches are left to Clear Caches and Temporary Files, which empties all of them.
const LEFTOVER_LOCATIONS = [
  'Application Support', 'Containers', 'Group Containers', 'Preferences',
  'Saved Application State', 'Logs', 'HTTPStorages', 'WebKit', 'LaunchAgents',
];

// Apple's data doesn't always start with com.apple: Podcasts sits under
// groups.com.apple, Shortcuts still uses its old Workflow name, the TV app has
// its own group, and org.swift is the Swift toolchain that comes with Xcode.
const APPLE_ID = /(^|\.)com\.apple\.|^(is\.workflow|tvappservices|org\.swift)\./;
const BUNDLE_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*){2,}$/i;

// Words that name a part of an app rather than the app itself.
const GENERIC_PART = new Set(['helper', 'extension', 'shared', 'private', 'family', 'client', 'app',
  'mac', 'macos', 'osx', 'desktop', 'group', 'container', 'sandbox', 'host', 'intents', 'updater',
  'menu', 'renderer', 'launcher', 'agent', 'service', 'pkg', 'audiounit', 'vst3']);

const normName = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function execFileText(cmd, args, timeout = 30_000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ''));
  });
}

// Bundles (.app, plug-ins, preference panes) under a folder, without looking
// inside the bundles themselves.
function findBundles(dir, exts, depth) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (exts.some(x => e.name.endsWith(x))) out.push(full);
    else if (depth > 0) out.push(...findBundles(full, exts, depth - 1));
  }
  return out;
}

// Everything that counts as installed: the Applications folders, whatever
// Spotlight knows about, apps running right now from anywhere, and audio
// plug-ins and preference panes, which share their maker's data with the app.
async function installedBundles() {
  const home = os.homedir();
  const ids = new Set();
  const names = new Set();
  const paths = new Set();

  for (const dir of ['/Applications', '/System/Applications', path.join(home, 'Applications')]) {
    for (const b of findBundles(dir, ['.app'], 3)) paths.add(b);
  }
  for (const dir of ['/Library/Audio/Plug-Ins', path.join(home, 'Library/Audio/Plug-Ins')]) {
    for (const b of findBundles(dir, ['.component', '.vst', '.vst3'], 1)) paths.add(b);
  }
  for (const dir of ['/Library/PreferencePanes', path.join(home, 'Library/PreferencePanes')]) {
    for (const b of findBundles(dir, ['.prefPane'], 0)) paths.add(b);
  }

  const spotlight = await execFileText('mdfind', ['-0', '-attr', 'kMDItemCFBundleIdentifier',
    "kMDItemContentType == 'com.apple.application-bundle'"]);
  for (const rec of spotlight.split('\0')) {
    const m = rec.match(/^(.*\.app)\s+kMDItemCFBundleIdentifier = "?([^"]*)"?$/);
    if (!m) continue;
    if (m[2] && m[2] !== '(null)') ids.add(m[2].toLowerCase());
    names.add(normName(path.basename(m[1], '.app')));
  }

  const running = await execFileText('ps', ['-axo', 'comm=']);
  for (const line of running.split('\n')) {
    const m = line.match(/^(.*?\.app)\//);
    if (m) paths.add(m[1]);
  }

  const list = [...paths];
  for (let i = 0; i < list.length; i += 16) {
    await Promise.all(list.slice(i, i + 16).map(async b => {
      names.add(normName(path.basename(b).replace(/\.[^.]+$/, '')));
      const id = (await execFileText('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
        path.join(b, 'Contents', 'Info.plist')], 5_000)).trim();
      if (id) ids.add(id.toLowerCase());
    }));
  }

  const vendors = new Set([...ids].map(id => id.split('.').slice(0, 2).join('.')));
  const vendorNames = new Set([...vendors].map(v => normName(v.split('.')[1] || '')).filter(n => n.length >= 4));
  return { ids, vendors, names, vendorNames };
}

// Two names that are the same thing: equal, or one starts the other and both
// are long enough that it isn't a coincidence.
const sameName = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Paths the last scan offered, so the window can only ever remove those.
let appLeftoverPaths = new Set();

ipcMain.handle('removeAppLeftovers', async (event, paths) => {
  const known = (paths || []).filter(p => appLeftoverPaths.has(p));
  const unknown = (paths || []).filter(p => !appLeftoverPaths.has(p))
    .map(p => ({ path: p, ok: false, error: 'not part of the last scan' }));
  const results = await removeLeftoverPaths(known, () => false);
  for (const r of results) if (r.ok) appLeftoverPaths.delete(r.path);
  return [...results, ...unknown];
});

ipcMain.handle('findAppLeftovers', async () => {
  const home = os.homedir();
  const installed = await installedBundles();
  const idInstalled = bare =>
    installed.ids.has(bare) ||
    installed.vendors.has(bare.split('.').slice(0, 2).join('.')) ||
    [...installed.ids].some(id => bare.startsWith(id + '.') || id.startsWith(bare + '.'));
  const nameInstalled = n =>
    n.length < 3 ||
    [...installed.names].some(x => sameName(x, n)) ||
    [...installed.vendorNames].some(v => sameName(v, n));

  const groups = new Map();   // vendor -> { parts: Map, paths: [] }
  const plain = [];

  for (const location of LEFTOVER_LOCATIONS) {
    let entries;
    try { entries = fs.readdirSync(path.join(home, 'Library', location)); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(home, 'Library', location, entry);
      const key  = entry.replace(/\.(plist|savedState|binarycookies)$/, '');
      // Team ID first (ABCDE12345.), then group. or groups., leaves the bare ID.
      const bare = key.replace(/^[A-Z0-9]{10}\./, '').replace(/^groups?\./i, '');

      if (BUNDLE_ID.test(bare)) {
        const low = bare.toLowerCase();
        // Parallels has its own task, which also fixes the file types it held.
        if (APPLE_ID.test(low) || idInstalled(low) || PARALLELS_MATCH.test(low)) continue;
        const segs = bare.split('.');
        const vendor = segs.slice(0, 2).join('.').toLowerCase();
        if (!groups.has(vendor)) groups.set(vendor, { parts: new Map(), paths: [] });
        const g = groups.get(vendor);
        const part = segs[2];
        if (!GENERIC_PART.has(part.toLowerCase())) g.parts.set(part, (g.parts.get(part) || 0) + 1);
        g.paths.push({ path: full, location });
      } else {
        const n = normName(key);
        if (!nameInstalled(n) && !PARALLELS_MATCH.test(key)) plain.push({ path: full, location, n });
      }
    }
  }

  const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
  const apps = [...groups.entries()].map(([vendor, g]) => {
    const ranked = [...g.parts.entries()].sort((a, b) => b[1] - a[1]);
    const maker = vendor.split('.')[1] || vendor;
    const part = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : '';
    return {
      part,
      maker,
      makerToken: normName(maker),
      partTokens: [...g.parts.keys()].map(normName).filter(t => t.length >= 3),
      vendor,
      paths: g.paths,
    };
  });

  // A plain folder joins an app only when its name matches that app: its
  // maker (Microsoft DevDiv for com.microsoft), exactly one of its parts, or
  // the tail of a part (Code for VSCode). A part never matches by its start:
  // "network" from io.branch.network would otherwise claim macOS's own
  // networkserviceproxy folder.
  for (const p of plain) {
    const owner = apps.find(a =>
      sameName(a.makerToken, p.n) ||
      a.partTokens.some(t => t === p.n || (p.n.length >= 4 && t.endsWith(p.n))));
    if (!owner) continue;
    owner.paths.push({ path: p.path, location: p.location });
    // A folder spelled like the app's part gives the app its proper casing.
    const folder = path.basename(p.path);
    if (owner.part && normName(folder) === normName(owner.part) && folder !== folder.toLowerCase()) owner.part = folder;
  }

  // Name each app after the part its entries mention most, or its maker.
  for (const a of apps) a.app = capital(a.part || a.maker);

  // Sizes in one du call, in the same order as the paths.
  const all = apps.flatMap(a => a.paths.map(x => x.path));
  const sizes = new Map();
  if (all.length) {
    const out = await execFileText('du', ['-sk', ...all], 120_000);
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) sizes.set(line.slice(tab + 1), parseInt(line.slice(0, tab)) * 1024);
    }
  }

  appLeftoverPaths = new Set(all);
  return apps
    .map(a => ({
      app: a.app,
      vendor: a.vendor,
      paths: a.paths.map(x => ({ ...x, size: sizes.get(x.path) || 0 })),
      size: a.paths.reduce((sum, x) => sum + (sizes.get(x.path) || 0), 0),
    }))
    .sort((a, b) => b.size - a.size);
});

// Moves leftovers to the Trash. Files under /Library are deleted behind one
// password prompt instead. macOS guards other apps' Containers no matter who
// asks - a password makes no difference there, only Full Disk Access does - so
// those are reported rather than retried.
const NO_ACCESS = /permission|not permitted|denied/i;
const FULL_DISK_ACCESS = 'macOS blocks this folder until Disk Reaper has Full Disk Access';

async function removeLeftoverPaths(paths, needsAdmin) {
  const results = [];
  const adminPaths = [];
  for (const p of paths) {
    if (needsAdmin(p)) { adminPaths.push(p); continue; }
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (e) {
      const blocked = NO_ACCESS.test(e.message || '');
      results.push({ path: p, ok: false, error: blocked ? FULL_DISK_ACCESS : e.message, blocked });
    }
  }

  // One password prompt covers all of them.
  if (adminPaths.length) {
    const quoted = adminPaths.map(p => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
    const escaped = `rm -rf ${quoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = await execFileText('osascript',
      ['-e', `do shell script "${escaped}" with administrator privileges`], 300_000);
    const cancelled = /cancel/i.test(out);
    for (const p of adminPaths) {
      const gone = !fs.existsSync(p);
      results.push({
        path: p,
        ok: gone,
        error: gone ? undefined : (cancelled ? 'Cancelled at the password prompt' : 'Could not be deleted'),
      });
    }
  }
  return results;
}

// ── Parallels leftovers ──────────────────────────────────────────
// Parallels Desktop publishes the Windows programs inside a virtual machine as
// Mac apps, in ~/Applications (Parallels). Uninstalling Parallels leaves those
// behind, so macOS still lists a Windows "Terminal" and Spotlight offers it
// instead of the real one, and opening it only says Parallels is missing. This
// clears the published apps, the rest of Parallels' files, and the file types
// still pointed at it.
const PARALLELS_MATCH = /parallels|^prl/i;
const LS_SECURE = 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/' +
  'LaunchServices.framework/Versions/A/Support/lsregister';

// Everything Parallels leaves behind, grouped the way the window lists it.
function parallelsGroups() {
  const home = os.homedir();
  const user = (dir, label) => ({ dir: path.join(home, dir), label, admin: false });
  const root = (dir, label) => ({ dir, label, admin: true });
  return [
    { app: 'Windows apps published to macOS', admin: false, dirs: [], fixed: [path.join(home, 'Applications (Parallels)')] },
    { app: 'Parallels app data', admin: false, dirs: [
      user('Library/Containers'), user('Library/Group Containers'), user('Library/Application Scripts'),
      user('Library/Application Support'), user('Library/WebKit'),
      user('Library/HTTPStorages'), user('Library/Saved Application State'),
    ], fixed: [] },
    { app: 'Parallels settings, logs and start-up items', admin: false, dirs: [
      user('Library/Preferences'), user('Library/Logs'), user('Library/LaunchAgents'),
    ], fixed: [] },
    { app: 'Parallels keychain', admin: false, dirs: [user('Library/Keychains')], fixed: [] },
    { app: 'Parallels system files', admin: true, dirs: [
      root('/Library'), root('/Library/Application Support'), root('/Library/Preferences'),
      root('/Library/LaunchDaemons'), root('/Library/LaunchAgents'),
      root('/Library/PrivilegedHelperTools'), root('/usr/local/bin'),
    ], fixed: [] },
  ];
}

// Paths the last scan offered, so the window can only ever remove those.
let parallelsPaths = new Map();

ipcMain.handle('findParallelsLeftovers', async () => {
  const home = os.homedir();
  const groups = [];
  for (const g of parallelsGroups()) {
    const hits = [];
    for (const fixed of g.fixed) {
      if (fs.existsSync(fixed)) hits.push(fixed);
    }
    for (const { dir } of g.dirs) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        if (PARALLELS_MATCH.test(e)) hits.push(path.join(dir, e));
      }
    }
    if (hits.length) groups.push({ app: g.app, admin: g.admin, hits });
  }

  const all = groups.flatMap(g => g.hits);
  const sizes = new Map();
  if (all.length) {
    const out = await execFileText('du', ['-sk', ...all], 120_000);
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) sizes.set(line.slice(tab + 1), parseInt(line.slice(0, tab)) * 1024);
    }
  }

  parallelsPaths = new Map(all.map(p => [p, groups.find(g => g.hits.includes(p)).admin]));
  return groups.map(g => ({
    // The published apps are worth counting, since that is the visible symptom.
    app: g.app === 'Windows apps published to macOS'
      ? `${g.app} (${countPublishedApps(g.hits[0])})`
      : g.app,
    admin: g.admin,
    paths: g.hits.map(p => ({
      path: p,
      location: p.startsWith(home) ? '~' + p.slice(home.length) : p,
      size: sizes.get(p) || 0,
    })),
    size: g.hits.reduce((sum, p) => sum + (sizes.get(p) || 0), 0),
  }));
});

function countPublishedApps(folder) {
  let count = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.endsWith('.app')) count++;
      else if (depth > 0) walk(path.join(dir, e.name), depth - 1);
    }
  };
  walk(folder, 3);
  return count === 1 ? '1 app' : `${count} apps`;
}

// Drops the file types still opened by Parallels, leaving every other choice
// alone. Returns how many were dropped, or -1 when the file can't be rewritten.
async function unassignParallelsHandlers() {
  const file = path.join(os.homedir(), LS_SECURE);
  if (!fs.existsSync(file)) return 0;
  const json = await execFileText('plutil', ['-convert', 'json', '-o', '-', file], 15_000);
  let data;
  try { data = JSON.parse(json); } catch { return -1; }
  const handlers = data.LSHandlers || [];
  const kept = handlers.filter(h =>
    !Object.values(h).some(v => typeof v === 'string' && /parallels/i.test(v)));
  const dropped = handlers.length - kept.length;
  if (!dropped) return 0;
  data.LSHandlers = kept;
  const temp = path.join(os.tmpdir(), 'disk-reaper-lshandlers.json');
  try {
    fs.writeFileSync(temp, JSON.stringify(data));
    const err = await execFileText('plutil', ['-convert', 'binary1', '-o', file, temp], 15_000);
    fs.unlinkSync(temp);
    if (err.trim()) return -1;
  } catch { return -1; }
  return dropped;
}

ipcMain.handle('removeParallelsLeftovers', async (event, paths) => {
  const known = (paths || []).filter(p => parallelsPaths.has(p));
  const results = await removeLeftoverPaths(known, p => parallelsPaths.get(p));
  for (const r of results) if (r.ok) parallelsPaths.delete(r.path);
  for (const p of (paths || [])) {
    if (!parallelsPaths.has(p) && !known.includes(p)) results.push({ path: p, ok: false, error: 'not part of the last scan' });
  }

  const handlers = await unassignParallelsHandlers();
  // Rebuild the list of apps macOS knows about, so the published apps stop
  // turning up in Spotlight and in Open With.
  await execFileText(LSREGISTER, ['-kill', '-r', '-domain', 'local', '-domain', 'system', '-domain', 'user'], 120_000);
  return { results, handlers };
});

// Opens the Full Disk Access list, the one setting that lets the app clear
// another app's leftovers.
ipcMain.handle('openFullDiskAccess', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'));

// ── Xcode simulators and components ──────────────────────────────
// Lists everything Xcode keeps for simulators and its add-ons, with sizes:
// each simulator version, old downloads Xcode no longer uses, the simulated
// devices, the caches that speed simulators up, device support files and the
// Metal toolchain. Each row carries a key that says how to remove it.
const SIM_PLATFORMS = {
  'com.apple.platform.iphonesimulator': 'iOS',
  'com.apple.platform.watchsimulator': 'watchOS',
  'com.apple.platform.appletvsimulator': 'tvOS',
  'com.apple.platform.xrsimulator': 'visionOS',
};
const SIM_ASSETS = '/System/Library/AssetsV2';

async function jsonOf(cmd, args) {
  try { return JSON.parse(await execFileText(cmd, args, 60_000)); } catch { return null; }
}

// Sizes in one du call, in bytes.
async function sizesOf(paths) {
  const sizes = new Map();
  if (!paths.length) return sizes;
  const out = await execFileText('du', ['-sk', ...paths], 300_000);
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) sizes.set(line.slice(tab + 1), parseInt(line.slice(0, tab)) * 1024);
  }
  return sizes;
}

// A value anywhere inside a parsed plist.
function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const shortDate = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

// Keys the last scan offered, so the window can only ever remove those.
let xcodeKeys = new Map();

ipcMain.handle('findXcodeSimulators', async () => {
  const home = os.homedir();
  const items = [];
  const runtimes = (await jsonOf('xcrun', ['simctl', 'runtime', 'list', '-j'])) || {};
  const deviceSets = ((await jsonOf('xcrun', ['simctl', 'list', 'devices', '-j'])) || {}).devices || {};

  // Simulator versions Xcode has set up.
  const builds = new Set();
  for (const [id, r] of Object.entries(runtimes)) {
    builds.add(r.build);
    const platform = SIM_PLATFORMS[r.platformIdentifier] || 'Simulator';
    const devices = (deviceSets[r.runtimeIdentifier] || []).length;
    items.push({
      key: `runtime:${id}`,
      app: `${platform} ${r.version} simulator`,
      size: r.sizeBytes || 0,
      lines: [
        r.lastUsedAt ? `Last used ${shortDate(r.lastUsedAt)}` : 'Not used yet',
        devices ? `${devices} simulated device${devices === 1 ? '' : 's'} use it` : 'No simulated devices use it',
        'Xcode downloads it again when you need it',
      ],
      disabled: r.deletable === false,
    });
  }

  // Downloads still on disk that Xcode isn't using.
  let assetDirs = [];
  try { assetDirs = fs.readdirSync(SIM_ASSETS).filter(d => /^com_apple_MobileAsset_.*SimulatorRuntime$/.test(d)); } catch {}
  const orphans = [];
  for (const dir of assetDirs) {
    const platform = (dir.match(/MobileAsset_(.*)SimulatorRuntime$/) || [])[1] || 'Simulator';
    let assets = [];
    try { assets = fs.readdirSync(path.join(SIM_ASSETS, dir)).filter(a => a.endsWith('.asset')); } catch {}
    for (const a of assets) {
      const full = path.join(SIM_ASSETS, dir, a);
      const info = await jsonOf('plutil', ['-convert', 'json', '-o', '-', path.join(full, 'Info.plist')]);
      const build = findKey(info, 'Build');
      if (build && builds.has(build)) continue;
      orphans.push({ full, platform, version: findKey(info, 'SimulatorVersion') || 'unknown version' });
    }
  }
  const orphanSizes = await sizesOf(orphans.map(o => o.full));
  for (const o of orphans) {
    items.push({
      key: `orphan:${o.full}`,
      app: `${o.platform} ${o.version} simulator download`,
      size: orphanSizes.get(o.full) || 0,
      lines: ["Xcode isn't using this one", "macOS protects this file, so it can't be removed from here"],
      disabled: true,
    });
  }

  // Simulated devices, one row per version.
  const devicesByRuntime = Object.entries(deviceSets).filter(([, list]) => list.length);
  const devicePaths = devicesByRuntime.flatMap(([, list]) => list.map(d => d.dataPath ? path.dirname(d.dataPath) : '')).filter(Boolean);
  const deviceSizes = await sizesOf(devicePaths);
  for (const [runtime, list] of devicesByRuntime) {
    const m = runtime.match(/SimRuntime\.(\w+?)-(\d+(?:-\d+)*)$/);
    const label = m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : runtime;
    const gone = list.every(d => d.isAvailable === false);
    items.push({
      key: `devices:${runtime}`,
      app: `${list.length} simulated device${list.length === 1 ? '' : 's'} on ${label}${gone ? ' (version no longer installed)' : ''}`,
      size: list.reduce((sum, d) => sum + (deviceSizes.get(d.dataPath ? path.dirname(d.dataPath) : '') || 0), 0),
      lines: list.map(d => d.name),
      udids: list.map(d => d.udid),
    });
  }

  // Caches that make simulators start faster.
  const dyld = '/Library/Developer/CoreSimulator/Caches/dyld';
  if (fs.existsSync(dyld)) {
    const size = (await sizesOf([dyld])).get(dyld) || 0;
    if (size > 0) items.push({
      key: 'dyld:all',
      app: 'Simulator speed-up caches',
      size,
      lines: ['Rebuilt automatically the next time a simulator starts'],
    });
  }

  // Files Xcode copies from a real iPhone, Watch or Apple TV you've plugged in.
  let xcodeDirs = [];
  try { xcodeDirs = fs.readdirSync(path.join(home, 'Library/Developer/Xcode')).filter(d => d.endsWith('DeviceSupport')); } catch {}
  for (const d of xcodeDirs) {
    const full = path.join(home, 'Library/Developer/Xcode', d);
    let versions = [];
    try { versions = fs.readdirSync(full).filter(v => !v.startsWith('.')); } catch {}
    if (!versions.length) continue;
    items.push({
      key: `devicesupport:${full}`,
      app: `${d.replace(/DeviceSupport$/, '').trim()} device support files`,
      size: (await sizesOf([full])).get(full) || 0,
      lines: [...versions, 'Copied again the next time you plug that device in'],
    });
  }

  // Build files Xcode keeps for each project it has built.
  const derived = path.join(home, 'Library/Developer/Xcode/DerivedData');
  let projects = [];
  try { projects = fs.readdirSync(derived).filter(d => !d.startsWith('.') && d !== 'ModuleCache.noindex'); } catch {}
  const derivedSize = fs.existsSync(derived) ? (await sizesOf([derived])).get(derived) || 0 : 0;
  if (derivedSize > 0) items.push({
    key: `trash:${derived}`,
    app: 'Xcode build files (Derived Data)',
    size: derivedSize,
    lines: [projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : 'Shared build caches', 'Rebuilt the next time you build'],
  });

  // Xcode add-ons.
  const metal = await jsonOf('xcrun', ['xcodebuild', '-showComponent', 'MetalToolchain', '-json']);
  if (metal && /installed/i.test(metal.status || '') && !/uninstalled/i.test(metal.status || '')) {
    items.push({
      key: 'component:MetalToolchain',
      app: 'Metal Toolchain',
      size: null,
      lines: ['Needed to build apps with Metal shaders', 'Xcode downloads it again when you need it'],
    });
  }

  xcodeKeys = new Map(items.filter(i => !i.disabled).map(i => [i.key, i]));
  return items.map(({ udids, ...rest }) => ({ ...rest, paths: [{ path: rest.key, size: rest.size || 0 }] }));
});

ipcMain.handle('removeXcodeSimulators', async (event, keys) => {
  const results = [];
  for (const key of keys || []) {
    const item = xcodeKeys.get(key);
    if (!item) { results.push({ path: key, ok: false, error: 'not part of the last scan' }); continue; }
    const [kind, ...rest] = key.split(':');
    const target = rest.join(':');
    let ok = false;
    let error = '';
    if (kind === 'runtime') {
      const out = await execFileText('xcrun', ['simctl', 'runtime', 'delete', target], 300_000);
      const left = (await jsonOf('xcrun', ['simctl', 'runtime', 'list', '-j'])) || {};
      ok = !left[target] || /deleting/i.test(left[target].state || '');
      error = out.trim().split('\n').pop();
    } else if (kind === 'devices') {
      for (const udid of item.udids) await execFileText('xcrun', ['simctl', 'delete', udid], 120_000);
      const left = ((await jsonOf('xcrun', ['simctl', 'list', 'devices', '-j'])) || {}).devices || {};
      const remaining = (left[target] || []).filter(d => item.udids.includes(d.udid)).length;
      ok = remaining === 0;
      error = `${remaining} device${remaining === 1 ? '' : 's'} could not be removed`;
    } else if (kind === 'dyld') {
      const out = await execFileText('xcrun', ['simctl', 'runtime', 'dyld_shared_cache', 'remove', '--all'], 300_000);
      const size = (await sizesOf(['/Library/Developer/CoreSimulator/Caches/dyld'])).get('/Library/Developer/CoreSimulator/Caches/dyld') || 0;
      ok = size < item.size;
      error = out.trim().split('\n').pop() || 'The caches are still there';
    } else if (kind === 'devicesupport' || kind === 'trash') {
      try { await shell.trashItem(target); ok = true; } catch (e) { error = e.message; }
    } else if (kind === 'component') {
      const out = await execFileText('xcrun', ['xcodebuild', '-deleteComponent', target], 300_000);
      const now = await jsonOf('xcrun', ['xcodebuild', '-showComponent', target, '-json']);
      ok = !now || /uninstalled/i.test(now.status || '');
      error = out.trim().split('\n').pop();
    }
    if (ok) xcodeKeys.delete(key);
    results.push({ path: key, ok, error: ok ? undefined : (error || 'Could not be removed') });
  }
  return results;
});

// ── Virtual machines ─────────────────────────────────────────────
// Every virtual machine on this Mac. Parallels, VMware Fusion, UTM and
// Android emulators are found by their bundle type wherever they sit in the
// home folder; Claude's sandbox, VirtualBox, Docker Desktop, Lima, Tart and
// Vagrant keep theirs in one known place each.
const VM_BUNDLES = [
  { ext: '.pvm', kind: 'Parallels' },
  { ext: '.vmwarevm', kind: 'VMware Fusion' },
  { ext: '.utm', kind: 'UTM' },
  { ext: '.avd', kind: 'Android emulator' },
];
const VM_SKIP = new Set(['Library', 'node_modules', '.git', '.Trash']);

function findVmBundles(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || VM_SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const type = VM_BUNDLES.find(b => e.name.endsWith(b.ext));
    if (type) out.push({ path: full, kind: type.kind, name: e.name.slice(0, -type.ext.length) });
    else if (depth > 0) findVmBundles(full, depth - 1, out);
  }
}

// Paths the last scan offered, so the window can only ever remove those.
let vmPaths = new Set();

ipcMain.handle('findVirtualMachines', async () => {
  const home = os.homedir();
  const tilde = p => p.startsWith(home) ? '~' + p.slice(home.length) : p;
  const found = [];

  findVmBundles(home, 4, found);
  findVmBundles('/Users/Shared', 3, found);
  findVmBundles(path.join(home, 'Library/Containers/com.utmapp.UTM/Data/Documents'), 1, found);

  // One machine per entry in each app's own folder.
  const folders = [
    { dir: path.join(home, 'VirtualBox VMs'), kind: 'VirtualBox' },
    { dir: path.join(home, '.lima'), kind: 'Lima', skip: n => n.startsWith('_') },
    { dir: path.join(home, '.tart/vms'), kind: 'Tart' },
    { dir: path.join(home, '.vagrant.d/boxes'), kind: 'Vagrant box' },
  ];
  for (const f of folders) {
    let entries = [];
    try { entries = fs.readdirSync(f.dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !(f.skip && f.skip(e.name))) {
        found.push({ path: path.join(f.dir, e.name), kind: f.kind, name: e.name });
      }
    }
  }

  const items = [];
  // Claude's sandbox, with any half-finished download beside it.
  const claude = path.join(home, 'Library/Application Support/Claude/vm_bundles');
  let claudeParts = [];
  try { claudeParts = fs.readdirSync(claude).map(n => path.join(claude, n)); } catch {}
  if (claudeParts.length) items.push({ app: 'Claude virtual machine', parts: claudeParts, note: 'Claude downloads it again the next time it needs it' });

  const docker = path.join(home, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
  if (fs.existsSync(docker)) items.push({ app: 'Docker Desktop disk', parts: [docker], note: 'Holds all your Docker images and containers' });

  for (const f of found) {
    const parts = [f.path];
    // An Android emulator also has a pointer file beside its folder.
    if (f.kind === 'Android emulator') {
      const dir = path.dirname(f.path);
      let inis = [];
      try { inis = fs.readdirSync(dir).filter(n => n.endsWith('.ini')); } catch {}
      for (const ini of inis) {
        try {
          if (fs.readFileSync(path.join(dir, ini), 'utf8').split('\n').some(l => l.trim() === `path=${f.path}`)) parts.push(path.join(dir, ini));
        } catch {}
      }
    }
    items.push({ app: `${f.kind}: ${f.name}`, parts });
  }

  const sizes = await sizesOf(items.flatMap(i => i.parts));
  const result = [];
  for (const i of items) {
    const inUse = (await Promise.all(i.parts.map(p =>
      execFileText('lsof', fs.statSync(p).isDirectory() ? ['+D', p] : [p], 60_000)))).some(out => out.trim());
    result.push({
      app: i.app,
      size: i.parts.reduce((sum, p) => sum + (sizes.get(p) || 0), 0),
      paths: i.parts.map(p => ({ path: p, size: sizes.get(p) || 0 })),
      lines: [...i.parts.map(tilde), ...(i.note ? [i.note] : []), ...(inUse ? ['Running right now. Quit the app using it first'] : [])],
      disabled: inUse,
    });
  }
  vmPaths = new Set(result.filter(r => !r.disabled).flatMap(r => r.paths.map(p => p.path)));
  return result.sort((a, b) => b.size - a.size);
});

ipcMain.handle('removeVirtualMachines', async (event, paths) => {
  const known = (paths || []).filter(p => vmPaths.has(p));
  const results = await removeLeftoverPaths(known, () => false);
  for (const r of results) if (r.ok) vmPaths.delete(r.path);
  for (const p of paths || []) {
    if (!known.includes(p)) results.push({ path: p, ok: false, error: 'not part of the last scan' });
  }
  return results;
});

// ── Old macOS leftovers ──────────────────────────────────────────
// What macOS upgrades leave behind: settings files moved aside to Relocated
// Items, old "Install macOS" apps, and update downloads in /Library/Updates.
// macOS protects the update downloads, so those are listed but not removed.
let oldMacosPaths = new Map();   // path -> needs the password prompt

ipcMain.handle('findOldMacosLeftovers', async () => {
  const home = os.homedir();
  const items = [];

  for (const dir of ['/Users/Shared/Relocated Items', '/Users/Shared/Previously Relocated Items']) {
    if (!fs.existsSync(dir)) continue;
    let inside = [];
    try { inside = fs.readdirSync(dir).filter(n => !n.startsWith('.')); } catch {}
    items.push({
      app: path.basename(dir),
      parts: [dir],
      admin: true,
      lines: [dir, 'Files macOS moved aside during an upgrade', inside.length ? `Holds: ${inside.join(', ')}` : 'Empty'],
    });
  }

  for (const dir of ['/Applications', path.join(home, 'Applications')]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^Install (macOS|OS X) .*\.app$/.test(n)); } catch {}
    for (const n of names) {
      const full = path.join(dir, n);
      let admin = false;
      try { admin = fs.statSync(full).uid === 0; } catch {}
      items.push({ app: n.replace(/\.app$/, ''), parts: [full], admin, lines: [full, 'Only needed to install that version of macOS'] });
    }
  }

  const updates = '/Library/Updates';
  let products = [];
  try { products = fs.readdirSync(updates).filter(n => fs.statSync(path.join(updates, n)).isDirectory()); } catch {}
  for (const id of products) {
    const full = path.join(updates, id);
    let pkg = '';
    try { pkg = fs.readdirSync(full).find(n => n.endsWith('.pkg')) || ''; } catch {}
    const m = pkg.match(/^([A-Za-z]+?)(\d+(?:\.\d+)*)/);
    items.push({
      app: m ? `${m[1]} ${m[2]} update download` : `Update download ${id}`,
      parts: [full],
      disabled: true,
      lines: [full, 'Waiting to install. macOS protects it, and clears it once you install the update in Software Update'],
    });
  }

  const sizes = await sizesOf(items.flatMap(i => i.parts));
  oldMacosPaths = new Map(items.filter(i => !i.disabled).flatMap(i => i.parts.map(p => [p, !!i.admin])));
  return items.map(i => ({
    app: i.app,
    admin: !!i.admin,
    disabled: !!i.disabled,
    lines: i.lines,
    paths: i.parts.map(p => ({ path: p, size: sizes.get(p) || 0 })),
    size: i.parts.reduce((sum, p) => sum + (sizes.get(p) || 0), 0),
  }));
});

ipcMain.handle('removeOldMacosLeftovers', async (event, paths) => {
  const known = (paths || []).filter(p => oldMacosPaths.has(p));
  const results = await removeLeftoverPaths(known, p => oldMacosPaths.get(p));
  for (const r of results) if (r.ok) oldMacosPaths.delete(r.path);
  for (const p of paths || []) {
    if (!known.includes(p)) results.push({ path: p, ok: false, error: 'not part of the last scan' });
  }
  return results;
});

// ── Networking ───────────────────────────────────────────────────
// The Mac counterpart of the Windows build's Networking section: a diagnosis
// that says in words where the connection breaks, then the fixes in the order
// to try them, safest first.
const dns = require('dns');
const net = require('net');

function shellText(cmd, timeout = 30_000) {
  return new Promise(resolve => exec(cmd, { timeout }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (stdout || stderr || '').trim() })));
}

// One password prompt, through macOS's own dialog.
function adminShell(cmd) {
  const script = `do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  return new Promise(resolve => execFile('osascript', ['-e', script], { timeout: 300_000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (stdout || stderr || '').trim(), cancelled: /cancel/i.test(stderr || '') })));
}

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

// The connection in use (from the default route), its network service name
// (what System Settings calls it, e.g. "Wi-Fi"), and the router's address.
async function activeNetwork() {
  const route = (await shellText('route -n get default 2>/dev/null', 10_000)).out;
  const device = (route.match(/interface:\s*(\S+)/) || [])[1] || '';
  const router = (route.match(/gateway:\s*(\S+)/) || [])[1] || '';
  const order = (await shellText('networksetup -listnetworkserviceorder', 10_000)).out;
  const services = [];
  const re = /\(\d+\)\s+(.+)\n\(Hardware Port: ([^,]*), Device: ([^)]*)\)/g;
  let m;
  while ((m = re.exec(order))) services.push({ name: m[1].trim(), port: m[2].trim(), device: m[3].trim() });
  return {
    device,
    router,
    service: services.find(x => x.device && x.device === device) || null,
    wifi: services.find(x => /wi-?fi|airport/i.test(x.port)) || null,
  };
}

function tcpReach(host, port, ms = 3000) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function lookupName(name, ms = 4000) {
  return Promise.race([
    dns.promises.lookup(name).then(r => r.address).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

ipcMain.handle('netDiagnose', async () => {
  const n = await activeNetwork();
  const ip = n.device ? (await shellText(`ipconfig getifaddr ${shq(n.device)}`, 5_000)).out : '';
  const connected = !!(n.device && ip);
  const where = n.service ? n.service.name : n.device;

  const routerOk = connected && !!n.router && (await shellText(`ping -c 2 -t 3 ${shq(n.router)}`, 8_000)).ok;
  // Some networks block ping, so a web connection counts as well.
  const internetOk = connected && (
    await tcpReach('1.1.1.1', 443) || await tcpReach('8.8.8.8', 53) ||
    (await shellText('ping -c 2 -t 3 1.1.1.1', 8_000)).ok);
  const started = Date.now();
  const address = connected ? await lookupName('apple.com') : null;
  const lookupMs = Date.now() - started;

  const servers = [...new Set(((await shellText('scutil --dns', 10_000)).out
    .match(/nameserver\[\d+\]\s*:\s*\S+/g) || []).map(l => l.split(':').pop().trim()))].slice(0, 4);
  const vpn = ((await shellText('scutil --nc list', 10_000)).out.match(/\(Connected\)[^"]*"([^"]+)"/) || [])[1] || '';
  const proxy = /(HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable)\s*:\s*1/.test((await shellText('scutil --proxy', 10_000)).out);

  const checks = [
    { label: 'Connected to a network', ok: connected, detail: connected ? `${where}, address ${ip}` : 'Not connected to Wi-Fi or a cable' },
    { label: 'Router answers', ok: routerOk, detail: n.router ? `Router at ${n.router}` : 'No router found' },
    { label: 'Internet reachable', ok: internetOk, detail: internetOk ? 'Reached Cloudflare and Google' : "Couldn't reach Cloudflare or Google" },
    { label: 'Website names load', ok: !!address, detail: address ? `apple.com found in ${lookupMs} ms` : "Couldn't look up apple.com" },
  ];
  const info = [
    `Website names come from: ${servers.length ? servers.join(', ') : 'none set'}`,
    vpn ? `VPN connected: ${vpn}` : 'No VPN connected',
    proxy ? 'A proxy is turned on in System Settings' : 'No proxy',
  ];

  let verdict, suggest = null;
  if (!connected) {
    verdict = "This Mac isn't connected to a network. Check Wi-Fi is on and joined to your network, or that the cable is plugged in.";
    suggest = n.wifi ? 'wifiRestart' : null;
  } else if (internetOk && address) {
    verdict = 'Everything works. If one website still won\'t load, flush the DNS cache.';
  } else if (internetOk) {
    verdict = "The internet works but website names don't load. Flush the DNS cache first; if that doesn't help, switch to Google + Cloudflare DNS.";
    suggest = 'flushDns';
  } else if (!routerOk) {
    verdict = "Your router doesn't answer. Renew this Mac's address, or turn Wi-Fi off and on. If that fails, restart the router.";
    suggest = 'renewIp';
  } else if (vpn) {
    verdict = `Your router answers but the internet doesn't, and the VPN "${vpn}" is connected. Disconnect it and run this again.`;
  } else {
    verdict = "Your router answers but the internet doesn't. Restart the router; if it keeps happening, contact your internet provider.";
  }
  return { checks, info, verdict, suggest };
});

ipcMain.handle('netFix', async (event, key) => {
  const n = await activeNetwork();
  const svc = n.service || n.wifi;
  const flush = 'dscacheutil -flushcache; killall -HUP mDNSResponder';
  const fail = r => ({ ok: false, output: r.cancelled ? 'Cancelled.' : (r.out || 'Failed.') });

  switch (key) {
    case 'flushDns': {
      const r = await adminShell(flush);
      return r.ok ? { ok: true, output: 'DNS cache flushed. Website names are looked up fresh from now on.' } : fail(r);
    }
    case 'googleDns': {
      if (!svc) return { ok: false, output: 'No network connection found to change.' };
      const r = await adminShell(`networksetup -setdnsservers ${shq(svc.name)} 8.8.8.8 1.1.1.1; ${flush}`);
      return r.ok ? { ok: true, output: `${svc.name} now uses Google (8.8.8.8) and Cloudflare (1.1.1.1) for website names.` } : fail(r);
    }
    case 'autoDns': {
      if (!svc) return { ok: false, output: 'No network connection found to change.' };
      const r = await adminShell(`networksetup -setdnsservers ${shq(svc.name)} Empty; ${flush}`);
      return r.ok ? { ok: true, output: `${svc.name} uses your router's DNS again.` } : fail(r);
    }
    case 'renewIp': {
      if (!svc) return { ok: false, output: 'No network connection found to renew.' };
      const r = await adminShell(`ipconfig set ${shq(svc.device)} DHCP`);
      if (!r.ok) return fail(r);
      let ip = '';
      for (let i = 0; i < 10 && !ip; i++) {
        await new Promise(res => setTimeout(res, 1000));
        ip = (await shellText(`ipconfig getifaddr ${shq(svc.device)}`, 5_000)).out;
      }
      return { ok: !!ip, output: ip ? `Asked the router for a new address. ${svc.name} now has ${ip}.` : `Asked the router for a new address, but ${svc.name} hasn't got one yet.` };
    }
    case 'wifiRestart': {
      if (!n.wifi) return { ok: false, output: "This Mac doesn't have Wi-Fi." };
      const dev = shq(n.wifi.device);
      await shellText(`networksetup -setairportpower ${dev} off`, 15_000);
      await new Promise(res => setTimeout(res, 2000));
      const on = await shellText(`networksetup -setairportpower ${dev} on`, 15_000);
      if (!on.ok) return { ok: false, output: on.out || "Couldn't turn Wi-Fi back on. Turn it on from the menu bar." };
      let ip = '';
      for (let i = 0; i < 15 && !ip; i++) {
        await new Promise(res => setTimeout(res, 1000));
        ip = (await shellText(`ipconfig getifaddr ${dev}`, 5_000)).out;
      }
      return { ok: true, output: ip ? `Wi-Fi turned off and on, and reconnected with address ${ip}.` : 'Wi-Fi turned off and on. It hasn\'t rejoined a network yet.' };
    }
    case 'resetNetwork': {
      // Moved aside, not deleted, so the old settings can be put back.
      const dir = '/Library/Preferences/SystemConfiguration';
      const r = await adminShell(
        `B=${dir}/disk-reaper-backup-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"; ` +
        `for f in preferences.plist NetworkInterfaces.plist com.apple.airport.preferences.plist; do ` +
        `[ -e "${dir}/$f" ] && mv "${dir}/$f" "$B/"; done; echo "$B"`);
      return r.ok
        ? { ok: true, output: `Network settings reset. Restart your Mac to finish.\nThe old settings are kept in ${r.out}.` }
        : fail(r);
    }
    default:
      return { ok: false, output: `Unknown fix: ${key}` };
  }
});

// ── Misc ─────────────────────────────────────────────────────────
ipcMain.on('openExternal',    (event, url)  => shell.openExternal(url));
ipcMain.on('openFolder',      (event, p)    => shell.openPath(p));
ipcMain.on('copyToClipboard', (event, text) => clipboard.writeText(text));
