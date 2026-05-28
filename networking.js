const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const { runElevatedBatch } = require("./run-elevated");

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || "").toString(),
        stderr: (stderr || (err && err.message) || "").toString(),
      });
    });
  });
}

function ps(oneLiner, timeout = 20000) {
  return run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", oneLiner], timeout);
}

// Convert the elevated batch result into the {cmd, ok, out, err} shape the
// renderer's networking log already expects, preserving the displayed command
// string per step.
function toSteps(batchResults, labels) {
  return batchResults.map((r, i) => ({
    cmd: labels[i],
    ok: r.ok,
    out: (r.stdout || "").trim(),
    err: r.ok ? "" : (r.error || `exit ${r.exitCode}`),
  }));
}

async function getNetworkConfig() {
  const cmd =
    "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | " +
    "ForEach-Object { [PSCustomObject]@{ " +
    "InterfaceAlias = $_.InterfaceAlias; " +
    "IPv4Address = ($_.IPv4Address | Select-Object -First 1).IPAddress; " +
    "IPv4Gateway = ($_.IPv4DefaultGateway | Select-Object -First 1).NextHop; " +
    "DnsServers = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses }) " +
    "} } | ConvertTo-Json -Depth 4 -Compress";
  const r = await ps(cmd);
  if (!r.ok) return [];
  try {
    const out = r.stdout.trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function parsePing(text) {
  const sent = /Sent\s*=\s*(\d+)/i.exec(text);
  const recv = /Received\s*=\s*(\d+)/i.exec(text);
  const loss = /\(([\d]+)%\s*loss\)/i.exec(text);
  const avg  = /Average\s*=\s*(\d+)\s*ms/i.exec(text);
  return {
    sent: sent ? +sent[1] : 0,
    received: recv ? +recv[1] : 0,
    lossPct: loss ? +loss[1] : 100,
    avgMs: avg ? +avg[1] : null,
    ok: !!(recv && +recv[1] > 0),
  };
}

async function pingHost(host, count = 4) {
  const r = await run("ping", ["-n", String(count), "-w", "2000", host], 30000);
  const stats = parsePing(r.stdout);
  return { ...stats, host, raw: r.stdout || r.stderr };
}

async function runDiagnostics() {
  const adapters = await getNetworkConfig();
  const primary = adapters[0] || null;
  const [gateway, publicIp, publicDns] = await Promise.all([
    primary && primary.IPv4Gateway ? pingHost(primary.IPv4Gateway, 3) : Promise.resolve(null),
    pingHost("8.8.8.8", 4),
    pingHost("google.com", 4),
  ]);
  return { adapters, primary, gateway, publicIp, publicDns };
}

async function fixDns(adapter, primary = "8.8.8.8", secondary = "1.1.1.1") {
  if (!adapter) return { ok: false, error: "No active adapter detected." };
  const commands = [
    { id: "set-dns",   cmd: "netsh",    args: ["interface", "ip", "set", "dns", `name=${adapter}`, "static", primary] },
    { id: "add-dns",   cmd: "netsh",    args: ["interface", "ip", "add", "dns", `name=${adapter}`, `addr=${secondary}`, "index=2"] },
    { id: "flush-dns", cmd: "ipconfig", args: ["/flushdns"] },
  ];
  const results = await runElevatedBatch(commands);
  const steps = toSteps(results, [
    `netsh set dns "${adapter}" ${primary}`,
    `netsh add dns "${adapter}" ${secondary}`,
    "ipconfig /flushdns",
  ]);
  return { ok: steps.every(s => s.ok), steps };
}

async function resetDnsAuto(adapter) {
  if (!adapter) return { ok: false, error: "No active adapter detected." };
  const commands = [
    { id: "set-dns-dhcp", cmd: "netsh",    args: ["interface", "ip", "set", "dns", `name=${adapter}`, "source=dhcp"] },
    { id: "flush-dns",    cmd: "ipconfig", args: ["/flushdns"] },
  ];
  const results = await runElevatedBatch(commands);
  const steps = toSteps(results, [
    `netsh set dns "${adapter}" dhcp`,
    "ipconfig /flushdns",
  ]);
  return { ok: steps.every(s => s.ok), steps };
}

async function flushDns() {
  // ipconfig /flushdns does NOT require admin - run unelevated.
  const r = await run("ipconfig", ["/flushdns"]);
  return { ok: r.ok, steps: [{ cmd: "ipconfig /flushdns", ok: r.ok, out: r.stdout.trim(), err: r.stderr.trim() }] };
}

async function renewIp() {
  const commands = [
    { id: "release", cmd: "ipconfig", args: ["/release"] },
    { id: "renew",   cmd: "ipconfig", args: ["/renew"] },
  ];
  const results = await runElevatedBatch(commands);
  const steps = toSteps(results, ["ipconfig /release", "ipconfig /renew"]);
  return { ok: steps.every(s => s.ok), steps };
}

async function resetWinsock() {
  const results = await runElevatedBatch([
    { id: "winsock-reset", cmd: "netsh", args: ["winsock", "reset"] },
  ]);
  const steps = toSteps(results, ["netsh winsock reset"]);
  return { ok: steps.every(s => s.ok), steps };
}

async function resetIpStack() {
  const results = await runElevatedBatch([
    { id: "ip-reset", cmd: "netsh", args: ["int", "ip", "reset"] },
  ]);
  const steps = toSteps(results, ["netsh int ip reset"]);
  return { ok: steps.every(s => s.ok), steps };
}

ipcMain.handle("net-diagnostics",    () => runDiagnostics());
ipcMain.handle("net-get-adapters",   () => getNetworkConfig());
ipcMain.handle("net-fix-dns",        (_, { adapter, primary, secondary }) => fixDns(adapter, primary, secondary));
ipcMain.handle("net-reset-dns",      (_, { adapter }) => resetDnsAuto(adapter));
ipcMain.handle("net-flush-dns",      () => flushDns());
ipcMain.handle("net-renew-ip",       () => renewIp());
ipcMain.handle("net-reset-winsock",  () => resetWinsock());
ipcMain.handle("net-reset-ip-stack", () => resetIpStack());
