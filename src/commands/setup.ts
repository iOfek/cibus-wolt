/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir, paths } from "../paths.ts";
import { binaryExists, claudeDesktopConfigPath, findChrome, findOnPath, openUrl } from "../platform.ts";
import { bothServicesInstalled, restartMcpService } from "../services.ts";

/**
 * Interactive setup. Four entry points, each owning a slice of the wizard:
 *  - runSetupCommand()                 — main wizard (Code + Desktop + phone at end)
 *  - runClaudeCodeMcpCommand()         — Claude Code MCP install only
 *  - runClaudeDesktopMcpCommand()      — Claude Desktop MCP install only
 *  - runPhoneSetupCommand()            — phone access (Custom Connector + tunnel)
 *
 * All prompts are editable — existing values become the default. Enter to keep;
 * type a new value to change; type `-` to clear. Re-runnable.
 */

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
  // Re-prompt on unrecognized input rather than silently treating it as "no".
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = (await ask(`${prompt} (${def})`)).toLowerCase();
    if (ans === "") return defaultYes;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    console.log(`  Please answer y or n (got: "${ans}").`);
  }
}

async function askChoice(prompt: string, options: string[], defaultOption: string): Promise<string> {
  const list = options.map((o) => (o === defaultOption ? `[${o}]` : o)).join(" / ");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = await ask(`${prompt} (${list})`, defaultOption);
    if (options.includes(ans)) return ans;
    console.log(`  Pick one of: ${options.join(", ")}.`);
  }
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
  env.MIN_AMOUNT = await ask("Minimum balance to bother draining (₪)", env.MIN_AMOUNT || "10");
  env.MAX_SPEND = await ask("Max single-run spend (₪, sanity cap)", env.MAX_SPEND || "1200");
}

async function stepClaudeCode(): Promise<void> {
  title("Claude Code MCP (optional)");
  console.log("  Adds cibus-wolt as an MCP server in Claude Code (~/.claude.json),");
  console.log("  so you can drive drains from any Claude Code session.");
  console.log("  Note: Claude Code has no built-in Gmail — Cibus OTPs will use whatever");
  console.log("  delivery you picked above (gmail/webhook/terminal).");
  console.log("");

  if (!binaryExists("claude")) {
    console.log("  ⚠ `claude` CLI not on PATH. Skipping Claude Code MCP install.");
    console.log("  Install from https://claude.ai/download, then run: cibus-wolt claude-code-mcp");
    return;
  }

  const add = await askYesNo("Add cibus-wolt to Claude Code (CLI)?", true);
  if (add) await setupClaudeCode();
}

async function claudeDesktopInstalled(): Promise<boolean> {
  // Treat the existence of the parent directory as "installed" — the config
  // file may not exist on a fresh install, but the dir is created when the app
  // first launches. False positive risk is acceptable since we ask before adding.
  try {
    await fs.access(path.dirname(claudeDesktopConfigPath()));
    return true;
  } catch {
    return false;
  }
}

async function setupClaudeCode(): Promise<void> {
  const claudeBin = findOnPath("claude");
  if (!claudeBin) {
    console.log("  ⚠ `claude` CLI not on PATH. Install Claude Code: https://claude.ai/download");
    console.log("  Then re-run: cibus-wolt claude-code-mcp");
    return;
  }

  const projectAbs = path.resolve(".");
  const nodeBin = findOnPath("node") ?? process.execPath;
  const mcpScript = path.join(projectAbs, "src/scripts/mcp-stdio.ts");

  // `claude mcp add` rejects duplicates — remove first for idempotency on re-run.
  spawnSync(claudeBin, ["mcp", "remove", "cibus-wolt", "--scope", "user"], { stdio: "ignore" });

  const addArgs = [
    "mcp", "add",
    "--scope", "user",
    "--transport", "stdio",
    "cibus-wolt",
    "--",
    nodeBin,
    "--import", "tsx/esm",
    mcpScript,
  ];
  const result = spawnSync(claudeBin, addArgs, { stdio: "inherit" });
  if (result.status === 0) {
    console.log("  ✓ Added cibus-wolt to Claude Code (~/.claude.json)");
    console.log("  In any Claude Code session: ask \"what's my cibus balance?\".");
    return;
  }
  console.log(`  ⚠ \`claude mcp add\` failed with exit ${result.status}.`);
  console.log("  Run manually:");
  console.log(`    ${claudeBin} ${addArgs.join(" ")}`);
}

