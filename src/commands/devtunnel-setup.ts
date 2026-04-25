/* eslint-disable no-console */
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";
import { binaryExists, IS_MAC, IS_WIN, openUrl } from "../platform.ts";

/**
 * `cibus-wolt devtunnel-setup` — sets up Microsoft Azure Dev Tunnels as the
 * tunneling provider. The MS-managed alternative to ngrok, useful when ngrok
 * is blocked by corporate network policy. Free for personal use, signs in
 * with the same Microsoft account you use for Outlook / Copilot.
 *
 * Persistent tunnels survive reboots, so once created the URL is stable.
 *
 * What we save under ~/.cibus-wolt/:
 *   tunnel-hostname  — full hostname like cibus-wolt-3737.usw2.devtunnels.ms
 *   tunnel-kind      — "devtunnel"
 *   devtunnel-id     — the local tunnel name we host (default "cibus-wolt")
 */

const TUNNEL_NAME = "cibus-wolt";
const PORT = 3737;

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue !== undefined ? ` [${defaultValue || "(empty)"}]` : "";
    const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
    return ans || (defaultValue ?? "");
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  const def = defaultYes ? "Y/n" : "y/N";
  const ans = (await ask(`${prompt} (${def})`)).toLowerCase();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
}

function hr(): void {
  console.log("─".repeat(66));
}

function title(s: string): void {
  console.log("");
  hr();
  console.log(`  ${s}`);
  hr();
}

