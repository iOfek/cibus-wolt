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
import {
  blank, bold, bullet, choiceSuffix, cmd, cyan, defaultSuffix, dim, done,
  emphasis, failure, info, kv, note, numbered, plain, pressEnter, rule,
  section, subsection, success, val, warn, yesNoSuffix,
} from "../ui.ts";

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

const TOTAL_STEPS = 9;

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

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`  ${prompt}${defaultSuffix(defaultValue)}: `)).trim();
    if (answer === "") return defaultValue ?? "";
    if (answer === "-") return ""; // sentinel: clear the value
    return answer;
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  // Re-prompt on unrecognized input rather than silently treating it as "no".
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = (await askRaw(`${prompt}${yesNoSuffix(defaultYes)}`)).toLowerCase();
    if (ans === "") return defaultYes;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    warn(`Please answer y or n (got: "${ans}").`);
  }
}

async function askChoice(prompt: string, options: string[], defaultOption: string): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = (await askRaw(`${prompt}${choiceSuffix(options, defaultOption)}`)).trim();
    const value = ans === "" ? defaultOption : ans;
    if (options.includes(value)) return value;
    warn(`Pick one of: ${options.join(", ")}.`);
  }
}

/**
 * Like ask() but without the [default] suffix — used by askYesNo / askChoice
 * which build their own styled suffixes.
 */
async function askRaw(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`  ${prompt}: `)).trim();
  } finally {
    rl.close();
  }
}

// binaryExists / findChrome live in src/platform.ts.

// ────────────────────────────────────────────────────────────────────────────
// Step functions — each step is idempotent and re-runnable.
// Each prompt shows current value as default; user edits or keeps.
// ────────────────────────────────────────────────────────────────────────────

async function stepCredentials(env: EnvMap): Promise<void> {
  section("Cibus + Wolt credentials", {
    step: { n: 1, total: TOTAL_STEPS },
    subtitle: "Saved to ~/.cibus-wolt/.env (mode 0600). Re-runnable.",
  });
  note(`Press ${bold("Enter")} to keep a value, type a new one to change, or ${bold("-")} to clear.`);
  warn("Passwords echo to the terminal — don't share your screen during setup.");
  blank();

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
  section("Claude Code MCP (optional)", {
    step: { n: 7, total: TOTAL_STEPS },
    subtitle: "Drive drains from any Claude Code session via MCP.",
  });
  note("Claude Code has no built-in Gmail — Cibus OTPs will use whatever delivery");
  note("you picked earlier (gmail / webhook / terminal).");
  blank();

  if (!binaryExists("claude")) {
    warn(`${cmd("claude")} CLI not on PATH. Skipping Claude Code MCP install.`);
    note(`Install from https://claude.ai/download, then run: ${cmd("cibus-wolt claude-code-mcp")}`);
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
    warn(`${cmd("claude")} CLI not on PATH. Install Claude Code: https://claude.ai/download`);
    note(`Then re-run: ${cmd("cibus-wolt claude-code-mcp")}`);
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
    success(`Added cibus-wolt to Claude Code ${dim("(~/.claude.json)")}`);
    note(`In any Claude Code session: ask ${bold("\"what's my cibus balance?\"")}.`);
    return;
  }
  warn(`${cmd("claude mcp add")} failed with exit ${result.status}.`);
  note("Run manually:");
  plain(`  ${cmd(`${claudeBin} ${addArgs.join(" ")}`)}`);
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

  blank();
  note(`Target file: ${val(configPath)}`);
  note("Safe — merges into existing mcpServers; backs up to .bak first.");
  const autoEdit = await askYesNo("Automatically add cibus-wolt to Claude Desktop config?", true);

  if (!autoEdit) {
    blank();
    note("Paste this into the file manually:");
    console.log(
      JSON.stringify({ mcpServers: { "cibus-wolt": entry } }, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    blank();
    note("Then quit + reopen Claude Desktop.");
    return;
  }

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, "utf8");
      existing = JSON.parse(raw);
      await fs.writeFile(configPath + ".bak", raw, "utf8");
      success(`Backed up existing config → ${val(configPath + ".bak")}`);
    } catch {
      /* no existing file */
    }
    const servers = (existing.mcpServers && typeof existing.mcpServers === "object" ? existing.mcpServers : {}) as Record<string, unknown>;
    servers["cibus-wolt"] = entry;
    const next = { ...existing, mcpServers: servers };
    await fs.writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
    success(`Added cibus-wolt to ${val(configPath)}`);
    info(`Now ${emphasis("quit + reopen Claude Desktop")}. In a chat, try: ${bold("\"what's my cibus balance?\"")}`);
    printDesktopGmailHint();
  } catch (e) {
    failure(`Failed to update config: ${e instanceof Error ? e.message : String(e)}`);
    note("Fall back to manual edit using the JSON printed above.");
  }
}

