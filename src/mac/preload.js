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

  // ── Misc ─────────────────────────────────────────────────────
  openExternal:    (url)  => ipcRenderer.send('openExternal', url),
  openFolder:      (path) => ipcRenderer.send('openFolder', path),
  copyToClipboard: (text) => ipcRenderer.send('copyToClipboard', text),
});
