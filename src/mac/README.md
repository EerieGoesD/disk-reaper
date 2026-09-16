# Disk Reaper for macOS

A lightweight, native-feeling macOS utility built with Electron for keeping your Mac clean and running fast. No subscriptions, no bloat.

![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Electron](https://img.shields.io/badge/electron-26-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

### Large Files
Scan any folder (or your entire disk) for large files/folders and delete if required.

### Installed Apps
Lists all apps in `/Applications` with their real on-disk size (including support files). Uninstall apps you no longer need.

### Processes
Live view of all running processes with CPU, memory, and full command info. Kill any process or its entire tree.

### Services
Browse and manage launchd agents and daemons. Start or stop background services without touching the terminal.

### Cleaner
One-click system maintenance tasks:

| Task | What it does |
|------|-------------|
| **Free Up RAM** | Purges inactive memory via `purge` (requires admin) |
| **Free Up Purgeable Space** | Trims local Time Machine snapshots |
| **Run Maintenance Tasks** | Clears user & system caches, temp files, rebuilds Launch Services DB, clears QuickLook cache, rotates logs, removes `.DS_Store` files |
| **Flush DNS Cache** | Flushes DNS resolver cache and restarts `mDNSResponder` |
| **Speed Up Mail** | Vacuums the Apple Mail SQLite database |
| **Reindex Spotlight** | Erases and rebuilds the Spotlight index |
| **Repair Disk Permissions** | Runs `fsck_apfs` verification on the startup volume |
| **Time Machine Snapshot Trimming** | Deletes all local Time Machine snapshots |

### Export
Export scan results to CSV or TXT for reference or sharing.

---

## Requirements

- macOS 12 or later (tested on macOS 15 Sequoia)
- Node.js 18+

## Releases

## Tech Stack

- [Electron](https://www.electronjs.org/) 26
- Vanilla JS / HTML / CSS (no frontend framework)
- Node.js Worker Threads for non-blocking file scanning
- macOS-native `osascript` for privileged operations

## License

MIT © EERIE
