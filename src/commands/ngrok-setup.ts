/* eslint-disable no-console */
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";
import { binaryExists, ngrokInstallHint, openUrl, tryInstallNgrok } from "../platform.ts";
import {
  blank, bold, cmd, cyan, defaultSuffix, dim, failure, info, note, numbered,
  section, success, val, warn, yesNoSuffix,
} from "../ui.ts";

/**
 * `cibus-wolt tunnel-setup` — sets up ngrok with a free static domain so your
 * tunnel URL is stable across reboots.
 *
 * What you get on the ngrok free tier: 1 static domain on *.ngrok-free.app,
 * 1 concurrent tunnel, enough bandwidth for personal use. No credit card.
 * Only cost is a free signup at ngrok.com.
 */

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

function ngrokAuthtokenConfigured(): boolean {
  // ngrok stores config at platform-specific paths; easiest check: `ngrok
  // config check` exits 0 iff a token is on file.
  try {
    execSync("ngrok config check", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runNgrokSetupCommand(): Promise<void> {
  await ensureStateDir();

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— ngrok stable-URL setup")}`);
  note(`Gets you a fixed URL like ${val("https://<name>.ngrok-free.app")} that survives reboots.`);
  note("Free: $0 signup, no credit card, no domain purchase.");

  // Step 1: install ngrok
  section("Install ngrok", { step: { n: 1, total: 4 } });
  if (binaryExists("ngrok")) {
    success("ngrok already installed");
  } else {
    const hint = ngrokInstallHint();
    const doInstall = await askYesNo(`ngrok not found. Run ${cmd(hint)}?`, true);
    if (!doInstall) {
      note("Install ngrok manually, then re-run this command.");
      return;
    }
    if (!tryInstallNgrok()) {
      failure(`Auto-install failed. Install manually from ${val("https://ngrok.com/download")}`);
      return;
    }
  }

  // Step 2: authtoken
  section("Authtoken", { step: { n: 2, total: 4 } });
  if (ngrokAuthtokenConfigured()) {
    success("ngrok authtoken already configured");
    const rotate = await askYesNo("Replace it anyway?", false);
    if (rotate) await promptAndStoreToken();
  } else {
    numbered(1, `Sign up (free): ${val("https://dashboard.ngrok.com/signup")}`);
    numbered(2, `Copy your authtoken from: ${val("https://dashboard.ngrok.com/get-started/your-authtoken")}`);
    blank();
    const openBrowser = await askYesNo("Open the ngrok dashboard now?", true);
    if (openBrowser) openUrl("https://dashboard.ngrok.com/get-started/your-authtoken");
    await promptAndStoreToken();
  }

  // Step 3: static domain
  section("Reserve a free static domain", { step: { n: 3, total: 4 } });
  note(`Free tier includes ${bold("ONE")} static domain on ${val("*.ngrok-free.app")}.`);
  blank();
  numbered(1, `Go to: ${val("https://dashboard.ngrok.com/domains")}`);
  numbered(2, `Click ${bold("'New Domain'")} → pick a free subdomain ${dim("(format: <anything>.ngrok-free.app)")}`);
  numbered(3, "Copy the full domain it shows you.");
  blank();
  const openDomains = await askYesNo("Open the Domains page now?", true);
  if (openDomains) openUrl("https://dashboard.ngrok.com/domains");

  let existing = "";
  try {
    existing = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
  } catch {
    /* no previous value */
  }
  const domain = await ask("Your ngrok domain (e.g. cibus-wolt-ofek.ngrok-free.app)", existing);
  if (!domain || !/\.ngrok(?:-free)?\.app$/.test(domain)) {
    warn(`Expected something like ${val("'<name>.ngrok-free.app'")}. Got: ${val(domain || "(empty)")}`);
    const save = await askYesNo("Save it anyway?", false);
    if (!save) return;
  }
  await fs.writeFile(paths.tunnelHostname, domain, { mode: 0o600 });
  await fs.writeFile(paths.tunnelKind, "ngrok\n", { mode: 0o600 });
  // Clean up any leftover devtunnel marker from a previous provider switch.
  await fs.rm(paths.devtunnelId, { force: true });
  success(`Saved to ${val(paths.tunnelHostname)}`);

  // Step 4: install/reload background tunnel service
  section("Install background tunnel service", { step: { n: 4, total: 4 } });
  const doInstall = await askYesNo("Install/update the service that runs ngrok on login?", true);
  if (!doInstall) {
    note("Skipped. Run manually:");
    info(cmd(`ngrok http --url=${domain} 3737`));
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

async function promptAndStoreToken(): Promise<void> {
  const token = (await ask("Paste your ngrok authtoken here")).trim();
  if (!token) {
    note("Empty — skipping.");
    return;
  }
  try {
    execSync(`ngrok config add-authtoken ${token}`, { stdio: "ignore" });
    success("ngrok authtoken stored in ngrok's config");
  } catch (e) {
    failure(`Failed to store token: ${e instanceof Error ? e.message : String(e)}`);
  }
}
