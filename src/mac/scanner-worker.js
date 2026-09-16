/**
 * scanner-worker.js — runs in a Worker thread
 * Scans the filesystem for the largest files or folders.
 */
const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os   = require('os');

const { limit, mode } = workerData;

let stopped = false;
let paused  = false;
let scanned = 0;

// Top-N max-heap (sorted descending by size, trimmed to limit * 3)
const heap = [];

parentPort.on('message', msg => {
  if (msg.cmd === 'stop')   stopped = true;
  if (msg.cmd === 'pause')  paused  = true;
  if (msg.cmd === 'resume') paused  = false;
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addItem(item) {
  heap.push(item);
  if (heap.length > limit * 3) {
    heap.sort((a, b) => b.size - a.size);
    heap.splice(limit * 2);
  }
}

function getTop(n) {
  heap.sort((a, b) => b.size - a.size);
  return heap.slice(0, n);
}

// Directories to skip entirely
const SKIP = new Set([
  '/dev', '/proc', '/sys',
  '/private/var/vm', '/private/var/folders',
  '/System/Volumes/VM', '/System/Volumes/Preboot',
  '/System/Volumes/Recovery', '/System/Volumes/Update',
  'node_modules', '.git',
]);

function shouldSkip(p) {
  if (SKIP.has(p)) return true;
  const base = path.basename(p);
  // Skip macOS special dirs at root level
  if (p.split('/').length === 2 && base.startsWith('.')) return true;
  return false;
}

// ── FILES MODE ───────────────────────────────────────────────────
async function scanFiles(dir, depth = 0) {
  if (stopped) return;
  while (paused) await sleep(100);
  if (shouldSkip(dir)) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (stopped) return;
    while (paused) await sleep(100);

    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      await scanFiles(full, depth + 1);
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        scanned++;
        if (scanned % 750 === 0) {
          parentPort.postMessage({ type: 'progress', scanned });
          await sleep(0); // yield to event loop
        }
        addItem({ path: full, size: st.size });
      } catch { /* permission denied, skip */ }
    }
  }
}

// ── FOLDERS MODE — use `du -sk` on each sub-directory ────────────
async function scanFolders(root) {
  if (stopped) return;
  while (paused) await sleep(100);
  if (shouldSkip(root)) return;

  // Use du -d 4 to get all subdirectories up to 4 levels deep quickly
  try {
    const output = execSync(
      `du -sk "${root.replace(/"/g, '\\"')}"/* 2>/dev/null`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 120_000 }
    ).toString();

    for (const line of output.split('\n')) {
      if (stopped) break;
      while (paused) await sleep(100);
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const kb   = parseInt(line.slice(0, tab));
      const fpath = line.slice(tab + 1).trim();
      if (!fpath || isNaN(kb)) continue;
      scanned++;
      if (scanned % 100 === 0) {
        parentPort.postMessage({ type: 'progress', scanned });
        await sleep(0);
      }
      addItem({ path: fpath, size: kb * 1024 });
    }
  } catch { /* root may not exist or no children */ }
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  const label = mode === 'folders' ? 'folders' : 'files';

  // Determine what to scan
  const scanRoots = [
    '/Users',
    '/Applications',
    '/Library',
    '/opt',
    '/usr/local',
  ];

  // Add external / additional volumes
  try {
    const vols = fs.readdirSync('/Volumes', { withFileTypes: true });
    for (const v of vols) {
      if (v.isDirectory() || v.isSymbolicLink()) {
        const vp = '/Volumes/' + v.name;
        if (!scanRoots.includes(vp)) scanRoots.push(vp);
      }
    }
  } catch { /* no /Volumes */ }

  for (const root of scanRoots) {
    if (stopped) break;
    if (mode === 'files') {
      await scanFiles(root);
    } else {
      await scanFolders(root);
    }
  }

  parentPort.postMessage({
    type: stopped ? 'partial' : 'result',
    items: getTop(limit),
    scanned,
    label,
  });
}

main().catch(err => {
  parentPort.postMessage({ type: 'error', error: err.message });
});
