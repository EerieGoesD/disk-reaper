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
  getFolderInfo:       (key)   => ipcRenderer.invoke("get-folder-info", key),
  clearTempFolder:     (key)   => ipcRenderer.invoke("clear-temp-folder", key),
  deleteWindowsOld:    ()      => ipcRenderer.invoke("delete-windows-old"),
  getServiceInfo:      (name)  => ipcRenderer.invoke("get-service-info", name),
  setServiceState:     (name, action) => ipcRenderer.invoke("set-service-state", { name, action }),
  getDeliveryOptState: ()      => ipcRenderer.invoke("get-delivery-opt-state"),
  setDeliveryOptP2P:   (disable) => ipcRenderer.invoke("set-delivery-opt-p2p", { disable }),
  runPerfCommand:      (key)   => ipcRenderer.invoke("run-perf-command", key),
  onPerfCmdOutput:     (cb)    => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("perf-cmd-output", listener);
    return () => ipcRenderer.removeListener("perf-cmd-output", listener);
  },
  applyBestPerfVisuals:    () => ipcRenderer.invoke("apply-best-perf-visuals"),
  applyBootTweaks:         () => ipcRenderer.invoke("apply-boot-tweaks"),
  setHighPerfPowerPlan:    () => ipcRenderer.invoke("set-high-perf-power-plan"),
  optimizeSystemDrive:     () => ipcRenderer.invoke("optimize-system-drive"),
  launchDiskCleanup:       () => ipcRenderer.invoke("launch-disk-cleanup"),
  getGamingTweakState:     (key)         => ipcRenderer.invoke("get-gaming-tweak-state", key),
  setGamingTweak:          (key, disable) => ipcRenderer.invoke("set-gaming-tweak", { key, disable }),
  getCoreParkingState:     ()            => ipcRenderer.invoke("get-core-parking-state"),
  setCoreParkingState:     (disable)     => ipcRenderer.invoke("set-core-parking-state", { disable }),
  getWinKeyState:          ()            => ipcRenderer.invoke("get-winkey-state"),
  setWinKeyState:          (disable)     => ipcRenderer.invoke("set-winkey-state", { disable }),
  clearClipboardHistory:   ()            => ipcRenderer.invoke("clear-clipboard-history"),
  get8dot3State:           ()            => ipcRenderer.invoke("get-8dot3-state"),
  set8dot3State:           (disable)     => ipcRenderer.invoke("set-8dot3-state", { disable }),
  getAutochkState:         ()            => ipcRenderer.invoke("get-autochk-state"),
  setAutochkState:         (disable)     => ipcRenderer.invoke("set-autochk-state", { disable }),
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
  // Drivers
  listDrivers:               () => ipcRenderer.invoke("list-drivers"),
  checkDriverUpdates:        () => ipcRenderer.invoke("check-driver-updates"),
  enableMicrosoftUpdate:     () => ipcRenderer.invoke("enable-microsoft-update"),
  getUpdateServicesStatus:   () => ipcRenderer.invoke("get-update-services-status"),
  // Debloat: privacy tweaks (HKCU only)
  getPrivacyTweakState:      (key)               => ipcRenderer.invoke("get-privacy-tweak-state", key),
  setPrivacyTweak:           (key, disable)      => ipcRenderer.invoke("set-privacy-tweak", { key, disable }),
  getAllDebloatStates:       ()                  => ipcRenderer.invoke("get-all-debloat-states"),
  // Debloat: taskbar/explorer tweaks (HKCU only)
  getExplorerTweakState:     (key)               => ipcRenderer.invoke("get-explorer-tweak-state", key),
  setExplorerTweak:          (key, disable)      => ipcRenderer.invoke("set-explorer-tweak", { key, disable }),
  restartExplorer:           ()                  => ipcRenderer.invoke("restart-explorer"),
  // Debloat: System Restore Point (create only)
  createRestorePoint:        (desc)              => ipcRenderer.invoke("create-restore-point", desc),
  // Debloat: hibernation
  getHibernationState:       ()                  => ipcRenderer.invoke("get-hibernation-state"),
  setHibernationState:       (disable)           => ipcRenderer.invoke("set-hibernation-state", { disable }),
  // Debloat: background apps
  getBackgroundAppsState:    ()                  => ipcRenderer.invoke("get-bgapps-state"),
  setBackgroundAppsState:    (disable)           => ipcRenderer.invoke("set-bgapps-state", { disable }),
});