async function setupClaudeDesktop(env: EnvMap): Promise<void> {
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
    console.log("  Now: quit + reopen Claude Desktop. In a chat, try: \"what's my cibus balance?\".");
    printDesktopGmailHint();
  } catch (e) {
    console.log(`  ⚠ Failed to update config: ${e instanceof Error ? e.message : String(e)}`);
    console.log("  Fall back to manual edit using the JSON printed above.");
  }
}

function printDesktopGmailHint(): void {
  // Can't programmatically verify Claude Desktop's connector state, and the
  // user-driven end-to-end test we tried earlier wasn't really automated.
  // Just a printed pointer — the first real drain is the natural validator.
  console.log("");
  console.log("  Tip — enable Claude Desktop's Gmail connector for unattended OTPs:");
  console.log("    Claude menu → Settings → Connectors → Gmail → Connect");
  console.log("  Without it, Claude will ask you to type the OTP in chat each time.");
  console.log("  (Backend Gmail OAuth — picked earlier in OTP delivery — also works,");
  console.log("  whichever responds first wins.)");
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
  if (openBrowser) openUrl("https://claude.ai/customize/connectors");

  console.log("");
  console.log("  Steps in the Claude.ai form:");
  console.log("    1. Click 'Add custom connector'");
  console.log("    2. Paste Name + URL above; leave OAuth fields empty");
  console.log("    3. Click 'Add' — Claude probes the server and lists 8 tools");
  console.log("    4. In a new chat → Tools menu → toggle on 'Cibus-Wolt'");
  console.log("    5. Ask: \"what's my cibus balance?\"");
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
  console.log("  First run prompts a manual Wolt login; subsequent runs reuse the session cookie.");
}

async function stepWebhook(env: EnvMap): Promise<void> {
  title("Phone webhook");
  console.log("  HTTP endpoints your phone Shortcut POSTs to, exposed via ngrok or devtunnel.");
  console.log("  Lets you trigger drains + deliver OTPs from your phone.");
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
  console.log("  Phone Shortcut setup (iOS) — required for OTP delivery:");
  console.log("    OTP: Automation → Message (filter Pluxee + 'קוד האימות')");
  console.log("         → Get Contents of URL (POST)");
  console.log(`         → https://<your-ngrok-domain>/webhook/<token>/otp`);
  console.log("         → Body JSON: {\"code\": <Message>}  (server extracts digits)");
  console.log("  Full step-by-step in README, section 'CLI + phone webhook (ngrok)'.");
  console.log("  Get the exact URLs anytime: npx cibus-wolt webhook-url");

  await testOtpShortcutWebhook(env);
}

async function testOtpShortcutWebhook(env: EnvMap): Promise<void> {
  console.log("");
  const doTest = await askYesNo("Test the OTP Shortcut end-to-end now? (we trigger the SMS for you)", true);
  if (!doTest) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await withSilencedLogger(() => runWebhookOtpTest(env));
    if (ok) return;
    const retry = await askYesNo("Retry the test? (fix the Shortcut, then come back)", true);
    if (!retry) {
      console.log("  Skipping. Re-test later with: npx cibus-wolt webhook-url + manually trigger.");
      return;
    }
  }
}

