# Disk Reaper

System cleanup and monitoring tool built with Electron. One repo, two platform builds.

Windows requires admin privileges. macOS prompts for your password only for tasks that need it.

## Windows

- **Large Files** - scan all drives for the biggest files and folders. Delete or reveal in Explorer.
- **Installed Apps** - list apps by disk usage. Launch uninstallers directly.
- **Processes** - view memory usage per process. Kill individual processes or entire trees.
- **Services** - browse, start, and stop Windows services.
- **Startup** - view and enable/disable startup apps (registry, startup folder, and UWP store apps).
- **System Info** - live CPU/memory monitoring, GPU, storage, motherboard, BIOS, battery, and network details.
- **Performance/Cleaner** - scan and kill known bloatware processes (HP, McAfee, Brave, Edge, IObit) with service stop and disable, plus clear temp folders and remove Windows.old.
- **Networking** - diagnostics, DNS fixes, IP renew, Winsock and IP stack reset.
- **Drivers** - list drivers and check for updates.

## macOS

- **Large Files** - scan any folder or the whole disk for large files and folders, delete what you don't need.
- **Installed Apps** - every app in `/Applications` with its real on-disk size including support files. Uninstall from the list.
- **Processes** - live CPU, memory and full command for every process. Kill one or its whole tree.
- **Services** - browse and manage launchd agents and daemons without the terminal.
- **Cleaner** - free up RAM, trim Time Machine snapshots, clear caches and temp files, rebuild the Launch Services and QuickLook databases, flush DNS, compact the Apple Mail database, reindex Spotlight, verify the startup volume.

Both platforms export any panel to CSV or TXT.

## Layout

```
main.js          loads the platform main process
src/win/         Windows main, preload, renderer and PowerShell scripts
src/mac/         macOS main, preload, renderer and scan worker
build/           icons and Microsoft Store assets
```

The two platforms share no IPC channels or UI - each has its own renderer and preload. `main.js` picks one at startup.

## Building

```
npm install
npm start          run on the current platform
npm run dist:win   NSIS installer + APPX (run on Windows)
npm run dist:mac   DMG + ZIP, arm64 and x64 (run on macOS)
```

## Requirements

- Windows 10/11, or macOS 12 or later
- Node.js 18+

---

Made by [EERIE](https://eeriegoesd.com) | [Support This Project](https://buymeacoffee.com/eeriegoesd) | [Report Issue](https://github.com/EerieGoesD/disk-reaper/issues/new?template=bug-report.md) | [Feedback](https://github.com/EerieGoesD/disk-reaper/discussions) | [Feature Request](https://github.com/EerieGoesD/disk-reaper/issues/new?template=feature-request.md)