function printDesktopGmailHint(): void {
  // Can't programmatically verify Claude Desktop's connector state, and the
  // user-driven end-to-end test we tried earlier wasn't really automated.
  // Just a printed pointer — the first real drain is the natural validator.
  blank();
  info(`Tip — enable Claude Desktop's Gmail connector for unattended OTPs:`);
  bullet(`${bold("Claude menu → Settings → Connectors → Gmail → Connect")}`);
  note("Without it, Claude will ask you to type the OTP in chat each time.");
  note("(Backend Gmail OAuth — picked earlier in OTP delivery — also works,");
  note(" whichever responds first wins.)");
}

async function prepareRemoteMcp(env: EnvMap, clientName: string): Promise<string | null> {
  const existingToken = env.MCP_BEARER_TOKEN;
  const keepToken = existingToken ? await askYesNo("Keep existing MCP_BEARER_TOKEN?", true) : false;
  if (!keepToken) {
    env.MCP_BEARER_TOKEN = crypto.randomBytes(32).toString("hex");
    success("Generated fresh MCP_BEARER_TOKEN");
  }
  const token: string = env.MCP_BEARER_TOKEN ?? "";
  if (!token) {
    failure(`No MCP token set — aborting ${clientName} setup.`);
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
    note(`Background services (server + ngrok) not running.`);
    note(`Required to get a public URL for ${val(clientName)} to reach.`);
    const doInstall = await askYesNo("Install them now?", true);
    if (doInstall) {
      try {
        execSync("npm run install-bg", { stdio: "inherit" });
      } catch {
        failure(`install-bg failed. Retry later: ${cmd("npm run install-bg")}`);
        return null;
      }
    } else {
      note(`Skipping — you can install the services later with ${cmd("npm run install-bg")}.`);
      return null;
    }
  } else if (!keepToken) {
    info("Restarting services to pick up the new token...");
    restartMcpService();
  }

  // Wait for the tunnel URL to appear in the log
  const fullUrl = await waitForTunnelUrl(token);
  if (!fullUrl) {
    failure(`Timed out waiting for tunnel URL. Check with ${cmd("npx cibus-wolt webhook-url")}.`);
    return null;
  }
  return fullUrl;
}

async function setupClaudeWeb(env: EnvMap): Promise<void> {
  const fullUrl = await prepareRemoteMcp(env, "Claude.ai");
  if (!fullUrl) return;

  subsection("Claude.ai Custom Connector — paste these exact values");
  blank();
  kv("Name", "Cibus-Wolt");
  kv("URL", fullUrl);
  kv("OAuth ID/Secret", dim("(leave blank)"));
  blank();

  const openBrowser = await askYesNo("Open Claude.ai Connectors page now?", true);
  if (openBrowser) openUrl("https://claude.ai/customize/connectors");

  blank();
  note("Steps in the Claude.ai form:");
  numbered(1, `Click ${bold("'Add custom connector'")}`);
  numbered(2, "Paste Name + URL above; leave OAuth fields empty");
  numbered(3, `Click ${bold("'Add'")} — Claude probes the server and lists 8 tools`);
  numbered(4, `In a new chat → Tools menu → toggle on ${bold("'Cibus-Wolt'")}`);
  numbered(5, `Ask: ${bold("\"what's my cibus balance?\"")}`);
  blank();
  note(`Current URL anytime: ${cmd("npx cibus-wolt webhook-url")}`);
  blank();
  await askRaw(pressEnter("Press Enter when you've registered the connector (or to skip)"));
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
  section("Chrome", {
    step: { n: 2, total: TOTAL_STEPS },
    subtitle: "Real Google Chrome — Wolt's bot detection is stricter on Chromium.",
  });
  const chromeBin = findChrome();
  if (!chromeBin) {
    warn("Google Chrome not found. Install from https://www.google.com/chrome/");
    note("Playwright will fall back to bundled Chromium, which trips Wolt bot detection more easily.");
    return;
  }
  success(`Found Chrome at ${val(chromeBin)}`);
  note("Each drain launches Chrome with a dedicated profile at");
  plain(`  ${val(paths.chromeProfile)}`);
  note("First run prompts a manual Wolt login; subsequent runs reuse the session cookie.");
}

