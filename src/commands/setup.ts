/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";
import { claudeDesktopConfigPath, findChrome, findOnPath, openUrl } from "../platform.ts";
import { bothServicesInstalled, restartMcpService } from "../services.ts";

/**
 * Interactive setup.
 *
 * Two entry points:
 *  - runSetupCommand()        — full wizard (Claude first, then webhook opt-in, etc.)
 *  - runClaudeSetupCommand()  — Claude MCP only (skip webhook prompts)
 *
 * All prompts are editable — existing values are shown as the default. Press
 * Enter to keep; type a new value to change; type `-` to clear. Re-runnable.
 */

type Mode = "full" | "claude-only";

interface EnvMap {
  [key: string]: string;
}

async function readEnvFile(file: string): Promise<EnvMap> {
  try {
    const text = await fs.readFile(file, "utf8");
    const out: EnvMap = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnvFile(file: string, env: EnvMap): Promise<void> {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`);
  await fs.writeFile(file, lines.join("\n") + "\n", { mode: 0o600 });
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

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue !== undefined ? ` [${defaultValue || "(empty)"}]` : "";
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    if (answer === "") return defaultValue ?? "";
    if (answer === "-") return ""; // sentinel: clear the value
    return answer;
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

async function askChoice(prompt: string, options: string[], defaultOption: string): Promise<string> {
  const list = options.map((o) => (o === defaultOption ? `[${o}]` : o)).join(" / ");
  const ans = await ask(`${prompt} (${list})`, defaultOption);
  return options.includes(ans) ? ans : defaultOption;
}

// binaryExists / findChrome live in src/platform.ts.

// ────────────────────────────────────────────────────────────────────────────
// Step functions — each step is idempotent and re-runnable.
// Each prompt shows current value as default; user edits or keeps.
// ────────────────────────────────────────────────────────────────────────────

async function stepCredentials(env: EnvMap): Promise<void> {
  title("Cibus + Wolt credentials");
  console.log("  Press Enter to keep a value, type a new one to change, or `-` to clear.");
  console.log("  Saved to ~/.cibus-wolt/.env (mode 0600). Passwords echo to the terminal");
  console.log("  — don't share your screen during setup.");
  console.log("");

  env.CIBUS_USER = await ask("Cibus username / email / phone", env.CIBUS_USER);
  env.CIBUS_PASS = await ask("Cibus permanent password", env.CIBUS_PASS);
  env.CIBUS_COMPANY = await ask("Company (as shown in Cibus, usually lowercase)", env.CIBUS_COMPANY || "microsoft");
  env.CIBUS_AUTH_MODE = await askChoice(
    "Cibus auth mode in the Wolt-embedded popup",
    ["password", "otp"],
    (env.CIBUS_AUTH_MODE as "password" | "otp") || "password",
  );
  env.WOLT_EMAIL = await ask("Wolt login email", env.WOLT_EMAIL);
  env.MIN_AMOUNT = await ask("Minimum balance to bother draining (₪)", env.MIN_AMOUNT || "10");
  env.MAX_SPEND = await ask("Max single-run spend (₪, sanity cap)", env.MAX_SPEND || "1200");
}

async function stepClaude(env: EnvMap, mode: Mode): Promise<boolean> {
  title("Claude MCP");
  if (mode === "claude-only") {
    console.log("  Configuring the MCP connector for Claude.");
  } else {
    console.log("  Claude's Gmail integration will deliver Cibus OTPs + Wolt magic-links,");
    console.log("  so no phone Shortcut is needed.");
  }
  console.log("");

  const which = await askChoice("Which Claude client?", ["desktop", "web", "both"], "desktop");

  if (which === "desktop" || which === "both") await setupClaudeDesktop();
  if (which === "web" || which === "both") await setupClaudeWeb(env);
  return true;
}

async function setupClaudeDesktop(): Promise<void> {
  const configPath = claudeDesktopConfigPath();
  const projectAbs = path.resolve(".");
  const nodeBin = findOnPath("node") ?? process.execPath;

  const entry = {
    command: nodeBin,
    args: ["--import", "tsx/esm", path.join(projectAbs, "src/scripts/mcp-stdio.ts")],
    cwd: projectAbs,
  };

  console.log("");
  const autoEdit = await askYesNo(
    `Automatically add cibus-wolt to ${configPath}?\n  (Safe — merges into existing mcpServers; makes a .bak file first.)`,
    true,
  );

  if (!autoEdit) {
    console.log("\n  Paste this into the file manually:");
    console.log(
      JSON.stringify({ mcpServers: { "cibus-wolt": entry } }, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    console.log("\n  Then quit + reopen Claude Desktop.");
    return;
  }

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, "utf8");
      existing = JSON.parse(raw);
      await fs.writeFile(configPath + ".bak", raw, "utf8");
      console.log(`  ✓ Backed up existing config → ${configPath}.bak`);
    } catch {
      /* no existing file */
    }
    const servers = (existing.mcpServers && typeof existing.mcpServers === "object" ? existing.mcpServers : {}) as Record<string, unknown>;
    servers["cibus-wolt"] = entry;
    const next = { ...existing, mcpServers: servers };
    await fs.writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
    console.log(`  ✓ Added cibus-wolt to ${configPath}`);
    console.log("  Now: quit + reopen Claude Desktop. The cibus-wolt tools appear under");
    console.log("  the connectors menu. In a chat, try: 'call the status tool'.");
  } catch (e) {
    console.log(`  ⚠ Failed to update config: ${e instanceof Error ? e.message : String(e)}`);
    console.log("  Fall back to manual edit using the JSON printed above.");
  }
}

async function prepareRemoteMcp(env: EnvMap, clientName: string): Promise<string | null> {
  const existingToken = env.MCP_BEARER_TOKEN;
  const keepToken = existingToken ? await askYesNo("  Keep existing MCP_BEARER_TOKEN?", true) : false;
  if (!keepToken) {
    env.MCP_BEARER_TOKEN = crypto.randomBytes(32).toString("hex");
    console.log("  ✓ Generated fresh MCP_BEARER_TOKEN");
  }
  const token: string = env.MCP_BEARER_TOKEN ?? "";
  if (!token) {
    console.log(`  ⚠ No MCP token set — aborting ${clientName} setup.`);
    return null;
  }

  // Ensure the .env has the token persisted before services start
  const envPath = path.join(paths.dir, ".env");
  const currentEnv = await readEnvFile(envPath);
  currentEnv.MCP_BEARER_TOKEN = token;
  await writeEnvFile(envPath, currentEnv);

  // Remote clients need a stable public URL — require ngrok domain
  await ensureTunnel();

  // Ensure background services exist — otherwise there's no tunnel URL to show
  const servicesLoaded = bothServicesInstalled();

  if (!servicesLoaded) {
    const doInstall = await askYesNo(
      `  Background services (server + ngrok) not running. Install them now?\n  (Required to get a public URL for ${clientName} to reach.)`,
      true,
    );
    if (doInstall) {
      try {
        execSync("npm run install-bg", { stdio: "inherit" });
      } catch {
        console.log("  install-bg failed. Retry later: `npm run install-bg`");
        return null;
      }
    } else {
      console.log("  Skipping — you can install the services later with `npm run install-bg`.");
      return null;
    }
  } else if (!keepToken) {
    console.log("  Restarting services to pick up the new token...");
    restartMcpService();
  }

  // Wait for the tunnel URL to appear in the log
  const fullUrl = await waitForTunnelUrl(token);
  if (!fullUrl) {
    console.log("  Timed out waiting for tunnel URL. Check with `npx cibus-wolt webhook-url`.");
    return null;
  }
  return fullUrl;
}

async function setupClaudeWeb(env: EnvMap): Promise<void> {
  const fullUrl = await prepareRemoteMcp(env, "Claude.ai");
  if (!fullUrl) return;

  console.log("");
  hr();
  console.log("  CLAUDE.AI CUSTOM CONNECTOR — paste these exact values:");
  console.log("");
  console.log(`    Name:        Cibus-Wolt`);
  console.log(`    URL:         ${fullUrl}`);
  console.log(`    OAuth Client ID / Secret: (leave blank)`);
  console.log("");
  hr();

  const openBrowser = await askYesNo("Open Claude.ai Connectors page now?", true);
  if (openBrowser) openUrl("https://claude.ai/settings/connectors");

  console.log("");
  console.log("  Steps in the Claude.ai form:");
  console.log("    1. Click 'Add custom connector'");
  console.log("    2. Paste Name + URL above; leave OAuth fields empty");
  console.log("    3. Click 'Add' — Claude probes the server and lists 8 tools");
  console.log("    4. In a new chat → Tools menu → toggle on 'Cibus-Wolt'");
  console.log("    5. Ask: 'call the status tool'");
  console.log("");
  console.log("  Current URL anytime:  npx cibus-wolt webhook-url");
  console.log("");
  await ask("  Press Enter when you've registered the connector (or to skip)");
}

async function waitForTunnelUrl(token: string): Promise<string | null> {
  // With ngrok + a reserved static domain, the URL is known up front —
  // we just need ~/.cibus-wolt/tunnel-hostname to exist.
  try {
    const domain = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
    if (domain) return `https://${domain}/mcp/${token}`;
  } catch {
    /* not set */
  }
  return null;
}

async function stepChromeCheck(): Promise<void> {
  title("Chrome");
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.log("  ⚠ Google Chrome not found. Install from https://www.google.com/chrome/");
    console.log("  (Playwright will fall back to bundled Chromium, which trips Wolt bot detection more easily.)");
    return;
  }
  console.log(`  ✓ Found Chrome at ${chromeBin}`);
  console.log("  Each drain launches Chrome with a dedicated profile at");
  console.log(`    ${paths.chromeProfile}`);
  console.log("  First run prompts a Wolt magic-link login; subsequent runs reuse the session.");
}