async function runWebhookOtpTest(env: EnvMap): Promise<boolean> {
  let token: string;
  let hostname: string;
  try {
    token = (await fs.readFile(paths.webhookToken, "utf8")).trim();
    hostname = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
  } catch {
    console.log("  ⚠ Webhook token or tunnel hostname missing — can't test.");
    return false;
  }
  if (!token || !hostname) {
    console.log("  ⚠ Webhook token or tunnel hostname empty — can't test.");
    return false;
  }
  const baseUrl = `https://${hostname}/webhook/${token}`;

  console.log("");
  console.log("  Make sure the OTP Automation in Shortcuts is saved and 'Run After");
  console.log("  Confirmation' is OFF — otherwise iOS will silently swallow it.");
  console.log("");

  const fetchOtp = async (since: Date): Promise<string> => {
    const sinceMs = since.getTime();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/last_otp?since=${sinceMs}`);
        if (res.ok) {
          const json = (await res.json()) as { last?: { code: string; receivedAt: number } | null };
          if (json.last) return json.last.code;
        }
      } catch {
        /* will retry */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("Timed out waiting for an OTP POST after 90s");
  };

  const result = await triggerCibusSmsAndSaveProfile(env, fetchOtp);
  if (result.ok) {
    console.log(`  ✓ OTP received via webhook: ${result.code}`);
    console.log("  iOS Shortcut → ngrok → server round-trip works.");
    console.log(`  ✓ Cibus profile saved at ${paths.chromeProfileCibus} — first drain skips login.`);
    return true;
  }
  console.log("  Likely causes:");
  console.log("    • iOS Shortcut not enabled, or 'Run After Confirmation' still on");
  console.log("    • Shortcut filter doesn't match the actual SMS sender / wording");
  console.log("    • ngrok hostname in Shortcut differs from current one");
  console.log(`  Verify the URL: ${baseUrl}/otp`);
  return false;
}

/**
 * Run `fn` with the pino logger silenced. Pino's pretty transport interleaves
 * with the wizard's clean console.log output during shortcut tests; silencing
 * for the test window keeps the wizard readable.
 */
async function withSilencedLogger<T>(fn: () => Promise<T>): Promise<T> {
  const { logger } = await import("../logger.ts");
  const prev = logger.level;
  logger.level = "silent";
  try {
    return await fn();
  } finally {
    logger.level = prev;
  }
}

/**
 * Shared between webhook + Gmail Shortcut tests: opens Cibus in the real
 * chrome-profile-cibus (wiped first to force MFA), uses the OTP-only login
 * tab to provoke an SMS, waits for `fetchOtp` to deliver the code from
 * Gmail or the webhook, submits the code to complete the login, then closes.
 * Side effect: the profile is now logged in, so the first real drain skips
 * the login step entirely.
 */
async function triggerCibusSmsAndSaveProfile(
  env: EnvMap,
  fetchOtp: (since: Date) => Promise<string>,
): Promise<{ ok: boolean; code?: string }> {
  if (!env.CIBUS_USER) {
    console.log("  ⚠ CIBUS_USER missing from .env — can't auto-trigger SMS. Skipping.");
    return { ok: false };
  }
  console.log("  Opening Cibus (OTP tab) — Chrome stays open until OTP arrives, then submits it.");
  try {
    const { triggerCibusSmsAndCompleteLogin } = await import("../cibus.ts");
    const result = await triggerCibusSmsAndCompleteLogin(env.CIBUS_USER, fetchOtp);
    if (!result.ok) {
      console.log(`  ✗ ${result.reason}`);
      return { ok: false, code: result.code };
    }
    return { ok: true, code: result.code };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ Failed: ${msg}`);
    return { ok: false };
  }
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
  console.log("  Polls your Gmail for the Cibus OTP email (subject 'cibus-otp', forwarded");
  console.log("  by your iOS Shortcut). Fully unattended local OTP delivery.");
  console.log("");
  console.log("  One-time GCP project setup: https://console.cloud.google.com");
  console.log("  1) New project → enable Gmail API");
  console.log("  2) OAuth consent screen → External → add yourself as Test User, scope gmail.readonly");
  console.log("  3) Credentials → Create OAuth Client ID → Desktop app");
  console.log("");

  const envPath = path.join(paths.dir, ".env");
  let authedClient: import("google-auth-library").OAuth2Client | null = null;
  // Loop until we have credentials that successfully complete the OAuth flow
  // and read the user's Gmail profile. Wrong client ID/secret or a closed
  // consent browser would otherwise only surface during a real drain.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    env.GOOGLE_CLIENT_ID = await ask("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID);
    env.GOOGLE_CLIENT_SECRET = await ask("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET);
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      console.log("  ⚠ Both ID and secret are required for Gmail polling. Re-enter or Ctrl-C to skip.");
      continue;
    }
    // Persist before triggering the browser — token.json + refresh-token live
    // separately, but config.ts reads credentials from .env.
    await writeEnvFile(envPath, env);

    console.log("");
    console.log("  Verifying OAuth: a browser tab will open for Google consent.");
    console.log("  Pick the Gmail account that receives Cibus mail.");
    try {
      const { getAuthClient } = await import("../gmail.ts");
      const { google } = await import("googleapis");
      const client = await getAuthClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
      const gmail = google.gmail({ version: "v1", auth: client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      console.log(`  ✓ Gmail OAuth verified — authorized as ${profile.data.emailAddress}`);
      authedClient = client;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ Gmail OAuth failed: ${msg}`);
      // Wipe any stale cached token so the retry forces a fresh consent flow
      // rather than re-trying a broken refresh token.
      await fs.rm(paths.token, { force: true });
      const retry = await askYesNo("  Re-enter credentials and retry?", true);
      if (!retry) {
        console.log("  Skipping Gmail verification. The next drain will retry the consent flow.");
        return;
      }
    }
  }

  console.log("");
  console.log("  Cibus OTPs arrive as SMS — Gmail polling can't see them directly.");
  console.log("  To get fully unattended runs, set up the iOS Shortcut that forwards");
  console.log("  the Cibus OTP SMS to Gmail with subject 'cibus-otp'. See README,");
  console.log("  section: 'iOS Shortcut — forward Cibus SMS to Gmail'.");
  console.log("  Without it: you'll be prompted in the terminal for the 6-digit code.");

  if (authedClient) await testOtpShortcutGmail(env, authedClient);
}

async function testOtpShortcutGmail(env: EnvMap, auth: import("google-auth-library").OAuth2Client): Promise<void> {
  console.log("");
  const doTest = await askYesNo("Test the SMS→Gmail Shortcut end-to-end now? (we trigger the SMS for you)", true);
  if (!doTest) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await withSilencedLogger(() => runGmailOtpTest(env, auth));
    if (ok) return;
    const retry = await askYesNo("Retry the test? (fix the Shortcut, then come back)", true);
    if (!retry) {
      console.log("  Skipping. The drain itself will fall back to Gmail polling / terminal prompt.");
      return;
    }
  }
}

async function runGmailOtpTest(env: EnvMap, auth: import("google-auth-library").OAuth2Client): Promise<boolean> {
  console.log("");
  console.log("  Make sure the SMS→Gmail Automation in Shortcuts is saved and 'Run");
  console.log("  After Confirmation' is OFF — otherwise iOS will silently swallow it.");
  console.log("");

  const fetchOtp = async (since: Date): Promise<string> => {
    const { fetchCibusOtp } = await import("../gmail.ts");
    return await fetchCibusOtp({ auth, since, timeoutMs: 90_000, pollMs: 5_000 });
  };

  const result = await triggerCibusSmsAndSaveProfile(env, fetchOtp);
  if (result.ok) {
    console.log(`  ✓ OTP received via Gmail: ${result.code}`);
    console.log("  iOS Shortcut → Gmail → server round-trip works.");
    console.log(`  ✓ Cibus profile saved at ${paths.chromeProfileCibus} — first drain skips login.`);
    return true;
  }
  console.log("  Likely causes:");
  console.log("    • iOS Shortcut not enabled, or 'Run After Confirmation' still on");
  console.log("    • Shortcut filter doesn't match the actual SMS sender / wording");
  console.log("    • Email subject in the Shortcut isn't exactly 'cibus-otp'");
  console.log("    • Shortcut sends to a different Gmail than the one you authorized");
  return false;
}

async function stepWoltLogin(env: EnvMap): Promise<void> {
  title("Wolt login");
  console.log("  Wolt's bot detection rejects automated email submission, so we hand the");
  console.log("  browser to you for one manual login. The session cookie is saved to the");
  console.log("  Chrome profile and reused on every subsequent drain (auto-refreshed each");
  console.log("  run). When the cookie eventually expires, run `cibus-wolt wolt-login`.");
  console.log("");
  const doTest = await askYesNo("Open Chrome and log in to Wolt now?", true);
  if (!doTest) {
    console.log("  Skipping. Run `cibus-wolt wolt-login` later (or the first drain will prompt).");
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await runWoltLoginTest(env);
    if (ok) return;
    const retry = await askYesNo("Retry the Wolt login?", true);
    if (!retry) {
      console.log("  Skipping. Run `cibus-wolt wolt-login` later when you're ready.");
      return;
    }
  }
}

async function runWoltLoginTest(env: EnvMap): Promise<boolean> {
  console.log("  Opening Wolt login page in Chrome — sign in manually, then press Enter here...");
  try {
    const { acquireBrowser } = await import("../browser.ts");
    const { ensureWoltLoggedIn } = await import("../woltLogin.ts");
    const browser = await acquireBrowser();
    try {
      const page = browser.context.pages()[0] ?? (await browser.context.newPage());
      await ensureWoltLoggedIn({ page });
      console.log(`  ✓ Wolt session saved at ${paths.chromeProfile}`);
      return true;
    } finally {
      await browser.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${msg}`);
    return false;
  }
}