async function stepWebhook(env: EnvMap): Promise<void> {
  subsection("Phone webhook", "iOS Shortcut POSTs the OTP to your laptop via ngrok/devtunnel.");

  // Webhook token
  try {
    const existing = (await fs.readFile(paths.webhookToken, "utf8")).trim();
    if (existing) {
      const keep = await askYesNo("Keep existing webhook token?", true);
      if (!keep) {
        await fs.writeFile(paths.webhookToken, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
        success("Rotated webhook token");
      }
    } else throw new Error("empty");
  } catch {
    await fs.writeFile(paths.webhookToken, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    success("Generated fresh webhook token");
  }

  // Require ngrok static domain — no rotating URLs
  await ensureTunnel();

  const doLaunchd = await askYesNo("Install background services (server + ngrok) for auto-start on login?", true);
  if (doLaunchd) {
    try {
      execSync("npm run install-bg", { stdio: "inherit" });
    } catch {
      failure(`install-bg failed. Retry later: ${cmd("npm run install-bg")}`);
      return;
    }
  } else {
    note(`Skipped. Run manually later: ${cmd("npm run install-bg")}`);
  }

  blank();
  info(`Phone Shortcut setup (iOS) — ${emphasis("required for OTP delivery")}:`);
  bullet(`OTP: Automation → Message (filter ${bold("Pluxee + 'קוד האימות'")})`);
  bullet(`→ Get Contents of URL (POST)`);
  bullet(`→ ${val("https://<your-ngrok-domain>/webhook/<token>/otp")}`);
  bullet(`→ Body JSON: ${val("{\"code\": <Message>}")} ${dim("(server extracts digits)")}`);
  note(`Full step-by-step in README, section ${bold("'CLI + phone webhook (ngrok)'")}.`);
  note(`Get the exact URLs anytime: ${cmd("npx cibus-wolt webhook-url")}`);

  await testOtpShortcutWebhook(env);
}

async function testOtpShortcutWebhook(env: EnvMap): Promise<void> {
  blank();
  const doTest = await askYesNo("Test the OTP Shortcut end-to-end now? (we trigger the SMS for you)", true);
  if (!doTest) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await withSilencedLogger(() => runWebhookOtpTest(env));
    if (ok) return;
    const retry = await askYesNo("Retry the test? (fix the Shortcut, then come back)", true);
    if (!retry) {
      note(`Skipping. Re-test later with: ${cmd("npx cibus-wolt webhook-url")} + manually trigger.`);
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
    failure("Webhook token or tunnel hostname missing — can't test.");
    return false;
  }
  if (!token || !hostname) {
    failure("Webhook token or tunnel hostname empty — can't test.");
    return false;
  }
  const baseUrl = `https://${hostname}/webhook/${token}`;

  blank();
  warn(`Make sure the OTP Automation in Shortcuts is saved and ${emphasis("'Run After Confirmation' is OFF")}`);
  note("— otherwise iOS will silently swallow it.");
  blank();

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
    success(`OTP received via webhook: ${val(result.code ?? "")}`);
    note("iOS Shortcut → ngrok → server round-trip works.");
    success(`Cibus profile saved at ${val(paths.chromeProfileCibus)} — first drain skips login.`);
    return true;
  }
  note("Likely causes:");
  bullet(`iOS Shortcut not enabled, or ${bold("'Run After Confirmation'")} still on`);
  bullet("Shortcut filter doesn't match the actual SMS sender / wording");
  bullet("ngrok hostname in Shortcut differs from current one");
  note(`Verify the URL: ${val(baseUrl + "/otp")}`);
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
    warn("CIBUS_USER missing from .env — can't auto-trigger SMS. Skipping.");
    return { ok: false };
  }
  info("Opening Cibus (OTP tab) — Chrome stays open until OTP arrives, then submits it.");
  try {
    const { triggerCibusSmsAndCompleteLogin } = await import("../cibus.ts");
    const result = await triggerCibusSmsAndCompleteLogin(env.CIBUS_USER, fetchOtp);
    if (!result.ok) {
      failure(result.reason);
      return { ok: false, code: result.code };
    }
    return { ok: true, code: result.code };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failure(`Failed: ${msg}`);
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
    success(`Existing ${kind} tunnel: ${val(configured)}`);
    const keep = await askYesNo("Keep it?", true);
    if (keep) return;
  }
  note("A stable public URL is required so it doesn't change on reboot.");
  note("Two providers supported:");
  bullet(`${bold("ngrok")}     — default. Free static *.ngrok-free.app domain.`);
  bullet(`${bold("devtunnel")} — Microsoft Azure Dev Tunnels. Use if ngrok is blocked (e.g. MS corp network).`);
  blank();
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
  subsection("Gmail OAuth", "Polls your Gmail for the Cibus OTP email forwarded by your iOS Shortcut.");
  blank();
  info(`One-time GCP project setup: ${val("https://console.cloud.google.com")}`);
  numbered(1, "New project → enable Gmail API");
  numbered(2, "OAuth consent screen → External → add yourself as Test User, scope gmail.readonly");
  numbered(3, "Credentials → Create OAuth Client ID → Desktop app");
  blank();

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
      warn("Both ID and secret are required for Gmail polling. Re-enter or Ctrl-C to skip.");
      continue;
    }
    // Persist before triggering the browser — token.json + refresh-token live
    // separately, but config.ts reads credentials from .env.
    await writeEnvFile(envPath, env);

    blank();
    info(`Verifying OAuth — ${emphasis("a browser tab will open")} for Google consent.`);
    note("Pick the Gmail account that receives Cibus mail.");
    try {
      const { getAuthClient } = await import("../gmail.ts");
      const { google } = await import("googleapis");
      const client = await getAuthClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
      const gmail = google.gmail({ version: "v1", auth: client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      success(`Gmail OAuth verified — authorized as ${val(profile.data.emailAddress ?? "(unknown)")}`);
      authedClient = client;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failure(`Gmail OAuth failed: ${msg}`);
      // Wipe any stale cached token so the retry forces a fresh consent flow
      // rather than re-trying a broken refresh token.
      await fs.rm(paths.token, { force: true });
      const retry = await askYesNo("Re-enter credentials and retry?", true);
      if (!retry) {
        note("Skipping Gmail verification. The next drain will retry the consent flow.");
        return;
      }
    }
  }

  blank();
  warn("Cibus OTPs arrive as SMS — Gmail polling can't see them directly.");
  note(`To get fully unattended runs, set up the iOS Shortcut that forwards the`);
  note(`Cibus OTP SMS to Gmail with subject ${bold("'cibus-otp'")}.`);
  note(`README → section ${bold("'iOS Shortcut — forward Cibus SMS to Gmail'")}.`);
  note("Without it: you'll be prompted in the terminal for the 6-digit code.");

  if (authedClient) await testOtpShortcutGmail(env, authedClient);
}

