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

// Actual name resolution test (separate from ping). Tells us WHY DNS looks
// broken: whether the name resolves at all, which server answered, and how
// long it took. Distinguishes a real resolver failure from ICMP just being
// blocked (name resolves fine but ping google.com gets no reply).
async function resolveDns(host) {
  const cmd =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$sw = [System.Diagnostics.Stopwatch]::StartNew();" +
    "try {" +
    "  $r = Resolve-DnsName -Name '" + host + "' -Type A -ErrorAction Stop;" +
    "  $sw.Stop();" +
    "  $ips = @($r | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress });" +
    "  $srv = [string](($r | Where-Object { $_.Server } | Select-Object -First 1 -ExpandProperty Server));" +
    "  [PSCustomObject]@{ ok = ($ips.Count -gt 0); ips = $ips; server = $srv; ms = [int]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress" +
    "} catch {" +
    "  $sw.Stop();" +
    "  [PSCustomObject]@{ ok = $false; ips = @(); server = ''; ms = [int]$sw.ElapsedMilliseconds; error = $_.Exception.Message } | ConvertTo-Json -Compress" +
    "}";
  const r = await ps(cmd);
  try {
    const d = JSON.parse((r.stdout || "").trim() || "{}");
    let ips = d.ips || [];
    if (!Array.isArray(ips)) ips = [ips];
    const server = (d.server && typeof d.server === "object")
      ? (d.server.Address || d.server.IPAddressToString || "")
      : (d.server || "");
    return { ok: !!d.ok, ips, server: String(server), ms: d.ms ?? null, error: d.error || "", host };
  } catch {
    return { ok: false, ips: [], server: "", ms: null, error: (r.stderr || "lookup failed").trim(), host };
  }
}

// Ping alone is not proof: many networks and VPNs block ping while normal
// traffic works fine. This opens a real connection to check.
// Also reports anything that commonly sits in the way: a VPN tunnel, a proxy,
// or a firewall set to block outgoing traffic.
const NET_EXTRA_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "function Test-Tcp([string]$h,[int]$p,[int]$ms=4000){",
  "  $c=New-Object System.Net.Sockets.TcpClient;",
  "  try{ $ar=$c.BeginConnect($h,$p,$null,$null); $ok=$ar.AsyncWaitHandle.WaitOne($ms,$false);",
  "       if($ok){ $c.EndConnect($ar); return $true } else { return $false } }",
  "  catch { return $false } finally { $c.Close() } }",
  "$tcp = @(",
  "  [PSCustomObject]@{ target='1.1.1.1:443'; ok=(Test-Tcp '1.1.1.1' 443) },",
  "  [PSCustomObject]@{ target='8.8.8.8:53';  ok=(Test-Tcp '8.8.8.8' 53) } );",
  "$vpnAdapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'VPN|TAP-|Tunnel|WireGuard|NordLynx|OpenVPN|Zscaler|AnyConnect|GlobalProtect|Netskope|Proton|Mullvad|WinTun') } | ForEach-Object { $_.Name });",
  "$vpnServices = @(Get-Service | Where-Object { $_.Status -eq 'Running' -and ($_.Name -match 'nordvpn|openvpn|wireguard|expressvpn|protonvpn|surfshark|mullvad|cisco|anyconnect|zscaler|forticlient|globalprotect|pulse|netskope') } | ForEach-Object { $_.Name });",
  "$is = Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings';",
  "$fw = @(Get-NetFirewallProfile | Where-Object { $_.Enabled -and $_.DefaultOutboundAction -eq 'Block' } | ForEach-Object { $_.Name });",
  "[PSCustomObject]@{ tcp=$tcp; vpnAdapters=$vpnAdapters; vpnServices=$vpnServices;",
  "  proxyEnabled=[bool]($is.ProxyEnable -eq 1); proxyServer=[string]$is.ProxyServer;",
  "  autoConfigUrl=[string]$is.AutoConfigURL; firewallBlockingOutbound=$fw } | ConvertTo-Json -Compress -Depth 4",
].join(" ");

