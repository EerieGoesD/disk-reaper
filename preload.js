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
  // Processes
  getProcesses: ()    => ipcRenderer.invoke("get-processes"),
  killProcess:  (pid) => ipcRenderer.invoke("kill-process", pid),
  // Services
  getServices:     ()              => ipcRenderer.invoke("get-services"),
  controlService:  (name, action)  => ipcRenderer.invoke("control-service", { name, action }),
});