function tryInstallDevtunnel(): boolean {
  try {
    if (IS_WIN) {
      execSync("winget install --id Microsoft.devtunnel -e --silent --accept-source-agreements --accept-package-agreements", {
        stdio: "inherit",
        shell: "powershell.exe",
      } as { stdio: "inherit"; shell: string });
      return true;
    }
    if (IS_MAC) {
      execSync("brew install --cask devtunnel", { stdio: "inherit" });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function installHint(): string {
  if (IS_WIN) return "winget install --id Microsoft.devtunnel -e";
  if (IS_MAC) return "brew install --cask devtunnel";
  return "see https://aka.ms/devtunnels/docs/cli";
}

function isLoggedIn(): boolean {
  try {
    const out = execSync("devtunnel user show", { encoding: "utf8" });
    return /Logged in as/i.test(out) || /microsoft account/i.test(out) || /AAD/i.test(out);
  } catch {
    return false;
  }
}

function tunnelExists(name: string): boolean {
  try {
    execSync(`devtunnel show ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the full tunnel ID (`<base>.<cluster>`) by parsing `devtunnel show`.
 * The cluster is needed to build the public hostname, since the URL format is
 * `<base>-<port>.<cluster>.devtunnels.ms`.
 */
function readTunnelFullId(name: string): { base: string; cluster: string } | null {
  let out = "";
  try {
    out = execSync(`devtunnel show ${name}`, { encoding: "utf8" });
  } catch {
    return null;
  }
  // Look for a line like:  "Tunnel ID                   cibus-wolt-foo.usw2"
  // or                     "Tunnel ID: cibus-wolt-foo.usw2"
  const m = out.match(/Tunnel\s*ID[:\s]+([a-z0-9-]+)\.([a-z0-9-]+)/i);
  if (!m) return null;
  return { base: m[1]!, cluster: m[2]! };
}

function buildHostname(base: string, cluster: string, port: number): string {
  return `${base}-${port}.${cluster}.devtunnels.ms`;
}

export async function runDevtunnelSetupCommand(): Promise<void> {
  await ensureStateDir();

  console.log("");
  console.log("  cibus-wolt — Azure Dev Tunnels setup");
  console.log("  Microsoft's first-party tunneling product. Stable URL, signed in");
  console.log("  with your personal Microsoft account. Use this when ngrok is blocked.");

  // Step 1: install devtunnel
  title("1/4  Install devtunnel");
  if (binaryExists("devtunnel")) {
    console.log("  ✓ devtunnel already installed");
  } else {
    const hint = installHint();
    const doInstall = await askYesNo(`devtunnel not found. Run \`${hint}\`?`, true);
    if (!doInstall) {
      console.log("  Install devtunnel manually, then re-run this command.");
      return;
    }
    if (!tryInstallDevtunnel()) {
      console.log("  Auto-install failed. See https://aka.ms/devtunnels/docs/cli");
      return;
    }
  }

  // Step 2: log in
  title("2/4  Microsoft account login");
  if (isLoggedIn()) {
    console.log("  ✓ Already logged in to devtunnel");
    const relogin = await askYesNo("  Switch account?", false);
    if (relogin) await runDevtunnelLogin();
  } else {
    console.log("  A browser window will open for Microsoft account sign-in.");
    console.log("  Use the personal MS account that's connected to your Outlook (the");
    console.log("  one Copilot reads Wolt magic-link emails from).");
    console.log("");
    await askYesNo("Continue?", true);
    await runDevtunnelLogin();
    if (!isLoggedIn()) {
      console.log("  ⚠ Login didn't complete. Re-run this command after signing in.");
      return;
    }
  }

  // Step 3: create the persistent tunnel + port
  title(`3/4  Create persistent tunnel "${TUNNEL_NAME}"`);
  if (tunnelExists(TUNNEL_NAME)) {
    console.log(`  ✓ Tunnel "${TUNNEL_NAME}" already exists`);
    const recreate = await askYesNo("  Recreate it (drops the existing URL)?", false);
    if (recreate) {
      try {
        execSync(`devtunnel delete ${TUNNEL_NAME} -f`, { stdio: "ignore" });
      } catch {
        /* fine if delete fails */
      }
      if (!createTunnel()) return;
    }
  } else {
    if (!createTunnel()) return;
  }

  // Step 4: read the URL + persist
  title("4/4  Save tunnel info + install background service");
  const ids = readTunnelFullId(TUNNEL_NAME);
  if (!ids) {
    console.log("  ⚠ Couldn't parse tunnel ID from `devtunnel show`. Run it manually:");
    console.log(`     devtunnel show ${TUNNEL_NAME}`);
    return;
  }
  const hostname = buildHostname(ids.base, ids.cluster, PORT);
  await fs.writeFile(paths.tunnelHostname, hostname, { mode: 0o600 });
  await fs.writeFile(paths.tunnelKind, "devtunnel\n", { mode: 0o600 });
  await fs.writeFile(paths.devtunnelId, TUNNEL_NAME, { mode: 0o600 });
  console.log(`  ✓ Hostname:  ${hostname}`);
  console.log(`  ✓ Tunnel ID: ${ids.base}.${ids.cluster}`);
  console.log(`  ✓ Persisted to ${paths.tunnelHostname} + ${paths.tunnelKind}`);

  const doInstall = await askYesNo("Install/update the background service that hosts the tunnel on login?", true);
  if (!doInstall) {
    console.log("  Skipped. Run manually:");
    console.log(`    devtunnel host ${TUNNEL_NAME}`);
    return;
  }
  try {
    execSync("npm run install-bg", { stdio: "inherit" });
  } catch {
    console.log("  install-bg failed. Run manually: npm run install-bg");
    return;
  }

  // Show endpoints
  console.log("");
  hr();
  console.log("  ✓ Dev Tunnel ready.");
  console.log("");
  console.log("  Your endpoints:");
  console.log(`    Webhook:  https://${hostname}/webhook/<token>/...`);
  console.log(`    MCP:      https://${hostname}/mcp/<MCP_BEARER_TOKEN>`);
  console.log("");
  console.log("  These URLs survive reboots as long as the tunnel exists in your MS account.");
  console.log("  Get the full URLs anytime: npx cibus-wolt webhook-url");
  hr();
}

function createTunnel(): boolean {
  try {
    // --allow-anonymous lets external clients (Claude, iOS Shortcuts) hit it
    // without devtunnel auth. Our own bearer token still protects MCP/webhook.
    execSync(`devtunnel create ${TUNNEL_NAME} --allow-anonymous`, { stdio: "inherit" });
    execSync(`devtunnel port create ${TUNNEL_NAME} -p ${PORT} --protocol http`, { stdio: "inherit" });
    return true;
  } catch (e) {
    console.log(`  ⚠ Tunnel creation failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log("    Common cause: tenant policy blocks `--allow-anonymous` on a work account.");
    console.log("    Sign in with a personal MS account (Step 2) and re-run.");
    return false;
  }
}

async function runDevtunnelLogin(): Promise<void> {
  // -d uses the device-code flow if present, otherwise default opens browser.
  // We just spawn the default `devtunnel user login` which auto-picks the flow.
  try {
    execSync("devtunnel user login", { stdio: "inherit" });
  } catch {
    /* user may have cancelled — caller checks isLoggedIn() */
  }
  // Best-effort: nudge the docs URL in case the browser didn't open.
  if (!isLoggedIn()) {
    openUrl("https://aka.ms/devtunnels");
  }
}
