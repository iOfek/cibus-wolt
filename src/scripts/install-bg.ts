/**
 * Install cibus-wolt as background services so the MCP server + tunnel
 * provider survive logout/reboot.
 *
 * Two services per platform, both auto-start on login and auto-restart on
 * crash:
 *   - <prefix>.mcp     — the HTTP server on localhost:3737
 *   - <prefix>.tunnel  — exposes it at the user's stable public URL
 *
 * Tunnel provider is read from ~/.cibus-wolt/tunnel-kind:
 *   - "ngrok"      → `ngrok http --url=<domain> 3737`        (default)
 *   - "devtunnel"  → `devtunnel host <name>`                 (Microsoft, useful
 *                                                             when ngrok is
 *                                                             blocked at corp)
 *
 * Backend per OS:
 *   - macOS:   launchd Launch Agents in ~/Library/LaunchAgents
 *   - Windows: Task Scheduler at-logon tasks driving a PowerShell wrapper
 *              that loops the binary with a 10s backoff
 *
 * Requires: a tunnel hostname at ~/.cibus-wolt/tunnel-hostname. If missing,
 * the tunnel service is not installed; the server still runs on localhost.
 *
 * Logs go to ~/.cibus-wolt/logs/.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { logger } from "../logger.ts";
import { ensureStateDir, paths } from "../paths.ts";
import { findOnPath, IS_MAC, IS_WIN } from "../platform.ts";
import { SERVICE_LABELS } from "../services.ts";

const HOME = os.homedir();
const PROJECT = path.resolve(".");
const LAUNCH_AGENTS = path.join(HOME, "Library", "LaunchAgents");

// ────────────────────────────────────────────────────────────────────────────
// Shared
// ────────────────────────────────────────────────────────────────────────────

const NODE_BIN = findOnPath("node") ?? (IS_WIN ? "node.exe" : "/opt/homebrew/bin/node");
const NGROK_BIN = findOnPath("ngrok") ?? (IS_WIN ? "ngrok.exe" : "/opt/homebrew/bin/ngrok");
const DEVTUNNEL_BIN = findOnPath("devtunnel") ?? (IS_WIN ? "devtunnel.exe" : "/opt/homebrew/bin/devtunnel");

type TunnelKind = "ngrok" | "devtunnel";

interface TunnelConfig {
  kind: TunnelKind;
  hostname: string | null; // public hostname (always present once configured)
  devtunnelId: string;     // local devtunnel name; only used when kind === "devtunnel"
}

async function readTunnelKind(): Promise<TunnelKind> {
  try {
    const k = (await fs.readFile(paths.tunnelKind, "utf8")).trim();
    if (k === "devtunnel") return "devtunnel";
  } catch {
    /* default below */
  }
  return "ngrok";
}

async function readDevtunnelId(): Promise<string> {
  try {
    const id = (await fs.readFile(paths.devtunnelId, "utf8")).trim();
    if (id) return id;
  } catch {
    /* default below */
  }
  return "cibus-wolt";
}

async function ensureBearerToken(): Promise<string> {
  // Read project-root .env for backward compat; new installs use ~/.cibus-wolt/.env
  const envPaths = [path.join(PROJECT, ".env"), path.join(paths.dir, ".env")];
  for (const envPath of envPaths) {
    try {
      const text = await fs.readFile(envPath, "utf8");
      const line = text.split("\n").find((l) => l.startsWith("MCP_BEARER_TOKEN="));
      const existing = line ? line.substring("MCP_BEARER_TOKEN=".length).trim() : "";
      if (existing && existing !== "change-me") return existing;
    } catch {
      /* next */
    }
  }

  const token = crypto.randomBytes(32).toString("hex");
  const envPath = path.join(paths.dir, ".env");
  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch {
    /* new file */
  }
  const without = current
    .split("\n")
    .filter((l) => !l.startsWith("MCP_BEARER_TOKEN="))
    .join("\n")
    .replace(/\n+$/, "");
  const next = (without ? without + "\n" : "") + `MCP_BEARER_TOKEN=${token}\n`;
  await fs.writeFile(envPath, next, { mode: 0o600 });
  logger.info(`Generated fresh MCP_BEARER_TOKEN → ${envPath}`);
  return token;
}

async function readTunnelHostname(): Promise<string | null> {
  try {
    const d = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
    return d || null;
  } catch {
    return null;
  }
}

