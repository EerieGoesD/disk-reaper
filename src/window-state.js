// Remembers the main window's size, position and maximized state between
// launches. Shared by the Windows and macOS main processes.
const { app, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
const isNum = n => Number.isFinite(n);

// The saved bounds, or the defaults on a first run. A saved position is only
// used when it lands on a screen that is plugged in now, so the window never
// opens off-screen.
function load(defaults) {
  let s;
  try { s = JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return { ...defaults }; }
  if (!s || !isNum(s.width) || !isNum(s.height)) return { ...defaults };
  const state = { width: Math.round(s.width), height: Math.round(s.height), maximized: !!s.maximized };
  if (isNum(s.x) && isNum(s.y)) {
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x + 80 <= a.x + a.width && s.x + s.width - 80 >= a.x &&
      s.y >= a.y - 20 && s.y + 40 <= a.y + a.height);
    if (onScreen) { state.x = Math.round(s.x); state.y = Math.round(s.y); }
  }
  return state;
}

function save(win) {
  if (win.isDestroyed()) return;
  // Normal bounds, so a maximized or full-screen window restores to the size
  // it had before.
  const b = win.getNormalBounds();
  const data = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  try { fs.writeFileSync(stateFile(), JSON.stringify(data)); } catch {}
}

function track(win) {
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => save(win), 500); };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, later);
  win.on("close", () => { clearTimeout(timer); save(win); });
}

module.exports = { load, track };