async function stepWebhook(env: EnvMap, claudeWasSetup: boolean): Promise<void> {
  title("Phone webhook");
  console.log("  HTTP endpoints your phone Shortcut POSTs to, exposed via ngrok.");
  console.log("  Lets you trigger drains + deliver OTPs from your phone.");
  if (claudeWasSetup) {
    console.log("");
    console.log("  (Note: you've also set up Claude — the webhook is an alternative/additional");
    console.log("  remote-trigger path. Either or both can be active simultaneously.)");
  }
  console.log("");

  // Webhook token
  try {
    const existing = (await fs.readFile(paths.webhookToken, "utf8")).trim();
    if (existing) {
      const keep = await askYesNo("  Keep existing webhook token?", true);
      if (!keep) {
        await fs.writeFile(paths.webhookToken, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
        console.log("  ✓ Rotated webhook token");
      }
    } else throw new Error("empty");
  } catch {
    await fs.writeFile(paths.webhookToken, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    console.log("  ✓ Generated fresh webhook token");
  }

  // Require ngrok static domain — no rotating URLs
  await ensureTunnel();

  const doLaunchd = await askYesNo("Install background services (server + ngrok) for auto-start on login?", true);
  if (doLaunchd) {
    try {
      execSync("npm run install-bg", { stdio: "inherit" });
    } catch {
      console.log("  install-bg failed. Retry later: `npm run install-bg`");
      return;
    }
  } else {
    console.log("  Skipped. Run manually later: `npm run install-bg`");
  }

  console.log("");
  console.log("  Phone Shortcut setup (iOS):");
  console.log("    Shortcuts → Automation → 'When I get a text from Pluxee'");
  console.log("    → Extract 6-digit code → Get Contents of URL (POST) →");
  console.log(`       https://<your-ngrok-domain>/webhook/<token>/otp`);
  console.log("    → Body JSON: {\"code\": <extracted>}");
  console.log("  Same skeleton for Wolt mail → /webhook/<token>/magic_link");
  console.log("  Get the exact URLs:  npx cibus-wolt webhook-url");
}

async function ensureTunnel(): Promise<void> {
  let configured = "";
  let kind = "ngrok";
  try {
    configured = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
  } catch {
    /* none yet */
  }
  try {
    const k = (await fs.readFile(paths.tunnelKind, "utf8")).trim();
    if (k === "ngrok" || k === "devtunnel") kind = k;
  } catch {
    /* default ngrok */
  }
  if (configured) {
    console.log(`  ✓ Existing ${kind} tunnel: ${configured}`);
    const keep = await askYesNo("  Keep it?", true);
    if (keep) return;
  }
  console.log("  A stable public URL is required so it doesn't change on reboot.");
  console.log("  Two providers supported:");
  console.log("    ngrok      — default. Free static *.ngrok-free.app domain.");
  console.log("    devtunnel  — Microsoft Azure Dev Tunnels. Use if ngrok is blocked");
  console.log("                 (e.g. on a Microsoft corporate network).");
  console.log("");
  const provider = await askChoice("Tunnel provider?", ["ngrok", "devtunnel"], kind);
  if (provider === "devtunnel") {
    const { runDevtunnelSetupCommand } = await import("./devtunnel-setup.ts");
    await runDevtunnelSetupCommand();
    return;
  }
  const { runNgrokSetupCommand } = await import("./ngrok-setup.ts");
  await runNgrokSetupCommand();
}

async function stepGmail(env: EnvMap): Promise<void> {
  title("Gmail OAuth");
  console.log("  Polls your Gmail for the Cibus OTP email (subject 'cibus-otp') and the");
  console.log("  Wolt login email. Fully unattended local runs.");
  console.log("");
  console.log("  One-time GCP project setup: https://console.cloud.google.com");
  console.log("  1) New project → enable Gmail API");
  console.log("  2) OAuth consent screen → External → add yourself as Test User, scope gmail.readonly");
  console.log("  3) Credentials → Create OAuth Client ID → Desktop app");
  console.log("");
  env.GOOGLE_CLIENT_ID = await ask("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID);
  env.GOOGLE_CLIENT_SECRET = await ask("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET);
}

async function stepWoltLogin(): Promise<void> {
  title("First Wolt login");
  console.log("  The first real `cibus-wolt run` opens Chrome with its dedicated profile");
  console.log("  and walks through the Wolt magic-link login (Gmail, webhook, MCP, or");
  console.log("  stdin — whichever input source you've configured).");
  console.log("");
  console.log("  Nothing to do here during setup. The next drain handles it.");
}

async function stepSmokeTest(): Promise<void> {
  title("Smoke test");
  const run = await askYesNo("Run `cibus-wolt status` to verify everything?", true);
  if (!run) return;
  try {
    execSync("npx cibus-wolt status", { stdio: "inherit" });
  } catch {
    console.log("  Status command failed — inspect the output above.");
  }
}

function printDone(): void {
  console.log("");
  hr();
  console.log("  ✓ Setup complete.");
  console.log("");
  console.log("  Next steps:");
  console.log("    npx cibus-wolt run --dry-run    # smoke test the full flow");
  console.log("    npx cibus-wolt run              # real drain");
  console.log("    npx cibus-wolt status           # phase + last-run status");
  console.log("    npx cibus-wolt webhook-url      # phone webhook URL (if configured)");
  console.log("");
  console.log("  Re-run `cibus-wolt setup` anytime to edit values.");
  hr();
}

// ────────────────────────────────────────────────────────────────────────────
// Entry points
// ────────────────────────────────────────────────────────────────────────────

export async function runSetupCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  console.log("");
  console.log("  cibus-wolt — interactive setup");
  console.log("  Ctrl-C to abort. Re-runnable — existing values become the defaults.");

  await stepCredentials(env);
  await writeEnvFile(envPath, env);
  console.log(`  ✓ Saved to ${envPath}`);

  await stepChromeCheck();

  const strategy = await stepStrategy(env);

  // Order matters: Claude MCP is offered first so its answer can turn off the
  // webhook prompt (Claude covers the same need via its Gmail integration).
  const claudeWasSetup = strategy.useClaude ? await stepClaude(env, "full") : false;
  if (strategy.useWebhook) await stepWebhook(env, claudeWasSetup);
  if (strategy.useGmail) await stepGmail(env);

  await writeEnvFile(envPath, env);

  await stepSchedules();
  await stepWoltLogin();
  await stepSmokeTest();
  printDone();
}

async function stepSchedules(): Promise<void> {
  title("Drain schedules (optional)");
  console.log("  Recurring drains that fire automatically while the background service runs.");
  console.log("  Pick a cadence matching your Cibus reset, add one or more schedules.");
  console.log("  Can be edited later with: cibus-wolt schedule <sub>");
  console.log("");
  const proceed = await askYesNo("Configure schedules now?", true);
  if (!proceed) {
    console.log("  Skipped. Add later: cibus-wolt schedule add");
    return;
  }
  const { runScheduleSetupStep } = await import("./schedule.ts");
  await runScheduleSetupStep();
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy explainer — shows trade-offs + current state, recommends a path.
// ────────────────────────────────────────────────────────────────────────────

interface Strategy {
  useClaude: boolean;
  useWebhook: boolean;
  useGmail: boolean;
}

async function detectExisting(env: EnvMap): Promise<{
  claudeConfigured: boolean;
  webhookConfigured: boolean;
  gmailConfigured: boolean;
}> {
  const hasTunnelHostname = await fs.access(paths.tunnelHostname).then(() => true).catch(() => false);
  const hasWebhookToken = await fs.access(paths.webhookToken).then(() => true).catch(() => false);
  // Claude Desktop: check for claude_desktop_config.json containing cibus-wolt
  let claudeDesktop = false;
  try {
    const cfg = await fs.readFile(claudeDesktopConfigPath(), "utf8");
    claudeDesktop = cfg.includes("cibus-wolt");
  } catch { /* none */ }
  const claudeWeb = Boolean(env.MCP_BEARER_TOKEN) && hasTunnelHostname;
  return {
    claudeConfigured: claudeDesktop || claudeWeb,
    webhookConfigured: hasWebhookToken && hasTunnelHostname,
    gmailConfigured: Boolean(env.GOOGLE_CLIENT_ID),
  };
}

async function stepStrategy(env: EnvMap): Promise<Strategy> {
  title("How should we get OTP + magic-link into the tool?");
  console.log("  Two things may need to be fed to the automation occasionally:");
  console.log("    • Cibus SMS OTP (6-digit code, when re-auth is forced)");
  console.log("    • Wolt magic-link URL (login email, after session expiry)");
  console.log("");
  console.log("  Four possible sources. First to respond wins; you can use multiple.");
  console.log("");
  console.log("    (a) Terminal prompt          — works only when you're at laptop. Zero setup.");
  console.log("    (b) Gmail OAuth (polling)    — requires Gmail + one-time GCP project.");
  console.log("    (c) Phone webhook (ngrok)    — requires ngrok free signup + iOS Shortcut.");
  console.log("    (d) Claude MCP               — Claude's own Gmail integration delivers them.");
  console.log("                                   Claude.ai web also needs ngrok.");
  console.log("");

  const existing = await detectExisting(env);
  if (existing.claudeConfigured || existing.webhookConfigured || existing.gmailConfigured) {
    console.log("  You already have:");
    if (existing.claudeConfigured) console.log("    ✓ Claude MCP");
    if (existing.webhookConfigured) console.log("    ✓ Phone webhook (ngrok)");
    if (existing.gmailConfigured) console.log("    ✓ Gmail OAuth");
    console.log("");
  }

  const usesClaude = await askYesNo("Do you use Claude to trigger drains (desktop or web)?", existing.claudeConfigured || false);
  let claudeHasGmail = false;
  if (usesClaude) {
    claudeHasGmail = await askYesNo(
      "  …and does your Claude have the Gmail integration connected?\n  (Lets Claude read the Wolt magic-link email + Cibus OTP if forwarded to Gmail.)",
      true,
    );
  }
  const wantsRemote = await askYesNo(
    "Do you want to trigger drains from your phone / away from the laptop?",
    existing.webhookConfigured || existing.claudeConfigured || false,
  );
  const hasGmail = usesClaude && claudeHasGmail
    ? false // no need for separate Gmail OAuth — Claude's Gmail covers signal delivery
    : await askYesNo(
        "Set up Gmail OAuth (one-time GCP client) for OTP/magic-link polling on our side?",
        existing.gmailConfigured || false,
      );

  // Derive recommendation
  let useClaude = usesClaude;
  let useWebhook = false;
  let useGmail = hasGmail;
  let rationale = "";

  if (usesClaude && claudeHasGmail) {
    rationale = "Using Claude (Gmail connected) — Claude reads the Wolt magic-link email directly.";
    rationale += "\n  Cibus OTPs arrive as SMS. You either type the 6 digits in chat when Claude asks,";
    rationale += "\n  or add an iOS Shortcut that forwards Cibus SMS to Gmail (subject 'cibus-otp').";
    if (wantsRemote) rationale += "\n  Web Claude.ai also needs ngrok, which the Claude step handles.";
  } else if (usesClaude && !claudeHasGmail) {
    useWebhook = true;
    rationale = "Using Claude (no Gmail) — Claude orchestrates, but signals can't go through Gmail.";
    rationale += "\n  Turning ON the phone webhook — iOS Shortcuts forward Cibus SMS + Wolt email";
    rationale += "\n  to ngrok, which our server feeds back to Claude via the same input bus.";
  } else if (wantsRemote) {
    useWebhook = true;
    rationale = "No Claude + want remote trigger → phone webhook via ngrok is the best fit.";
    rationale += "\n  iOS Shortcuts forward both Cibus SMS and Wolt mail to the webhook.";
  } else if (hasGmail) {
    rationale = "Local-only + Gmail available → Gmail polling gives fully-unattended local runs.";
    rationale += "\n  Needs an iOS Shortcut to forward Cibus SMS OTPs to Gmail. Wolt mail";
    rationale += "\n  hits Gmail natively so no extra routing for that one.";
  } else {
    rationale = "Local-only, no Gmail → terminal prompts work fine. No additional setup needed.";
    rationale += "\n  You'll read the Cibus OTP off your phone and type it in the terminal,";
    rationale += "\n  and paste the Wolt magic-link URL from your email when prompted.";
  }

  console.log("");
  console.log(`  Recommended: ${rationale}`);
  console.log("");
  const accept = await askYesNo("Accept the recommendation?", true);
  if (!accept) {
    console.log("  Override — choose each component:");
    useClaude = await askYesNo("  Configure Claude MCP?", useClaude);
    useWebhook = await askYesNo("  Configure phone webhook (ngrok)?", useWebhook);
    useGmail = await askYesNo("  Configure Gmail OAuth?", useGmail);
  }
  return { useClaude, useWebhook, useGmail };
}

export async function runClaudeSetupCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  console.log("");
  console.log("  cibus-wolt — Claude-only setup");
  console.log("  This configures only the Claude MCP connector. If you haven't");
  console.log("  set Cibus/Wolt credentials yet, run `cibus-wolt setup` first.");

  if (!env.CIBUS_USER || !env.WOLT_EMAIL) {
    console.log("");
    console.log("  ⚠ Credentials are missing from ~/.cibus-wolt/.env. The MCP server");
    console.log("  will still install, but won't work until you add them.");
  }

  await stepClaude(env, "claude-only");
  await writeEnvFile(envPath, env);
  console.log(`  ✓ Saved to ${envPath}`);
  printDone();
}