async function testOtpShortcutGmail(env: EnvMap, auth: import("google-auth-library").OAuth2Client): Promise<void> {
  blank();
  const doTest = await askYesNo("Test the SMS→Gmail Shortcut end-to-end now? (we trigger the SMS for you)", true);
  if (!doTest) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await withSilencedLogger(() => runGmailOtpTest(env, auth));
    if (ok) return;
    const retry = await askYesNo("Retry the test? (fix the Shortcut, then come back)", true);
    if (!retry) {
      note("Skipping. The drain itself will fall back to Gmail polling / terminal prompt.");
      return;
    }
  }
}

async function runGmailOtpTest(env: EnvMap, auth: import("google-auth-library").OAuth2Client): Promise<boolean> {
  blank();
  warn(`Make sure the SMS→Gmail Automation is saved and ${emphasis("'Run After Confirmation' is OFF")}`);
  note("— otherwise iOS will silently swallow it.");
  blank();

  const fetchOtp = async (since: Date): Promise<string> => {
    const { fetchCibusOtp } = await import("../gmail.ts");
    return await fetchCibusOtp({ auth, since, timeoutMs: 90_000, pollMs: 5_000 });
  };

  const result = await triggerCibusSmsAndSaveProfile(env, fetchOtp);
  if (result.ok) {
    success(`OTP received via Gmail: ${val(result.code ?? "")}`);
    note("iOS Shortcut → Gmail → server round-trip works.");
    success(`Cibus profile saved at ${val(paths.chromeProfileCibus)} — first drain skips login.`);
    return true;
  }
  note("Likely causes:");
  bullet(`iOS Shortcut not enabled, or ${bold("'Run After Confirmation'")} still on`);
  bullet("Shortcut filter doesn't match the actual SMS sender / wording");
  bullet(`Email subject in the Shortcut isn't exactly ${bold("'cibus-otp'")}`);
  bullet("Shortcut sends to a different Gmail than the one you authorized");
  return false;
}