async function readTunnelConfig(): Promise<TunnelConfig> {
  return {
    kind: await readTunnelKind(),
    hostname: await readTunnelHostname(),
    devtunnelId: await readDevtunnelId(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// macOS — launchd
// ────────────────────────────────────────────────────────────────────────────

function mcpPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABELS.mac.mcp}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--import</string>
    <string>tsx/esm</string>
    <string>${PROJECT}/src/scripts/mcp.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${paths.logsDir}/mcp.log</string>
  <key>StandardErrorPath</key>
  <string>${paths.logsDir}/mcp.err.log</string>
</dict>
</plist>
`;
}

function tunnelProgramArgs(cfg: TunnelConfig): string[] {
  if (cfg.kind === "devtunnel") {
    // Port was set at `devtunnel create` time, so `host` takes only the name.
    return [DEVTUNNEL_BIN, "host", cfg.devtunnelId];
  }
  // ngrok (default)
  return [NGROK_BIN, "http", "--log", "stdout", `--url=${cfg.hostname}`, "3737"];
}

function tunnelPlist(cfg: TunnelConfig): string {
  const argsXml = tunnelProgramArgs(cfg)
    .map((a) => `    <string>${a}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABELS.mac.tunnel}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${HOME}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${paths.logsDir}/tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>${paths.logsDir}/tunnel.err.log</string>
</dict>
</plist>
`;
}

async function writePlist(label: string, content: string): Promise<string> {
  const plistPath = path.join(LAUNCH_AGENTS, `${label}.plist`);
  await fs.writeFile(plistPath, content, "utf8");
  return plistPath;
}

function unloadMac(label: string): void {
  try {
    execSync(`/bin/launchctl unload -w "${path.join(LAUNCH_AGENTS, `${label}.plist`)}"`, { stdio: "ignore" });
  } catch {
    /* ok if not loaded */
  }
}

function loadMac(label: string): void {
  execSync(`/bin/launchctl load -w "${path.join(LAUNCH_AGENTS, `${label}.plist`)}"`, { stdio: "inherit" });
}

async function installMac(cfg: TunnelConfig): Promise<void> {
  await fs.mkdir(LAUNCH_AGENTS, { recursive: true });

  await writePlist(SERVICE_LABELS.mac.mcp, mcpPlist());
  unloadMac(SERVICE_LABELS.mac.mcp);
  loadMac(SERVICE_LABELS.mac.mcp);

  if (!cfg.hostname) return;

  await writePlist(SERVICE_LABELS.mac.tunnel, tunnelPlist(cfg));
  unloadMac(SERVICE_LABELS.mac.tunnel);
  loadMac(SERVICE_LABELS.mac.tunnel);
}

// ────────────────────────────────────────────────────────────────────────────
// Windows — Task Scheduler + PowerShell wrapper
//
// PowerShell wrapper supplies the KeepAlive semantics that launchd has natively
// — schtasks won't restart a crashed process by itself. The wrapper loops the
// real binary with a 10s backoff and tees its output to log files.
// ────────────────────────────────────────────────────────────────────────────

const SCRIPTS_DIR = path.join(paths.dir, "scripts");

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function mcpWrapperPs1(): string {
  return `# cibus-wolt MCP server wrapper. Re-runs node on crash with backoff.
$ErrorActionPreference = "Continue"
$projectRoot = ${psQuote(PROJECT)}
$logsDir = ${psQuote(paths.logsDir)}
$nodeExe = ${psQuote(NODE_BIN)}
$mcpScript = Join-Path $projectRoot "src\\scripts\\mcp.ts"
Set-Location -Path $projectRoot
while ($true) {
  try {
    & $nodeExe --import tsx/esm $mcpScript 1>> (Join-Path $logsDir "mcp.log") 2>> (Join-Path $logsDir "mcp.err.log")
  } catch {
    Add-Content -Path (Join-Path $logsDir "mcp.err.log") -Value $_.Exception.Message
  }
  Start-Sleep -Seconds 10
}
`;
}

function tunnelWrapperPs1(cfg: TunnelConfig): string {
  if (cfg.kind === "devtunnel") {
    return `# cibus-wolt Azure Dev Tunnels wrapper. Re-runs devtunnel on crash with backoff.
$ErrorActionPreference = "Continue"
$logsDir = ${psQuote(paths.logsDir)}
$devtunnelExe = ${psQuote(DEVTUNNEL_BIN)}
$tunnelId = ${psQuote(cfg.devtunnelId)}
while ($true) {
  try {
    & $devtunnelExe host $tunnelId 1>> (Join-Path $logsDir "tunnel.log") 2>> (Join-Path $logsDir "tunnel.err.log")
  } catch {
    Add-Content -Path (Join-Path $logsDir "tunnel.err.log") -Value $_.Exception.Message
  }
  Start-Sleep -Seconds 10
}
`;
  }
  return `# cibus-wolt ngrok tunnel wrapper. Re-runs ngrok on crash with backoff.
$ErrorActionPreference = "Continue"
$logsDir = ${psQuote(paths.logsDir)}
$ngrokExe = ${psQuote(NGROK_BIN)}
$domain = ${psQuote(cfg.hostname ?? "")}
while ($true) {
  try {
    & $ngrokExe http --log stdout "--url=$domain" 3737 1>> (Join-Path $logsDir "tunnel.log") 2>> (Join-Path $logsDir "tunnel.err.log")
  } catch {
    Add-Content -Path (Join-Path $logsDir "tunnel.err.log") -Value $_.Exception.Message
  }
  Start-Sleep -Seconds 10
}
`;
}

function runPowerShell(script: string): void {
  // -EncodedCommand sidesteps every layer of quoting trouble. Note the UTF-16LE.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
    stdio: "inherit",
  });
}

function registerWinTask(taskName: string, wrapperPath: string): void {
  // Register-ScheduledTask is more reliable than schtasks /Create for tasks
  // that stay running and handle their own restart loop — we set RestartCount
  // anyway as a belt-and-suspenders against a wrapper crash.
  const ps = `
$ErrorActionPreference = "Stop"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + ${psQuote(wrapperPath)} + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName ${psQuote(taskName)}
`;
  runPowerShell(ps);
}

async function installWin(cfg: TunnelConfig): Promise<void> {
  await fs.mkdir(SCRIPTS_DIR, { recursive: true });

  const mcpWrapper = path.join(SCRIPTS_DIR, "run-mcp.ps1");
  await fs.writeFile(mcpWrapper, mcpWrapperPs1(), "utf8");
  registerWinTask(SERVICE_LABELS.win.mcp, mcpWrapper);

  if (!cfg.hostname) return;

  const tunnelWrapper = path.join(SCRIPTS_DIR, "run-tunnel.ps1");
  await fs.writeFile(tunnelWrapper, tunnelWrapperPs1(cfg), "utf8");
  registerWinTask(SERVICE_LABELS.win.tunnel, tunnelWrapper);
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  await ensureStateDir();

  const token = await ensureBearerToken();
  const cfg = await readTunnelConfig();

  logger.info(
    {
      NODE_BIN,
      NGROK_BIN,
      DEVTUNNEL_BIN,
      PROJECT,
      LOGS_DIR: paths.logsDir,
      tunnelKind: cfg.kind,
      hostname: cfg.hostname,
      devtunnelId: cfg.devtunnelId,
      platform: process.platform,
    },
    "Installing background services"
  );

  if (IS_MAC) await installMac(cfg);
  else if (IS_WIN) await installWin(cfg);
  else {
    logger.error(`Unsupported platform: ${process.platform}. Background-service install supports macOS and Windows.`);
    process.exit(1);
  }

  if (!cfg.hostname) {
    logger.warn("No tunnel hostname configured yet (~/.cibus-wolt/tunnel-hostname missing).");
    logger.warn("Server is running on localhost:3737 but not publicly reachable.");
    logger.warn("Run `npx cibus-wolt stable-tunnel` (ngrok) or `npx cibus-wolt devtunnel-setup` (Azure Dev Tunnels), then re-run install-bg.");
    return;
  }

  const domain = cfg.hostname;
  const connectorUrl = `https://${domain}/mcp/${token}`;

  console.log("");
  console.log("━".repeat(74));
  console.log("✓ Services installed + running.");
  console.log("");
  console.log("Your stable URLs (survive reboots):");
  console.log(`  Webhook base: https://${domain}/webhook/<webhook-token>`);
  console.log(`  MCP:          ${connectorUrl}`);
  console.log("");
  console.log("━".repeat(74));
  console.log("");
  console.log("Claude.ai Custom Connector:");
  console.log("  1. Open claude.ai → Settings → Connectors → Add custom connector");
  console.log("  2. Name: Cibus-Wolt");
  console.log(`  3. URL: ${connectorUrl}`);
  console.log("  4. Leave OAuth fields blank. Click Add.");
  console.log("");
  if (IS_MAC) {
    console.log("Status:     launchctl list | grep cibus-wolt");
    console.log(`Logs:       tail -f ${paths.logsDir}/mcp.log ${paths.logsDir}/tunnel.log`);
  } else if (IS_WIN) {
    console.log(`Status:     schtasks /Query /TN "${SERVICE_LABELS.win.mcp}"`);
    console.log(`            schtasks /Query /TN "${SERVICE_LABELS.win.tunnel}"`);
    console.log(`Logs:       Get-Content -Wait "${paths.logsDir}\\mcp.log","${paths.logsDir}\\tunnel.log"`);
  }
  console.log("Uninstall:  npm run uninstall-bg");
  console.log("");
  console.log(`Phone webhook URL: npx cibus-wolt webhook-url`);
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Install failed");
  process.exit(1);
});
