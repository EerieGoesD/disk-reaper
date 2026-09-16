const { ipcMain, dialog } = require("electron");
const { writeFileSync } = require("fs");

ipcMain.handle("export-data", async (event, { format, filename, headers, rows }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Export Data",
    defaultPath: filename,
    filters: format === "csv"
      ? [{ name: "CSV Files", extensions: ["csv"] }]
      : [{ name: "Text Files", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    let content;
    if (format === "csv") {
      const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      content = [headers.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))].join("\r\n");
    } else {
      const widths = headers.map((h, i) =>
        Math.max(String(h).length, ...rows.map(r => String(r[i] ?? "").length)));
      const pad = (v, w) => String(v ?? "").padEnd(w);
      content = [
        headers.map((h, i) => pad(h, widths[i])).join("  "),
        widths.map(w => "-".repeat(w)).join("  "),
        ...rows.map(r => r.map((v, i) => pad(v, widths[i])).join("  "))
      ].join("\r\n");
    }
    writeFileSync(filePath, "\uFEFF" + content, "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});