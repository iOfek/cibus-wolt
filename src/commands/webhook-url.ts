/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import { paths, ensureStateDir } from "../paths.ts";
import { blank, bold, cmd, dim, emphasis, failure, val, warn } from "../ui.ts";

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
    failure(`No webhook token yet — start the server (${cmd("npm run mcp")}) at least once.`);
    process.exit(1);
  }
  if (!found) {
    failure("No tunnel URL found.");
    console.error(`  Set up a stable ngrok tunnel: ${cmd("npx cibus-wolt stable-tunnel")}`);
    process.exit(1);
  }

  const base = `${found.url}/webhook/${token}`;
  const status = found.stable ? bold("STABLE") : `${emphasis("⚠ QUICK")} ${dim("(rotates on reboot)")}`;
  console.log(`${status} ${dim("tunnel URL:")}`);
  console.log(`  ${val(found.url)}`);
  blank();
  console.log(`${bold("Webhook base URL:")}`);
  console.log(`  ${val(base)}`);
  blank();
  console.log(bold("Endpoints:"));
  const ep = (method: string, p: string, body?: string): void => {
    const left = `  ${dim(method.padEnd(5, " "))} ${val(`${base}${p}`)}`;
    console.log(body ? `${left}  ${dim(body)}` : left);
  };
  ep("POST", "/drain", `body: { "dry_run"?: boolean }`);
  ep("POST", "/otp", `body: { "code": "123456" }`);
  ep("POST", "/magic_link", `body: { "url": "https://wolt.com/me/magic_login?..." }`);
  ep("POST", "/ack");
  ep("GET", "/status");
  ep("GET", "/url", "(current tunnel URL reflection)");
  blank();
  warn(`Treat the full URL as a ${emphasis("password")} — anyone with it can call all endpoints.`);
  if (!found.stable) {
    blank();
    console.log(`Upgrade to a stable URL: ${cmd("npx cibus-wolt stable-tunnel")}`);
  }
}
