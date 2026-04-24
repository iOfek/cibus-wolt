/**
 * Install cibus-wolt as background macOS services via launchd.
 *
 * Two Launch Agents that auto-start on login and auto-restart on crash:
 *   - com.ofek.cibus-wolt.mcp      — the HTTP server on localhost:3737
 *   - com.ofek.cibus-wolt.tunnel   — ngrok exposing it at a stable public URL
 *
 * Requires: a reserved ngrok static domain (free — see `cibus-wolt stable-tunnel`).
 * The domain is read from ~/.cibus-wolt/tunnel-hostname. If missing, the tunnel
 * service is not installed; the server still runs on localhost.
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

const HOME = os.homedir();
const PROJECT = path.resolve(".");
const LAUNCH_AGENTS = path.join(HOME, "Library", "LaunchAgents");

const MCP_LABEL = "com.ofek.cibus-wolt.mcp";
const TUNNEL_LABEL = "com.ofek.cibus-wolt.tunnel";

function resolveBinary(name: string, fallback: string): string {
  try {
    const out = execSync(`/usr/bin/env which ${name}`, { encoding: "utf8" }).trim();
    if (out) return out;
  } catch {
    /* not on PATH */
  }
  return fallback;
}

const NODE_BIN = resolveBinary("node", "/opt/homebrew/bin/node");
const NGROK_BIN = resolveBinary("ngrok", "/opt/homebrew/bin/ngrok");

function mcpPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MCP_LABEL}</string>
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

function tunnelPlist(domain: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TUNNEL_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NGROK_BIN}</string>
    <string>http</string>
    <string>--log</string>
    <string>stdout</string>
    <string>--url=${domain}</string>
    <string>3737</string>
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

function unload(label: string): void {
  try {
    execSync(`/bin/launchctl unload -w "${path.join(LAUNCH_AGENTS, `${label}.plist`)}"`, { stdio: "ignore" });
  } catch {
    /* ok if not loaded */
  }
}

function load(label: string): void {
  execSync(`/bin/launchctl load -w "${path.join(LAUNCH_AGENTS, `${label}.plist`)}"`, { stdio: "inherit" });
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

async function readNgrokDomain(): Promise<string | null> {
  try {
    const d = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
    return d || null;
  } catch {
    return null;
  }
}

async function main() {
  await ensureStateDir();
  await fs.mkdir(LAUNCH_AGENTS, { recursive: true });

  const token = await ensureBearerToken();
  const domain = await readNgrokDomain();

  logger.info({ NODE_BIN, NGROK_BIN, PROJECT, LOGS_DIR: paths.logsDir, domain }, "Installing launchd services");

  // Always install the HTTP server
  await writePlist(MCP_LABEL, mcpPlist());
  unload(MCP_LABEL);
  load(MCP_LABEL);

  if (!domain) {
    logger.warn("No ngrok domain configured yet (~/.cibus-wolt/tunnel-hostname missing).");
    logger.warn("Server is running on localhost:3737 but not publicly reachable.");
    logger.warn("Run `npx cibus-wolt stable-tunnel` to reserve a free ngrok domain, then re-run install-bg.");
    return;
  }

  // Tunnel service: ngrok
  await writePlist(TUNNEL_LABEL, tunnelPlist(domain));
  unload(TUNNEL_LABEL);
  load(TUNNEL_LABEL);

  const connectorUrl = `https://${domain}/mcp/${token}`;
  const webhookUrl = `https://${domain}/webhook/<token>/...`;

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
  console.log("Status:     launchctl list | grep cibus-wolt");
  console.log(`Logs:       tail -f ${paths.logsDir}/mcp.log ${paths.logsDir}/tunnel.log`);
  console.log("Uninstall:  npm run uninstall-bg");
  console.log("");
  console.log(`Phone webhook URL: npx cibus-wolt webhook-url`);
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Install failed");
  process.exit(1);
});