async function stepWoltLogin(env: EnvMap): Promise<void> {
  section("Wolt login", {
    step: { n: 4, total: TOTAL_STEPS },
    subtitle: "One-time manual sign-in. Cookie saved to the profile + auto-refreshed each drain.",
  });
  note("Wolt's bot detection rejects automated email submission, so we hand the browser to you.");
  note(`When the cookie eventually expires, run ${cmd("cibus-wolt wolt-login")}.`);
  blank();
  const doTest = await askYesNo("Open Chrome and log in to Wolt now?", true);
  if (!doTest) {
    note(`Skipping. Run ${cmd("cibus-wolt wolt-login")} later (or the first drain will prompt).`);
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await runWoltLoginTest(env);
    if (ok) return;
    const retry = await askYesNo("Retry the Wolt login?", true);
    if (!retry) {
      note(`Skipping. Run ${cmd("cibus-wolt wolt-login")} later when you're ready.`);
      return;
    }
  }
}

async function runWoltLoginTest(env: EnvMap): Promise<boolean> {
  info("Opening Wolt login page in Chrome — sign in manually, then press Enter here...");
  try {
    const { acquireBrowser } = await import("../browser.ts");
    const { ensureWoltLoggedIn } = await import("../woltLogin.ts");
    const browser = await acquireBrowser();
    try {
      const page = browser.context.pages()[0] ?? (await browser.context.newPage());
      await ensureWoltLoggedIn({ page });
      success(`Wolt session saved at ${val(paths.chromeProfile)}`);
      return true;
    } finally {
      await browser.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failure(msg);
    return false;
  }
}

async function stepSmokeTest(): Promise<void> {
  section("Smoke test", {
    step: { n: 6, total: TOTAL_STEPS },
    subtitle: "Verify the full pipeline before scheduling unattended runs.",
  });
  const run = await askYesNo(`Run ${cmd("cibus-wolt status")} to verify everything?`, true);
  if (run) {
    try {
      execSync("npx cibus-wolt status", { stdio: "inherit" });
    } catch {
      failure("Status command failed — inspect the output above.");
    }
  }

  blank();
  const dry = await askYesNo("Run a dry-run drain now? (full flow except final payment confirm)", true);
  if (!dry) return;
  try {
    execSync("npx cibus-wolt run --dry-run", { stdio: "inherit" });
  } catch {
    failure("Dry-run errored — inspect the output above.");
  }
}

function printDone(): void {
  blank();
  console.log(cyan(rule(70, true)));
  done("Setup complete.");
  blank();
  note("Next steps:");
  bullet(`${cmd("npx cibus-wolt run --dry-run")} ${dim("# smoke test the full flow")}`);
  bullet(`${cmd("npx cibus-wolt run")} ${dim("            # real drain")}`);
  bullet(`${cmd("npx cibus-wolt status")} ${dim("         # phase + last-run status")}`);
  bullet(`${cmd("npx cibus-wolt webhook-url")} ${dim("    # phone webhook URL (if configured)")}`);
  blank();
  note(`Re-run ${cmd("cibus-wolt setup")} anytime to edit values.`);
  console.log(cyan(rule(70, true)));
}

// ────────────────────────────────────────────────────────────────────────────
// Entry points
// ────────────────────────────────────────────────────────────────────────────

export async function runSetupCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— interactive setup")}`);
  note(`Ctrl-C to abort. Re-runnable — existing values become the defaults.`);
  note(`Press ${bold("Enter")} at any prompt to accept the highlighted default.`);

  await stepCredentials(env);
  await writeEnvFile(envPath, env);
  success(`Saved to ${val(envPath)}`);

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
  section("Drain schedules (optional)", {
    step: { n: 5, total: TOTAL_STEPS },
    subtitle: "Recurring drains that fire automatically while the background service runs.",
  });
  note("Pick a cadence matching your Cibus reset, add one or more schedules.");
  note(`Can be edited later with: ${cmd("cibus-wolt schedule <sub>")}`);
  blank();
  const proceed = await askYesNo("Configure schedules now?", true);
  if (!proceed) {
    note(`Skipped. Add later: ${cmd("cibus-wolt schedule add")}`);
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
  section("Cibus OTP delivery", {
    step: { n: 3, total: TOTAL_STEPS },
    subtitle: "How the 6-digit Cibus SMS reaches the laptop on each re-auth.",
  });
  note("Wolt login itself is one-time manual — the session cookie auto-refreshes on every drain.");
  blank();

  const existing = await detectExisting(env);
  if (existing.webhookConfigured || existing.gmailConfigured) {
    note("Already configured:");
    if (existing.webhookConfigured) success("Phone webhook");
    if (existing.gmailConfigured) success("Gmail OAuth");
    blank();
  }

  note("Pick how the Cibus OTP gets to the laptop:");
  bullet(`${bold("gmail")}     — iOS Shortcut forwards the OTP to Gmail; we poll Gmail. ${dim("[~2 min, recommended]")}`);
  bullet(`${bold("webhook")}   — iOS Shortcut POSTs the OTP to us via ngrok/devtunnel. ${dim("[~3 min]")}`);
  bullet(`${bold("terminal")}  — type the 6 digits when prompted. ${dim("Zero setup, but manual every time.")}`);
  blank();
  const otp = await askChoice(
    "How should we deliver the Cibus OTP?",
    ["gmail", "webhook", "terminal"],
    existing.gmailConfigured ? "gmail" : existing.webhookConfigured ? "webhook" : "terminal",
  );
  if (otp === "gmail") await stepGmail(env);
  else if (otp === "webhook") await stepWebhook(env);
  else note("Skipping — you'll be prompted in the terminal during drains.");
}

async function stepPhoneAccess(env: EnvMap): Promise<void> {
  section("Phone access (Claude.ai mobile / web)", {
    step: { n: 9, total: TOTAL_STEPS },
    subtitle: "HTTP tunnel + Custom Connector so Claude.ai can drive drains over the internet.",
  });
  note("Custom Connectors sync to Claude Desktop too via your Claude account —");
  note("handy if you skipped the local stdio install for Desktop earlier.");
  note("Claude Code is unaffected (separate registry).");
  blank();
  const proceed = await askYesNo("Set up phone access now? (ngrok/devtunnel + Claude.ai Custom Connector)", true);
  if (!proceed) {
    note(`Skipped. Add later: ${cmd("cibus-wolt phone-setup")}`);
    return;
  }
  await setupClaudeWeb(env);
}

export async function runClaudeCodeMcpCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— Claude Code MCP install")}`);

  if (!env.CIBUS_USER) {
    blank();
    warn("Cibus credentials missing from ~/.cibus-wolt/.env.");
    note(`Run ${cmd("cibus-wolt setup")} first — the MCP server installs but won't function until creds are present.`);
    process.exit(1);
  }

  await stepClaudeCode();
  printDone();
}