async function getExtraChecks() {
  const r = await ps(NET_EXTRA_PS, 30000);
  const empty = {
    tcp: [], tcpOk: false, vpnAdapters: [], vpnServices: [],
    proxyEnabled: false, proxyServer: "", autoConfigUrl: "", firewallBlockingOutbound: [],
  };
  try {
    const d = JSON.parse((r.stdout || "").trim() || "{}");
    const arr = (v) => (Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]));
    const tcp = arr(d.tcp).map(t => ({ target: String(t.target || ""), ok: !!t.ok }));
    return {
      tcp,
      tcpOk: tcp.some(t => t.ok),
      vpnAdapters: arr(d.vpnAdapters).map(String),
      vpnServices: arr(d.vpnServices).map(String),
      proxyEnabled: !!d.proxyEnabled,
      proxyServer: String(d.proxyServer || ""),
      autoConfigUrl: String(d.autoConfigUrl || ""),
      firewallBlockingOutbound: arr(d.firewallBlockingOutbound).map(String),
    };
  } catch {
    return empty;
  }
}

// Traceroute: shows exactly where traffic stops - at the router, at the first
// hop inside the provider's network, or further out.
async function traceRoute(host, maxHops = 8) {
  const r = await run("tracert", ["-d", "-h", String(maxHops), "-w", "800", host], 60000);
  const hops = [];
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2].trim();
    const ipm = /(\d+\.\d+\.\d+\.\d+)\s*$/.exec(rest);
    hops.push({
      hop: +m[1],
      ip: ipm ? ipm[1] : "",
      timedOut: !ipm,
      text: rest.replace(/\s+/g, " "),
    });
  }
  const reached = hops.some(h => h.ip === host);
  const lastReplying = [...hops].reverse().find(h => h.ip);
  return {
    host,
    hops,
    reached,
    maxHops,
    // Stopped only because it ran out of hops, not because traffic died.
    hitHopLimit: !reached && hops.length >= maxHops,
    lastReplyingHop: lastReplying ? lastReplying.hop : 0,
    lastReplyingIp: lastReplying ? lastReplying.ip : "",
  };
}

// Default routes (a stale route on a virtual or VPN adapter sends traffic into
// a dead end), whether the router itself really answers, and any leftover VPN
// kill-switch block rules.
const NET_DEEP_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "function Test-Tcp([string]$h,[int]$p,[int]$ms=3000){",
  "  $c=New-Object System.Net.Sockets.TcpClient;",
  "  try{ $ar=$c.BeginConnect($h,$p,$null,$null); $ok=$ar.AsyncWaitHandle.WaitOne($ms,$false);",
  "       if($ok){ $c.EndConnect($ar); return $true } else { return $false } }",
  "  catch { return $false } finally { $c.Close() } }",
  "$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object InterfaceMetric | Select-Object -First 1).NextHop;",
  "$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object {",
  "  [PSCustomObject]@{ iface=$_.InterfaceAlias; nextHop=$_.NextHop; metric=[int]$_.RouteMetric; ifMetric=[int]$_.InterfaceMetric } });",
  "$routerHttp = $false; $routerHttps = $false; $routerDns = $false;",
  "if ($gw) { $routerHttp = Test-Tcp $gw 80; $routerHttps = Test-Tcp $gw 443;",
  "  $r = Resolve-DnsName -Name 'google.com' -Server $gw -Type A -QuickTimeout;",
  "  $routerDns = [bool]($r | Where-Object { $_.IPAddress }) };",
  "$vpnFilters = @(Get-NetFirewallRule -Enabled True -Action Block |",
  "  Where-Object { $_.DisplayName -match 'nord|vpn|kill' } | Select-Object -First 6 |",
  "  ForEach-Object { \"$($_.DisplayName) [$($_.Direction)]\" });",
  "[PSCustomObject]@{ gateway=$gw; routes=$routes; routerHttp=$routerHttp; routerHttps=$routerHttps;",
  "  routerDns=$routerDns; vpnBlockRules=$vpnFilters } | ConvertTo-Json -Compress -Depth 4",
].join(" ");

