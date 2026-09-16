// Disk Reaper — platform entry point.
//
// Windows and macOS each have their own main process, preload and renderer
// under src/. They share no IPC channels or UI, so this file just loads the
// right one for the platform the app is running on.

if (process.platform === "darwin") {
  require("./src/mac/main.js");
} else {
  require("./src/win/main.js");
}