async function stepClaudeDesktop(env: EnvMap): Promise<void> {
  section("Claude Desktop MCP (optional)", {
    step: { n: 8, total: TOTAL_STEPS },
    subtitle: "Independent from Claude Code — separate config file.",
  });

  if (!await claudeDesktopInstalled()) {
    warn("Claude Desktop not detected. Skipping.");
    note(`Install from https://claude.ai/download, then run: ${cmd("cibus-wolt claude-desktop-mcp")}`);
    return;
  }

  const add = await askYesNo("Add cibus-wolt to Claude Desktop?", true);
  if (add) await setupClaudeDesktop(env);
}

export async function runClaudeDesktopMcpCommand(): Promise<void> {
  await ensureStateDir();
  const envPath = path.join(paths.dir, ".env");
  const env = await readEnvFile(envPath);

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— Claude Desktop MCP install")}`);

  if (!env.CIBUS_USER) {
    blank();
    warn("Cibus credentials missing from ~/.cibus-wolt/.env.");
    note(`Run ${cmd("cibus-wolt setup")} first — the MCP entry installs but won't function until creds are present.`);
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

  blank();
  console.log(`  ${bold(cyan("cibus-wolt"))} ${dim("— phone access setup")}`);

  if (!env.CIBUS_USER) {
    blank();
    warn(`Cibus credentials missing. Run ${cmd("cibus-wolt setup")} first.`);
    process.exit(1);
  }

  const existing = await detectExisting(env);
  if (!existing.claudeCodeConfigured && !existing.claudeDesktopConfigured) {
    blank();
    warn("No Claude client has cibus-wolt installed yet. Phone access is");
    note("pointless without a Claude to drive it. Run one of:");
    bullet(`${cmd("cibus-wolt claude-code-mcp")} ${dim("# Claude Code")}`);
    bullet(`${cmd("cibus-wolt claude-desktop-mcp")} ${dim("# Claude Desktop")}`);
    process.exit(1);
  }

  await stepPhoneAccess(env);
  await writeEnvFile(envPath, env);
  printDone();
}

