/* eslint-disable no-console */
/**
 * One-off diagnostic: launch Google Chrome ourselves with a remote-debugging
 * port, attach Playwright via connectOverCDP, drive the Wolt login flow, and
 * see if the magic-link email arrives in Gmail.
 *
 * Hypothesis: Wolt's bot detection bites Playwright's launchPersistentContext
 * because of CDP-side fingerprints (e.g. the Runtime.enable leak). Launching
 * Chrome ourselves and attaching after-the-fact may evade it.
 *
 * Outcome legend:
 *   ✓ magic-link arrives → CDP-attach approach works; refactor browser.ts.
 *   ✗ no magic-link in 60s → Wolt also blocks this path; patchright is needed.
 *
 * Run:
 *   node --import tsx/esm src/scripts/test-cdp-attach.ts
 *
 * Uses a fresh tmp profile so previous state doesn't bias the test, and so
 * MFA / cooldowns from the real chrome-profile don't carry over.
 */
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { config } from "../config.ts";
import { tryLoadAuthClient, fetchWoltMagicLink } from "../gmail.ts";
import { findChrome } from "../platform.ts";
import { dismissWoltOverlays } from "../woltOverlays.ts";

const PORT = 9222;

async function waitForCdpReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`);
}

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error("✗ Chrome not found. Install Google Chrome and re-run.");
    process.exit(1);
  }
  const woltEmail = process.env.WOLT_EMAIL;
  if (!woltEmail) {
    console.error("✗ WOLT_EMAIL must be set in the environment for this diagnostic script.");
    process.exit(1);
  }
  if (!config.google.clientId || !config.google.clientSecret) {
    console.error("✗ GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET required to poll Gmail for the magic-link.");
    process.exit(1);
  }

  const auth = await tryLoadAuthClient(config.google.clientId, config.google.clientSecret);
  if (!auth) {
    console.error("✗ No cached Gmail token. Run setup first to authorize Gmail.");
    process.exit(1);
  }

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "cibus-cdp-test-"));
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ];
  console.log(`Launching Chrome:\n  ${chromeBin}\n  ${args.join("\n  ")}\n`);
  const proc = spawn(chromeBin, args, { stdio: "ignore", detached: false });

  let browser: Browser | null = null;
  const cleanup = async () => {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    await waitForCdpReady(PORT);
    console.log(`✓ CDP ready on port ${PORT}`);

    browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    console.log("Navigating to Wolt login...");
    await page.goto("https://wolt.com/en/me/login", { waitUntil: "domcontentloaded" });
    // Cookie banner needs hydration time. Wait, dismiss, wait again to catch
    // a banner that renders after our first pass.
    await page.waitForTimeout(3000);
    await dismissWoltOverlays(page);
    await page.waitForTimeout(1500);
    await dismissWoltOverlays(page);

    const sentAt = new Date();

    const emailField = page.locator('input[type="email"], input[name="email"]').first();
    await emailField.waitFor({ state: "visible", timeout: 10_000 });
    await emailField.click();
    await emailField.fill("");
    await emailField.pressSequentially(woltEmail, { delay: 30 });
    await page.waitForTimeout(800);

    const continueBtn = page.locator('button[data-test-id="StepMethodSelect.NextButton"]').first();
    try {
      await continueBtn.click({ timeout: 10_000 });
      console.log(`✓ Clicked Continue. Polling Gmail for magic-link (60s window)...`);
    } catch (e) {
      console.log(`✗ Couldn't click Continue: ${e instanceof Error ? e.message : String(e)}`);
      console.log("  Falling back to Enter key.");
      await emailField.press("Enter");
    }

    try {
      const url = await fetchWoltMagicLink({
        auth,
        since: new Date(sentAt.getTime() - 30_000),
        expectEmail: woltEmail,
        timeoutMs: 60_000,
        pollMs: 5_000,
      });
      console.log("");
      console.log("══════════════════════════════════════════════════════════════════");
      console.log("✓✓✓ SUCCESS — magic-link arrived in Gmail.");
      console.log(`    URL: ${url.slice(0, 80)}...`);
      console.log("    The launch-Chrome-then-CDP-attach approach DOES bypass Wolt's bot");
      console.log("    detection. Refactor browser.ts to use this pattern.");
      console.log("══════════════════════════════════════════════════════════════════");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("");
      console.log("══════════════════════════════════════════════════════════════════");
      console.log("✗✗✗ NO MAGIC-LINK in 60s.");
      console.log(`    Reason: ${msg}`);
      console.log("    Wolt also blocks the launch-then-attach path. The detection is at");
      console.log("    the CDP fingerprint level (Runtime.enable leak). Patchright is");
      console.log("    the proper fix — patches the Chromium binary itself.");
      console.log("══════════════════════════════════════════════════════════════════");
    }

    console.log("\nLeaving Chrome open for 10s so you can inspect the page state...");
    await page.waitForTimeout(10_000);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
