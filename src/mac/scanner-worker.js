/**
 * scanner-worker.js — runs in a Worker thread
 * Finds the largest files or folders under the chosen roots.
 *
 * Same walk as Size Scanner: whole system means "/", restricted to the startup
 * disk's own volumes, hardlinks counted once, and the running top list sent to
 * the window once a second so the table fills in while the scan runs.
 */
const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const limit    = Math.max(0, parseInt(workerData.limit) || 0);
const mode     = workerData.mode === 'folders' ? 'folders' : 'files';
const label    = mode;
const exclude  = new Set((workerData.exclude || []).map(p => String(p).toLowerCase()));
const DATA_VOL = '/System/Volumes/Data';

let stopped = false;
let paused  = false;

parentPort.on('message', msg => {
  if (msg.cmd === 'stop')   stopped = true;
  if (msg.cmd === 'pause')  paused  = true;
  if (msg.cmd === 'resume') paused  = false;
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick  = () => new Promise(r => setImmediate(r));

// ── Top-N ────────────────────────────────────────────────────────
// Min-heap on size (then path), so the smallest of the current top list sits
// at the root and is the one evicted when something bigger turns up.
const heap = [];
const less = (a, b) => a.size < b.size || (a.size === b.size && a.path < b.path);

function heapPush(item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(heap[i], heap[p])) break;
    [heap[i], heap[p]] = [heap[p], heap[i]];
    i = p;
  }
}

function heapReplaceRoot(item) {
  heap[0] = item;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1, r = l + 1;
    let m = i;
    if (l < heap.length && less(heap[l], heap[m])) m = l;
    if (r < heap.length && less(heap[r], heap[m])) m = r;
    if (m === i) break;
    [heap[i], heap[m]] = [heap[m], heap[i]];
    i = m;
  }
}

function maybeInsert(size, p, modified) {
  if (limit === 0) return;
  if (heap.length < limit) heapPush({ size, path: p, modified });
  else if (size > heap[0].size) heapReplaceRoot({ size, path: p, modified });
}

function snapshot() {
  return heap.map(h => ({ size: h.size, path: h.path, modified: h.modified }))
             .sort((a, b) => b.size - a.size);
}

// ── Walk state ───────────────────────────────────────────────────
let scanned     = 0;
let bytes       = 0;
let total       = 0;
let lastPartial = Date.now();
let lastYield   = Date.now();
const allowedDevs = new Set();
const seenLinks   = new Set();

// Yields to the event loop every 50ms so pause and stop messages get through,
// then blocks while paused. Returns false once a stop is requested.
async function check() {
  if (Date.now() - lastYield >= 50) {
    lastYield = Date.now();
    await tick();
  }
  while (paused && !stopped) await sleep(150);
  return !stopped;
}

function report(every) {
  const timed = Date.now() - lastPartial >= 1000;
  if (scanned % every === 0 || timed) {
    parentPort.postMessage({ type: 'progress', scanned, label, bytes, total });
  }
  // Once a second, send the largest items found so far so the list fills in
  // while the scan is still running.
  if (timed) {
    lastPartial = Date.now();
    parentPort.postMessage({ type: 'partial', items: snapshot() });
  }
}

const isExcluded = p => exclude.size > 0 && exclude.has(p.toLowerCase());

// The writable Data volume shows up both at the firmlinked top-level paths
// (/Users, /Applications, ...) and at /System/Volumes/Data, so walking both
// would count everything twice.
const isVolumeDuplicate = p => p === DATA_VOL;

// Mounted disk images (iOS simulator runtimes, DMGs) and helper volumes like
// Preboot are not space the user is measuring from here.
const isForeignVolume = st => allowedDevs.size > 0 && !allowedDevs.has(st.dev);

// Files with more than one name on disk are counted once.
function countOnce(st) {
  if (st.nlink < 2) return true;
  const key = st.dev + ':' + st.ino;
  if (seenLinks.has(key)) return false;
  seenLinks.add(key);
  return true;
}

function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return null; }
}

function lstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// Largest-files mode: every file competes for the top list by its own size.
async function walkFiles(dir) {
  if (!await check()) return false;
  const names = readDir(dir);
  if (!names) return true;
  for (const name of names) {
    if (!await check()) return false;
    const full = path.join(dir, name);
    const st = lstat(full);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (isExcluded(full) || isVolumeDuplicate(full) || isForeignVolume(st)) continue;
      if (!await walkFiles(full)) return false;
    } else if (st.isFile()) {
      if (!countOnce(st)) continue;
      bytes += st.size;
      maybeInsert(st.size, full, st.mtimeMs ? Math.round(st.mtimeMs) : null);
      scanned++;
      report(3000);
    }
  }
  return true;
}

// Largest-folders mode: each folder competes by its total size, everything
// inside it included. Returns [total bytes, keep going].
async function walkFolders(dir, dirModified) {
  if (!await check()) return [0, false];
  const names = readDir(dir);
  if (!names) return [0, true];
  let sum = 0;
  for (const name of names) {
    if (!await check()) return [sum, false];
    const full = path.join(dir, name);
    const st = lstat(full);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (isExcluded(full) || isVolumeDuplicate(full) || isForeignVolume(st)) continue;
      const [sub, keepGoing] = await walkFolders(full, st.mtimeMs ? Math.round(st.mtimeMs) : null);
      sum += sub;
      if (!keepGoing) return [sum, false];
    } else if (st.isFile() && countOnce(st)) {
      sum   += st.size;
      bytes += st.size;
    }
  }
  scanned++;
  maybeInsert(sum, dir, dirModified);
  report(500);
  return [sum, true];
}

// Space in use on the disk holding this path, or 0 if it can't be read.
function usedBytes(p) {
  try {
    const s = fs.statfsSync(p);
    return Math.max(0, s.blocks - s.bfree) * s.bsize;
  } catch { return 0; }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const root  = typeof workerData.root === 'string' && workerData.root.trim() ? workerData.root : null;
  const roots = root ? [root] : ['/'];

  // The filesystems this scan is allowed on: whichever ones the roots live on.
  // A scan of "/" also has to reach the writable Data volume, which is a
  // separate filesystem surfaced under /Users and friends.
  for (const r of roots) {
    const st = lstat(r);
    if (st) allowedDevs.add(st.dev);
  }
  const rootSt = lstat('/'), dataSt = lstat(DATA_VOL);
  if (rootSt && dataSt && allowedDevs.has(rootSt.dev)) allowedDevs.add(dataSt.dev);

  // Used space on the disks this scan covers, one figure per disk. The bar is
  // bytes counted so far against this.
  const seenDevs = new Set();
  for (const p of [...roots, DATA_VOL]) {
    const st = lstat(p);
    if (!st || !allowedDevs.has(st.dev) || seenDevs.has(st.dev)) continue;
    seenDevs.add(st.dev);
    total += usedBytes(p);
  }

  for (const r of roots) {
    if (stopped) break;
    if (mode === 'folders') {
      const st = lstat(r);
      await walkFolders(r, st && st.mtimeMs ? Math.round(st.mtimeMs) : null);
    } else if (!await walkFiles(r)) {
      break;
    }
  }

  parentPort.postMessage({ type: 'result', items: snapshot(), scanned, label });
}

main().catch(err => {
  parentPort.postMessage({ type: 'error', error: err.message });
});
