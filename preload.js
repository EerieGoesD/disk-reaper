const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  startScan: (opts) => ipcRenderer.invoke("start-scan", opts),
  stopScan: () => ipcRenderer.invoke("stop-scan"),
  pauseScan: () => ipcRenderer.invoke("pause-scan"),
  resumeScan: () => ipcRenderer.invoke("resume-scan"),
  deleteFiles: (paths) => ipcRenderer.invoke("delete-files", paths),
  showInExplorer: (path) => ipcRenderer.invoke("show-in-explorer", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  onScanProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("scan-progress", listener);
    return () => ipcRenderer.removeListener("scan-progress", listener);
  },
});
