const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const { limit, mode, drives, sharedState } = workerData;

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
let scanned = 0;
let topItems = [];

function insertTop(size, filePath) {
  if (topItems.length < limit) {
    topItems.push({ size, path: filePath });
    if (topItems.length === limit) topItems.sort((a, b) => b.size - a.size);
  } else if (size > topItems[topItems.length - 1].size) {
    topItems[topItems.length - 1] = { size, path: filePath };
    topItems.sort((a, b) => b.size - a.size);
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
        walkFiles(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        insertTop(stat.size, full);
        scanned++;
        if (scanned % 3000 === 0) {
          parentPort.postMessage({ type: "progress", scanned, label: "files" });
        }
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
        total += walkFolders(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {}
  }
  scanned++;
  insertTop(total, dir);
  if (scanned % 500 === 0) {
    parentPort.postMessage({ type: "progress", scanned, label: "folders" });
  }
  return total;
}

for (const drive of drives) {
  if (!checkState()) break;
  if (folderMode) walkFolders(drive);
  else walkFiles(drive);
}

parentPort.postMessage({
  type: "done",
  items: topItems,
  scanned,
  label: folderMode ? "folders" : "files",
});