async function getDeepChecks() {
  const r = await ps(NET_DEEP_PS, 40000);
  const empty = { gateway: "", routes: [], routerHttp: false, routerHttps: false, routerDns: false, vpnBlockRules: [] };
  try {
    const d = JSON.parse((r.stdout || "").trim() || "{}");
    const arr = (v) => (Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]));
    return {
      gateway: String(d.gateway || ""),
      routes: arr(d.routes).map(x => ({
        iface: String(x.iface || ""), nextHop: String(x.nextHop || ""),
        metric: Number(x.metric) || 0, ifMetric: Number(x.ifMetric) || 0,
      })),
      routerHttp: !!d.routerHttp,
      routerHttps: !!d.routerHttps,
      routerDns: !!d.routerDns,
      vpnBlockRules: arr(d.vpnBlockRules).map(String),
    };
  } catch { return empty; }
}

async function runDiagnostics() {
  const adapters = await getNetworkConfig();
  const primary = adapters[0] || null;
  const [gateway, publicIp, publicDns, dnsResolve, extra] = await Promise.all([
    primary && primary.IPv4Gateway ? pingHost(primary.IPv4Gateway, 3) : Promise.resolve(null),
    pingHost("8.8.8.8", 4),
    pingHost("google.com", 4),
    resolveDns("google.com"),
    getExtraChecks(),
  ]);
  const [trace, deep] = await Promise.all([
    traceRoute("8.8.8.8", 12),
    getDeepChecks(),
  ]);
  return { adapters, primary, gateway, publicIp, publicDns, dnsResolve, extra, trace, deep };
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

// Turn a VPN off (or back on) so the app can prove whether the VPN is what is
// blocking the internet, instead of just blaming it. Needs admin.
async function setVpnEnabled(enabled, adapters, services) {
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const adapterList = (adapters || []).filter(Boolean).map(q).join(",");
  const serviceList = (services || []).filter(Boolean).map(q).join(",");
  if (!adapterList && !serviceList) return { ok: false, error: "Nothing to change." };

  const lines = ["$ErrorActionPreference='SilentlyContinue';"];
  if (enabled) {
    if (serviceList) lines.push(`foreach ($s in @(${serviceList})) { Start-Service -Name $s };`);
    if (adapterList) lines.push(`foreach ($a in @(${adapterList})) { Enable-NetAdapter -Name $a -Confirm:$false };`);
  } else {
    if (adapterList) lines.push(`foreach ($a in @(${adapterList})) { Disable-NetAdapter -Name $a -Confirm:$false };`);
    if (serviceList) lines.push(`foreach ($s in @(${serviceList})) { Stop-Service -Name $s -Force };`);
  }
  lines.push("'OK'");

  const results = await runElevatedBatch([{
    id: enabled ? "vpn-on" : "vpn-off",
    cmd: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", lines.join(" ")],
  }]);
  const r = results[0];
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.error) || `exit ${r && r.exitCode}` };
  }
  return { ok: true, steps: [{ cmd: enabled ? "Turn VPN back on" : "Turn VPN off", ok: true, out: (r.stdout || "").trim(), err: "" }] };
}

ipcMain.handle("net-set-vpn-enabled", (_, { enabled, adapters, services }) => setVpnEnabled(enabled, adapters, services));
ipcMain.handle("net-diagnostics",    () => runDiagnostics());
ipcMain.handle("net-get-adapters",   () => getNetworkConfig());
ipcMain.handle("net-fix-dns",        (_, { adapter, primary, secondary }) => fixDns(adapter, primary, secondary));
ipcMain.handle("net-reset-dns",      (_, { adapter }) => resetDnsAuto(adapter));
ipcMain.handle("net-flush-dns",      () => flushDns());
ipcMain.handle("net-renew-ip",       () => renewIp());
ipcMain.handle("net-reset-winsock",  () => resetWinsock());
ipcMain.handle("net-reset-ip-stack", () => resetIpStack());
