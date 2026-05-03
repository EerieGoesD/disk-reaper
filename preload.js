const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Large Files
  startScan:     (opts) => ipcRenderer.invoke("start-scan", opts),
  stopScan:      ()     => ipcRenderer.invoke("stop-scan"),
  pauseScan:     ()     => ipcRenderer.invoke("pause-scan"),
  resumeScan:    ()     => ipcRenderer.invoke("resume-scan"),
  deleteFiles:   (paths)        => ipcRenderer.invoke("delete-files", paths),
  showInExplorer:(path)         => ipcRenderer.invoke("show-in-explorer", path),
  openExternal:  (url)          => ipcRenderer.invoke("open-external", url),
  onScanProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("scan-progress", listener);
    return () => ipcRenderer.removeListener("scan-progress", listener);
  },
  // Installed Apps
  exportData: (opts) => ipcRenderer.invoke("export-data", opts),
  getInstalledApps:  ()     => ipcRenderer.invoke("get-installed-apps"),
  uninstallApp:      (str)  => ipcRenderer.invoke("uninstall-app", str),
  startSizeCalc:     (jobs) => ipcRenderer.invoke("start-size-calc", jobs),
  stopSizeCalc:      ()     => ipcRenderer.invoke("stop-size-calc"),
  debugLocate: () => ipcRenderer.invoke("debug-locate"),
  onAppSizeUpdate:   (cb)   => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("app-size-update", listener);
    return () => ipcRenderer.removeListener("app-size-update", listener);
  },
  // System Info
  getSysInfo:   () => ipcRenderer.invoke("get-sysinfo"),
  getLiveStats: () => ipcRenderer.invoke("get-live-stats"),
  // Startup
  getStartupItems:   ()     => ipcRenderer.invoke("get-startup-items"),
  setStartupEnabled: (opts) => ipcRenderer.invoke("set-startup-enabled", opts),
  // Processes
  getProcesses: ()    => ipcRenderer.invoke("get-processes"),
  killProcess:  (pid) => ipcRenderer.invoke("kill-process", pid),
  // Cleaner
  getBloatwareList:    ()      => ipcRenderer.invoke("get-bloatware-list"),
  killBloatware:       (pids)  => ipcRenderer.invoke("kill-bloatware", pids),
  stopDisableServices: (names) => ipcRenderer.invoke("stop-disable-services", names),
  // Services
  getServices:     ()              => ipcRenderer.invoke("get-services"),
  controlService:  (name, action)  => ipcRenderer.invoke("control-service", { name, action }),
  // Networking
  netDiagnostics:   ()         => ipcRenderer.invoke("net-diagnostics"),
  netGetAdapters:   ()         => ipcRenderer.invoke("net-get-adapters"),
  netFixDns:        (opts)     => ipcRenderer.invoke("net-fix-dns", opts),
  netResetDns:      (opts)     => ipcRenderer.invoke("net-reset-dns", opts),
  netFlushDns:      ()         => ipcRenderer.invoke("net-flush-dns"),
  netRenewIp:       ()         => ipcRenderer.invoke("net-renew-ip"),
  netResetWinsock:  ()         => ipcRenderer.invoke("net-reset-winsock"),
  netResetIpStack:  ()         => ipcRenderer.invoke("net-reset-ip-stack"),
});