const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const { limit, mode, drives, sharedState, exclude } = workerData;
const excludeSet = new Set((exclude || []).map(p => p.toLowerCase()));

function getState() {
  return Atomics.load(sharedState, 0);
}

function checkState() {
  while (getState() === 1) {
    Atomics.wait(sharedState, 0, 1, 200);
  }
  return getState() !== 2; // false = stopped
}

const folderMode = mode === "folders";
const label = folderMode ? "folders" : "files";
let scanned = 0;
let bytes = 0;
let topItems = [];
// When the running top list was last sent to the window. A whole-disk scan
// takes minutes, and a table that stays empty until the very end looks broken.
let lastPartial = Date.now();

function insertTop(size, filePath, modified) {
  if (topItems.length < limit) {
    topItems.push({ size, path: filePath, modified });
    if (topItems.length === limit) topItems.sort((a, b) => b.size - a.size);
  } else if (size > topItems[topItems.length - 1].size) {
    topItems[topItems.length - 1] = { size, path: filePath, modified };
    topItems.sort((a, b) => b.size - a.size);
  }
}

// The current top list, largest first.
function snapshot() {
  return [...topItems].sort((a, b) => b.size - a.size);
}

function report(every) {
  const timed = Date.now() - lastPartial >= 1000;
  if (scanned % every === 0 || timed) {
    // Used space isn't measured on Windows, so total stays 0 and the window
    // leaves the percentage bar hidden.
    parentPort.postMessage({ type: "progress", scanned, label, bytes, total: 0 });
  }
  // Once a second, send the largest items found so far so the list fills in
  // while the scan is still running.
  if (timed) {
    lastPartial = Date.now();
    parentPort.postMessage({ type: "partial", items: snapshot() });
  }
}

function walkFiles(dir) {
  if (!checkState()) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!checkState()) return;
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excludeSet.has(full.toLowerCase())) continue;
        walkFiles(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        bytes += stat.size;
        insertTop(stat.size, full, stat.mtimeMs);
        scanned++;
        report(3000);
      }
    } catch {}
  }
}

function walkFolders(dir) {
  if (!checkState()) return 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    if (!checkState()) return total;
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excludeSet.has(full.toLowerCase())) continue;
        total += walkFolders(full);
      } else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        total += size;
        bytes += size;
      }
    } catch {}
  }
  scanned++;
  let dirMtime;
  try { dirMtime = fs.statSync(dir).mtimeMs; } catch {}
  insertTop(total, dir, dirMtime);
  report(500);
  return total;
}

for (const drive of drives) {
  if (!checkState()) break;
  if (folderMode) walkFolders(drive);
  else walkFiles(drive);
}

parentPort.postMessage({
  type: "done",
  items: snapshot(),
  scanned,
  label,
});