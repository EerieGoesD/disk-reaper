const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { execSync, exec } = require('child_process');
const { Worker }         = require('worker_threads');

// ── Window ───────────────────────────────────────────────────────
let mainWindow;
let scanWorker = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1200,
    height: 720,
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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Large Files ──────────────────────────────────────────────────
ipcMain.handle('startScan', (event, opts) => {
  if (scanWorker) { scanWorker.terminate(); scanWorker = null; }

  return new Promise((resolve, reject) => {
    scanWorker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
      workerData: opts,
    });

    scanWorker.on('message', msg => {
      if (msg.type === 'progress') {
        mainWindow.webContents.send('scan-progress', { scanned: msg.scanned, label: msg.label || opts.mode });
      } else if (msg.type === 'result' || msg.type === 'partial') {
        resolve({ items: msg.items, scanned: msg.scanned, label: msg.label });
        scanWorker = null;
      } else if (msg.type === 'error') {
        reject(new Error(msg.error));
        scanWorker = null;
      }
    });

    scanWorker.on('error', err => { reject(err); scanWorker = null; });
    // exit fires when the worker is terminated — resolve with empty items so
    // the renderer's await unblocks; the userStopped guard prevents rendering
    scanWorker.on('exit', () => { resolve({ items: [], scanned: 0, label: opts.mode }); scanWorker = null; });
  });
});

ipcMain.on('pauseScan',  () => scanWorker?.postMessage({ cmd: 'pause' }));
ipcMain.on('resumeScan', () => scanWorker?.postMessage({ cmd: 'resume' }));
ipcMain.on('stopScan',   () => {
  if (scanWorker) {
    scanWorker.terminate(); // hard-kill immediately — don't wait for graceful wind-down
    scanWorker = null;
  }
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

      case 'ram': {
        const r = await adminRun('purge');
        if (!r.ok) return { ok: false, output: /cancel/i.test(r.output) ? 'Cancelled.' : (r.output || 'purge failed.') };
        return { ok: true, output: r.output || 'Inactive memory purged.' };
      }

      case 'purgeable': {
        const r = await run('tmutil thinlocalsnapshots / 9999999999999 4 2>&1', 90_000);
        return { ok: true, output: r.output || 'No purgeable snapshots found.' };
      }

      case 'maintenance': {
        const home = require('os').homedir();
        const lsreg = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
        const steps = [
          `echo "Clearing user app caches..."`,
          `rm -rf "${home}/Library/Caches/"* 2>/dev/null || true`,
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

      case 'dns': {
        const r = await adminRun('dscacheutil -flushcache; killall -HUP mDNSResponder');
        if (!r.ok) return { ok: false, output: /cancel/i.test(r.output) ? 'Cancelled.' : (r.output || 'Failed.') };
        return { ok: true, output: r.output || 'DNS cache flushed.' };
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
        const r = await adminRun('mdutil -E /');
        if (!r.ok) return { ok: false, output: /cancel/i.test(r.output) ? 'Cancelled.' : (r.output || 'Failed.') };
        return { ok: true, output: (r.output || 'Spotlight index erased.') + '\nRebuilding continues in the background.' };
      }

      case 'permissions': {
        const r = await run('diskutil verifyVolume / 2>&1', 120_000);
        return { ok: true, output: r.output || 'Disk verification complete.' };
      }

      case 'timemachine': {
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

// ── Misc ─────────────────────────────────────────────────────────
ipcMain.on('openExternal',    (event, url)  => shell.openExternal(url));
ipcMain.on('openFolder',      (event, p)    => shell.openPath(p));
ipcMain.on('copyToClipboard', (event, text) => clipboard.writeText(text));
