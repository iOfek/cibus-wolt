/* eslint-disable no-console */
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";
import { binaryExists, IS_MAC, IS_WIN, openUrl } from "../platform.ts";
import {
  blank, bold, cmd, cyan, defaultSuffix, dim, failure, info, note, section,
  success, val, warn, yesNoSuffix,
} from "../ui.ts";

/**
 * `cibus-wolt devtunnel-setup` — sets up Microsoft Azure Dev Tunnels as the
 * tunneling provider. The MS-managed alternative to ngrok, useful when ngrok
 * is blocked by corporate network policy. Free for personal use; sign in
 * with a personal Microsoft account.
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
    const ans = (await rl.question(`  ${prompt}${defaultSuffix(defaultValue)}: `)).trim();
    return ans || (defaultValue ?? "");
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let raw = "";
  try {
    raw = await rl.question(`  ${prompt}${yesNoSuffix(defaultYes)}: `);
  } finally {
    rl.close();
  }
  const ans = raw.trim().toLowerCase();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
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

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— Azure Dev Tunnels setup")}`);
  note("Microsoft's first-party tunneling product. Stable URL, signed in with your");
  note("personal Microsoft account. Use this when ngrok is blocked.");

  // Step 1: install devtunnel
  section("Install devtunnel", { step: { n: 1, total: 4 } });
  if (binaryExists("devtunnel")) {
    success("devtunnel already installed");
  } else {
    const hint = installHint();
    const doInstall = await askYesNo(`devtunnel not found. Run ${cmd(hint)}?`, true);
    if (!doInstall) {
      note("Install devtunnel manually, then re-run this command.");
      return;
    }
    if (!tryInstallDevtunnel()) {
      failure(`Auto-install failed. See ${val("https://aka.ms/devtunnels/docs/cli")}`);
      return;
    }
  }

  // Step 2: log in
  section("Microsoft account login", { step: { n: 2, total: 4 } });
  if (isLoggedIn()) {
    success("Already logged in to devtunnel");
    const relogin = await askYesNo("Switch account?", false);
    if (relogin) await runDevtunnelLogin();
  } else {
    info("A browser window will open for Microsoft account sign-in.");
    note("Use a personal MS account — work tenants often block --allow-anonymous.");
    blank();
    await askYesNo("Continue?", true);
    await runDevtunnelLogin();
    if (!isLoggedIn()) {
      warn("Login didn't complete. Re-run this command after signing in.");
      return;
    }
  }

  // Step 3: create the persistent tunnel + port
  section(`Create persistent tunnel "${TUNNEL_NAME}"`, { step: { n: 3, total: 4 } });
  if (tunnelExists(TUNNEL_NAME)) {
    success(`Tunnel ${val(`"${TUNNEL_NAME}"`)} already exists`);
    const recreate = await askYesNo("Recreate it (drops the existing URL)?", false);
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
  section("Save tunnel info + install background service", { step: { n: 4, total: 4 } });
  const ids = readTunnelFullId(TUNNEL_NAME);
  if (!ids) {
    warn(`Couldn't parse tunnel ID from ${cmd("devtunnel show")}. Run it manually:`);
    info(cmd(`devtunnel show ${TUNNEL_NAME}`));
    return;
  }
  const hostname = buildHostname(ids.base, ids.cluster, PORT);
  await fs.writeFile(paths.tunnelHostname, hostname, { mode: 0o600 });
  await fs.writeFile(paths.tunnelKind, "devtunnel\n", { mode: 0o600 });
  await fs.writeFile(paths.devtunnelId, TUNNEL_NAME, { mode: 0o600 });
  success(`Hostname:  ${val(hostname)}`);
  success(`Tunnel ID: ${val(`${ids.base}.${ids.cluster}`)}`);
  success(`Persisted to ${val(paths.tunnelHostname)} + ${val(paths.tunnelKind)}`);

  const doInstall = await askYesNo("Install/update the background service that hosts the tunnel on login?", true);
  if (!doInstall) {
    note("Skipped. Run manually:");
    info(cmd(`devtunnel host ${TUNNEL_NAME}`));
    return;
  }
  try {
    // install-bg prints the URLs + service status — no need to repeat them here.
    execSync("npm run install-bg", { stdio: "inherit" });
  } catch {
    failure(`install-bg failed. Run manually: ${cmd("npm run install-bg")}`);
    return;
  }
}

function createTunnel(): boolean {
  try {
    // --allow-anonymous lets external clients (Claude, iOS Shortcuts) hit it
    // without devtunnel auth. Our own bearer token still protects MCP/webhook.
    execSync(`devtunnel create ${TUNNEL_NAME} --allow-anonymous`, { stdio: "inherit" });
    execSync(`devtunnel port create ${TUNNEL_NAME} -p ${PORT} --protocol http`, { stdio: "inherit" });
    return true;
  } catch (e) {
    failure(`Tunnel creation failed: ${e instanceof Error ? e.message : String(e)}`);
    note(`Common cause: tenant policy blocks ${cmd("--allow-anonymous")} on a work account.`);
    note("Sign in with a personal MS account (Step 2) and re-run.");
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
