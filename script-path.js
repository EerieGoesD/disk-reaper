const path = require("path");

function scriptPath(name) {
  return path
    .join(__dirname, "scripts", name)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { scriptPath };
