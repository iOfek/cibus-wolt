/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";

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

function binaryExists(bin: string): boolean {
  try {
    execSync(`/usr/bin/env which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

function ngrokAuthtokenConfigured(): boolean {
  // ngrok stores config at ~/Library/Application Support/ngrok/ngrok.yml on macOS
  // or ~/.config/ngrok/ngrok.yml. Easiest check: `ngrok config check` exits 0.
  try {
    execSync("ngrok config check", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runNgrokSetupCommand(): Promise<void> {
  await ensureStateDir();

  console.log("");
  console.log("  cibus-wolt — ngrok stable-URL setup");
  console.log("  Gets you a fixed URL like https://<name>.ngrok-free.app that survives");
  console.log("  reboots. Free: $0 signup, no credit card, no domain purchase.");

  // Step 1: install ngrok
  title("1/4  Install ngrok");
  if (binaryExists("ngrok")) {
    console.log("  ✓ ngrok already installed");
  } else {
    const doInstall = await askYesNo("ngrok not found. Run `brew install ngrok`?", true);
    if (!doInstall) {
      console.log("  Install ngrok manually, then re-run this command.");
      return;
    }
    try {
      execSync("brew install ngrok", { stdio: "inherit" });
    } catch {
      console.log("  brew install failed. Install manually from https://ngrok.com/download");
      return;
    }
  }

  // Step 2: authtoken
  title("2/4  Authtoken");
  if (ngrokAuthtokenConfigured()) {
    console.log("  ✓ ngrok authtoken already configured");
    const rotate = await askYesNo("  Replace it anyway?", false);
    if (!rotate) {
      /* skip */
    } else {
      await promptAndStoreToken();
    }
  } else {
    console.log("  1. Sign up (free): https://dashboard.ngrok.com/signup");
    console.log("  2. Copy your authtoken from: https://dashboard.ngrok.com/get-started/your-authtoken");
    console.log("");
    const openBrowser = await askYesNo("Open the ngrok dashboard now?", true);
    if (openBrowser) {
      try {
        spawn("open", ["https://dashboard.ngrok.com/get-started/your-authtoken"], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch {
        /* fallthrough */
      }
    }
    await promptAndStoreToken();
  }

  // Step 3: static domain
  title("3/4  Reserve a free static domain");
  console.log("  Free tier includes ONE static domain on *.ngrok-free.app.");
  console.log("");
  console.log("  1. Go to: https://dashboard.ngrok.com/domains");
  console.log("  2. Click 'New Domain' → pick a free subdomain");
  console.log("     (format: <anything>.ngrok-free.app — letters, digits, hyphens)");
  console.log("  3. Copy the full domain it shows you.");
  console.log("");
  const openDomains = await askYesNo("Open the Domains page now?", true);
  if (openDomains) {
    try {
      spawn("open", ["https://dashboard.ngrok.com/domains"], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* fallthrough */
    }
  }

  let existing = "";
  try {
    existing = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
  } catch {
    /* no previous value */
  }
  const domain = await ask("Your ngrok domain (e.g. cibus-wolt-ofek.ngrok-free.app)", existing);
  if (!domain || !/\.ngrok(?:-free)?\.app$/.test(domain)) {
    console.log(`  ⚠ Expected something like '<name>.ngrok-free.app'. Got: ${domain || "(empty)"}`);
    const save = await askYesNo("Save it anyway?", false);
    if (!save) return;
  }
  await fs.writeFile(paths.tunnelHostname, domain, { mode: 0o600 });
  console.log(`  ✓ Saved to ${paths.tunnelHostname}`);

  // Step 4: install/reload launchd tunnel service
  title("4/4  Install launchd tunnel service");
  const doInstall = await askYesNo("Install/update the launchd service that runs ngrok on login?", true);
  if (!doInstall) {
    console.log("  Skipped. Run manually:");
    console.log(`    ngrok http --url=${domain} 3737`);
    return;
  }

  try {
    execSync("npm run install-bg", { stdio: "inherit" });
  } catch {
    console.log("  install-bg failed. Run manually: npm run install-bg");
    return;
  }

  // Result
  console.log("");
  hr();
  console.log("  ✓ Stable ngrok tunnel ready.");
  console.log("");
  console.log("  Your endpoints are now:");
  console.log(`    Webhook:  https://${domain}/webhook/<token>/...`);
  console.log(`    MCP:      https://${domain}/mcp/<MCP_BEARER_TOKEN>`);
  console.log("");
  console.log("  These URLs survive reboots. Update your Claude.ai Custom Connector");
  console.log("  + phone Shortcut once with these URLs — done for good.");
  console.log("");
  console.log("  Get the full URLs anytime: npx cibus-wolt webhook-url");
  hr();
}

async function promptAndStoreToken(): Promise<void> {
  const token = (await ask("Paste your ngrok authtoken here")).trim();
  if (!token) {
    console.log("  Empty — skipping.");
    return;
  }
  try {
    execSync(`ngrok config add-authtoken ${token}`, { stdio: "ignore" });
    console.log("  ✓ ngrok authtoken stored in ngrok's config");
  } catch (e) {
    console.log(`  ⚠ Failed to store token: ${e instanceof Error ? e.message : String(e)}`);
  }
}