async function stepSmokeTest(): Promise<void> {
  title("Smoke test");
  const run = await askYesNo("Run `cibus-wolt status` to verify everything?", true);
  if (run) {
    try {
      execSync("npx cibus-wolt status", { stdio: "inherit" });
    } catch {
      console.log("  Status command failed — inspect the output above.");
    }
  }

  console.log("");
  const dry = await askYesNo("Run a dry-run drain now? (full flow except final payment confirm)", true);
  if (!dry) return;
  try {
    execSync("npx cibus-wolt run --dry-run", { stdio: "inherit" });
  } catch {
    console.log("  Dry-run errored — inspect the output above.");
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
  await stepOtpDelivery(env);

  await writeEnvFile(envPath, env);

  await stepWoltLogin(env);
  await stepSchedules();
  await stepSmokeTest();

  // Claude MCP + phone access at the very end — orchestration / remote-trigger
  // layers on top of a working drain. Both Claude Code and Claude Desktop are
  // suggested (independent configs); user can Y/n each. Phone access via
  // tunnel covers Claude.ai web/mobile and Desktop (Custom Connectors sync via
  // your Claude account).
  await stepClaudeCode();
  await stepClaudeDesktop(env);
  await stepPhoneAccess(env);

  await writeEnvFile(envPath, env);
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
// Detection helper + OTP delivery / phone-access steps
// ────────────────────────────────────────────────────────────────────────────

async function detectExisting(env: EnvMap): Promise<{
  claudeCodeConfigured: boolean;
  claudeDesktopConfigured: boolean;
  claudeWebConfigured: boolean;
  webhookConfigured: boolean;
  gmailConfigured: boolean;
}> {
  const hasTunnelHostname = await fs.access(paths.tunnelHostname).then(() => true).catch(() => false);
  const hasWebhookToken = await fs.access(paths.webhookToken).then(() => true).catch(() => false);
  let claudeDesktopConfigured = false;
  try {
    const cfg = await fs.readFile(claudeDesktopConfigPath(), "utf8");
    claudeDesktopConfigured = cfg.includes("cibus-wolt");
  } catch { /* none */ }
  let claudeCodeConfigured = false;
  try {
    const cfg = await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
    claudeCodeConfigured = cfg.includes("cibus-wolt");
  } catch { /* none */ }
  const claudeWebConfigured = Boolean(env.MCP_BEARER_TOKEN) && hasTunnelHostname;
  return {
    claudeCodeConfigured,
    claudeDesktopConfigured,
    claudeWebConfigured,
    webhookConfigured: hasWebhookToken && hasTunnelHostname,
    gmailConfigured: Boolean(env.GOOGLE_CLIENT_ID),
  };
}

async function stepOtpDelivery(env: EnvMap): Promise<void> {
  title("Cibus OTP delivery");
  console.log("  Cibus forces a re-auth occasionally — a 6-digit code SMS'd to your phone.");
  console.log("  We need that code on the laptop. (Wolt login is one-time manual via");
  console.log("  `cibus-wolt wolt-login` — the session cookie auto-refreshes on every drain.)");
  console.log("");

  const existing = await detectExisting(env);
  if (existing.webhookConfigured || existing.gmailConfigured) {
    console.log("  Already configured:");
    if (existing.webhookConfigured) console.log("    ✓ Phone webhook");
    if (existing.gmailConfigured) console.log("    ✓ Gmail OAuth");
    console.log("");
  }

  console.log("  Pick how the Cibus OTP gets to the laptop:");
  console.log("    gmail     —  iOS Shortcut forwards the OTP to Gmail, our tool polls Gmail for the forwarded OTP");
  console.log("                 One-time GCP OAuth setup.[~2 min one-time]");
  console.log("    webhook   — iOS Shortcut POSTs the OTP to us via ngrok/devtunnel");
  console.log("                 One-time ngrok/devtunnel setup. [~3 min one-time]");
  console.log("    terminal  — type the 6 digits when the wizard prompts. Zero setup. ");
  console.log("                 requires manual intervention every time. (stupid - makes the tool mostly useless)");
  console.log("");
  const otp = await askChoice(
    "How should we deliver the Cibus OTP?",
    ["gmail", "webhook", "terminal"],
    existing.gmailConfigured ? "gmail" : existing.webhookConfigured ? "webhook" : "terminal",
  );
  if (otp === "gmail") await stepGmail(env);
  else if (otp === "webhook") await stepWebhook(env);
  else console.log("  Skipping — you'll be prompted in the terminal during drains.");
}

async function stepPhoneAccess(env: EnvMap): Promise<void> {
  title("Phone access (Claude.ai mobile / web)");
  console.log("  Sets up an HTTP tunnel + Custom Connector so Claude.ai (web AND mobile)");
  console.log("  can drive cibus-wolt over the internet. Custom Connectors sync to Claude");
  console.log("  Desktop too via your Claude account — handy if you skipped the local stdio");
  console.log("  install for Desktop earlier. Claude Code is unaffected (separate registry).");
  console.log("");
  const proceed = await askYesNo("Set up phone access now? (ngrok/devtunnel + Claude.ai Custom Connector)", true);
  if (!proceed) {
    console.log("  Skipped. Add later: cibus-wolt phone-setup");
    return;
  }
  await setupClaudeWeb(env);
}

export async function runClaudeCodeMcpCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  console.log("");
  console.log("  cibus-wolt — Claude Code MCP install");

  if (!env.CIBUS_USER) {
    console.log("");
    console.log("  ⚠ Cibus credentials missing from ~/.cibus-wolt/.env.");
    console.log("    Run `cibus-wolt setup` first — the MCP server installs but won't");
    console.log("    function until creds are present.");
    process.exit(1);
  }

  await stepClaudeCode();
  printDone();
}

async function stepClaudeDesktop(env: EnvMap): Promise<void> {
  title("Claude Desktop MCP (optional)");
  console.log("  Adds cibus-wolt as an MCP server in Claude Desktop, so Desktop can drive");
  console.log("  drains. Independent from Claude Code — separate config file.");
  console.log("");

  if (!await claudeDesktopInstalled()) {
    console.log("  ⚠ Claude Desktop not detected. Skipping. Install from");
    console.log("    https://claude.ai/download, then run: cibus-wolt claude-desktop-mcp");
    return;
  }

  const add = await askYesNo("Add cibus-wolt to Claude Desktop?", true);
  if (add) await setupClaudeDesktop(env);
}

export async function runClaudeDesktopMcpCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  console.log("");
  console.log("  cibus-wolt — Claude Desktop MCP install");

  if (!env.CIBUS_USER) {
    console.log("");
    console.log("  ⚠ Cibus credentials missing from ~/.cibus-wolt/.env.");
    console.log("    Run `cibus-wolt setup` first — the MCP entry installs but won't");
    console.log("    function until creds are present.");
    process.exit(1);
  }

  await stepClaudeDesktop(env);
  await writeEnvFile(envPath, env);
  printDone();
}

export async function runPhoneSetupCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  console.log("");
  console.log("  cibus-wolt — phone access setup");

  if (!env.CIBUS_USER) {
    console.log("");
    console.log("  ⚠ Cibus credentials missing. Run `cibus-wolt setup` first.");
    process.exit(1);
  }

  const existing = await detectExisting(env);
  if (!existing.claudeCodeConfigured && !existing.claudeDesktopConfigured) {
    console.log("");
    console.log("  ⚠ No Claude client has cibus-wolt installed yet. Phone access is");
    console.log("    pointless without a Claude to drive it. Run one of:");
    console.log("      cibus-wolt claude-code-mcp        # Claude Code");
    console.log("      cibus-wolt claude-desktop-mcp     # Claude Desktop");
    process.exit(1);
  }

  await stepPhoneAccess(env);
  await writeEnvFile(envPath, env);
  printDone();
}

