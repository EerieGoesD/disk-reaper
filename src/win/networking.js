const { ipcMain } = require("electron");
const { execFile } = require("child_process");

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
  const r1 = await run("netsh", ["interface", "ip", "set", "dns", `name=${adapter}`, "static", primary]);
  const r2 = await run("netsh", ["interface", "ip", "add", "dns", `name=${adapter}`, `addr=${secondary}`, "index=2"]);
  const r3 = await run("ipconfig", ["/flushdns"]);
  return {
    ok: r1.ok && r2.ok && r3.ok,
    steps: [
      { cmd: `netsh set dns "${adapter}" ${primary}`,  ok: r1.ok, out: r1.stdout.trim(), err: r1.stderr.trim() },
      { cmd: `netsh add dns "${adapter}" ${secondary}`, ok: r2.ok, out: r2.stdout.trim(), err: r2.stderr.trim() },
      { cmd: "ipconfig /flushdns",                      ok: r3.ok, out: r3.stdout.trim(), err: r3.stderr.trim() },
    ],
  };
}

async function resetDnsAuto(adapter) {
  if (!adapter) return { ok: false, error: "No active adapter detected." };
  const r1 = await run("netsh", ["interface", "ip", "set", "dns", `name=${adapter}`, "source=dhcp"]);
  const r2 = await run("ipconfig", ["/flushdns"]);
  return {
    ok: r1.ok && r2.ok,
    steps: [
      { cmd: `netsh set dns "${adapter}" dhcp`, ok: r1.ok, out: r1.stdout.trim(), err: r1.stderr.trim() },
      { cmd: "ipconfig /flushdns",              ok: r2.ok, out: r2.stdout.trim(), err: r2.stderr.trim() },
    ],
  };
}

async function flushDns() {
  const r = await run("ipconfig", ["/flushdns"]);
  return { ok: r.ok, steps: [{ cmd: "ipconfig /flushdns", ok: r.ok, out: r.stdout.trim(), err: r.stderr.trim() }] };
}

async function renewIp() {
  const r1 = await run("ipconfig", ["/release"], 60000);
  const r2 = await run("ipconfig", ["/renew"], 90000);
  return {
    ok: r1.ok && r2.ok,
    steps: [
      { cmd: "ipconfig /release", ok: r1.ok, out: r1.stdout.trim(), err: r1.stderr.trim() },
      { cmd: "ipconfig /renew",   ok: r2.ok, out: r2.stdout.trim(), err: r2.stderr.trim() },
    ],
  };
}

async function resetWinsock() {
  const r = await run("netsh", ["winsock", "reset"]);
  return { ok: r.ok, steps: [{ cmd: "netsh winsock reset", ok: r.ok, out: r.stdout.trim(), err: r.stderr.trim() }] };
}

async function resetIpStack() {
  const r = await run("netsh", ["int", "ip", "reset"]);
  return { ok: r.ok, steps: [{ cmd: "netsh int ip reset", ok: r.ok, out: r.stdout.trim(), err: r.stderr.trim() }] };
}

ipcMain.handle("net-diagnostics",    () => runDiagnostics());
ipcMain.handle("net-get-adapters",   () => getNetworkConfig());
ipcMain.handle("net-fix-dns",        (_, { adapter, primary, secondary }) => fixDns(adapter, primary, secondary));
ipcMain.handle("net-reset-dns",      (_, { adapter }) => resetDnsAuto(adapter));
ipcMain.handle("net-flush-dns",      () => flushDns());
ipcMain.handle("net-renew-ip",       () => renewIp());
ipcMain.handle("net-reset-winsock",  () => resetWinsock());
ipcMain.handle("net-reset-ip-stack", () => resetIpStack());
