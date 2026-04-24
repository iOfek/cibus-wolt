/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import { paths, ensureStateDir } from "../paths.ts";

async function readToken(): Promise<string | null> {
  try {
    const t = (await fs.readFile(paths.webhookToken, "utf8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

async function readTunnelUrl(): Promise<{ url: string; stable: boolean } | null> {
  // Prefer stable named tunnel if configured
  try {
    const hostname = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
    if (hostname) return { url: `https://${hostname}`, stable: true };
  } catch {
    /* no named tunnel */
  }

  // Fallback: parse quick-tunnel URL from cloudflared logs
  const candidates = [
    path.join(paths.logsDir, "tunnel.cloudflared.log"),
    path.join(paths.logsDir, "tunnel.err.log"),
    path.join(paths.logsDir, "tunnel.log"),
  ];
  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
  for (const f of candidates) {
    try {
      const text = await fs.readFile(f, "utf8");
      const matches = text.match(re);
      if (matches && matches.length > 0) return { url: matches[matches.length - 1]!, stable: false };
    } catch {
      /* next */
    }
  }
  return null;
}

export async function runWebhookUrlCommand(): Promise<void> {
  await ensureStateDir();
  const token = await readToken();
  const found = await readTunnelUrl();

  if (!token) {
    console.error("No webhook token yet — start the server (npm run mcp) at least once.");
    process.exit(1);
  }
  if (!found) {
    console.error("No tunnel URL found. Is cloudflared running?");
    console.error("  brew install cloudflared && npm run install-bg");
    console.error("  Or set up a stable tunnel: npx cibus-wolt stable-tunnel");
    process.exit(1);
  }

  const base = `${found.url}/webhook/${token}`;
  console.log(`${found.stable ? "STABLE" : "⚠ QUICK (rotates on reboot)"} tunnel URL:`);
  console.log(`  ${found.url}\n`);
  console.log(`Webhook base URL:\n  ${base}\n`);
  console.log("Endpoints:");
  console.log(`  POST  ${base}/drain       body: { "dry_run"?: boolean }`);
  console.log(`  POST  ${base}/otp         body: { "code": "123456" }`);
  console.log(`  POST  ${base}/magic_link  body: { "url": "https://wolt.com/me/magic_login?..." }`);
  console.log(`  POST  ${base}/ack`);
  console.log(`  GET   ${base}/status`);
  console.log(`  GET   ${base}/url         (current tunnel URL reflection)`);
  console.log("\nTreat the full URL as a password — anyone with it can call all endpoints.");
  if (!found.stable) {
    console.log("\nUpgrade to a stable URL: npx cibus-wolt stable-tunnel");
  }
}
