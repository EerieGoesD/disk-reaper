const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Large Files ──────────────────────────────────────────────
  startScan:       (opts) => ipcRenderer.invoke('startScan', opts),
  pauseScan:       ()     => ipcRenderer.send('pauseScan'),
  resumeScan:      ()     => ipcRenderer.send('resumeScan'),
  stopScan:        ()     => ipcRenderer.send('stopScan'),
  onScanProgress:  (cb)   => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('scan-progress', h);
    return () => ipcRenderer.removeListener('scan-progress', h);
  },
  onScanPartial:   (cb)   => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('scan-partial', h);
    return () => ipcRenderer.removeListener('scan-partial', h);
  },
  pickFolder:      ()     => ipcRenderer.invoke('pickFolder'),

  // ── File operations ──────────────────────────────────────────
  deleteFiles:   (paths) => ipcRenderer.invoke('deleteFiles', paths),
  showInFinder:  (path)  => ipcRenderer.send('showInFinder', path),

  // ── Installed Apps ───────────────────────────────────────────
  getInstalledApps: () => ipcRenderer.invoke('getInstalledApps'),
  startSizeCalc:    (jobs) => ipcRenderer.invoke('startSizeCalc', jobs),
  stopSizeCalc:     ()     => ipcRenderer.send('stopSizeCalc'),
  onAppSizeUpdate:  (cb)   => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('app-size-update', h);
    return () => ipcRenderer.removeListener('app-size-update', h);
  },
  uninstallApp: (bundlePath) => ipcRenderer.invoke('uninstallApp', bundlePath),

  // ── Processes ────────────────────────────────────────────────
  getProcesses: () => ipcRenderer.invoke('getProcesses'),
  killProcess:  (opts) => ipcRenderer.invoke('killProcess', opts),

  // ── Services (launchd) ───────────────────────────────────────
  getServices:  () => ipcRenderer.invoke('getServices'),
  startService: (opts) => ipcRenderer.invoke('startService', opts),
  stopService:  (opts) => ipcRenderer.invoke('stopService', opts),

  // ── Export ───────────────────────────────────────────────────
  exportData: (opts) => ipcRenderer.invoke('exportData', opts),

  // ── Cleaner ──────────────────────────────────────────────────
  runCleanerTask: (taskId) => ipcRenderer.invoke('runCleanerTask', taskId),
  findAppLeftovers: () => ipcRenderer.invoke('findAppLeftovers'),

  // ── App usage ────────────────────────────────────────────────
  appVersion: () => ipcRenderer.invoke('appVersion'),
  cacheSize:  () => ipcRenderer.invoke('cacheSize'),
  // Returns [cpu, ram] as "0.3%" strings, or "n/a" when a reading fails. The
  // main process reports its own footprint; this process adds the window's.
  usage: async () => {
    const [u, mine] = await Promise.all([
      ipcRenderer.invoke('usage'),
      process.getProcessMemoryInfo().catch(() => null),
    ]);
    const cpu = typeof u.cpu === 'number' ? u.cpu.toFixed(1) + '%' : 'n/a';
    const ram = u.footprintKB != null && mine && u.totalKB > 0
      ? ((u.footprintKB + mine.private) / u.totalKB * 100).toFixed(1) + '%'
      : 'n/a';
    return [cpu, ram];
  },

  // ── Misc ─────────────────────────────────────────────────────
  openExternal:    (url)  => ipcRenderer.send('openExternal', url),
  openFolder:      (path) => ipcRenderer.send('openFolder', path),
  copyToClipboard: (text) => ipcRenderer.send('copyToClipboard', text),
});
