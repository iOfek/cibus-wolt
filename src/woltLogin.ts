import type { Page } from "playwright";
import type { OAuth2Client } from "google-auth-library";
import { fetchWoltMagicLink } from "./gmail.ts";
import { logger } from "./logger.ts";
import { dismissWoltOverlays } from "./woltOverlays.ts";

export interface WoltLoginOpts {
  page: Page;
  email: string;
  /** Required unless fetchMagicLink is provided (used for Gmail-polling magic-link fetch). */
  auth?: OAuth2Client;
  /** Override to provide a magic link from an external source (e.g. MCP pause/resume). */
  fetchMagicLink?: () => Promise<string>;
}

export async function ensureWoltLoggedIn(opts: WoltLoginOpts): Promise<void> {
  const { page, email } = opts;

  await page.goto("https://wolt.com/en", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await dismissWoltOverlays(page);

  if (await isLoggedIn(page)) {
    logger.info("Wolt session already active");
    return;
  }

  logger.info("No Wolt session — opening login page for manual login");
  await page.goto("https://wolt.com/en/me/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissWoltOverlays(page);

  // Manual login path: Wolt's bot detection rejects automated email submission
  // on fresh profiles, so we hand the browser to the user. The auto-fill +
  // magic-link-poll helpers below (fillEmailAndSubmit, fetchWoltMagicLink,
  // clickConfirmBrowserButton) are kept for future re-enablement.
  logger.info(`👉 Please log in to Wolt manually in the visible browser window (account: ${email}).`);
  logger.info("   The script will detect when login completes and continue automatically.");
  logger.info("   Waiting up to 3 minutes...");
  await waitForManualLogin(page, 3 * 60_000);

  logger.info("✓ Wolt login detected — continuing");
}

async function waitForManualLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let offLoginSince = 0;
  while (Date.now() < deadline) {
    try {
      const url = page.url();
      const onLoginPage = /\/login(\b|\/|\?|$)/i.test(url);
      if (!onLoginPage && url.includes("wolt.com")) {
        if (offLoginSince === 0) offLoginSince = Date.now();
        // URL has been off the login page for 3s — verify with a definitive check.
        if (Date.now() - offLoginSince > 3000) {
          if (await isLoggedIn(page)) return;
          offLoginSince = 0; // false positive — back to waiting
        }
      } else {
        offLoginSince = 0;
      }
    } catch {
      /* page may be navigating — try again next tick */
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("Manual Wolt login timed out after 3 minutes");
}

/**
 * Wolt's "Confirm you're using this browser" challenge appears when the
 * fingerprint of the browser opening the magic link differs from the one
 * that requested it. Clicking Confirm completes the login.
 */
async function clickConfirmBrowserButton(page: Page): Promise<void> {
  const candidates = [
    'button[data-test-id*="confirm" i]',
    'button[data-localization-key*="confirm" i]',
    'button:has-text("Confirm")',
    'button:has-text("אישור")',
    'button:has-text("אשר")',
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      try {
        if (!(await loc.isVisible({ timeout: 200 }))) continue;
        const label = (await loc.innerText({ timeout: 200 }).catch(() => "")).trim();
        await loc.click({ timeout: 2000 });
        logger.info({ sel, label }, "Clicked Wolt 'Confirm browser' button");
        await page.waitForTimeout(1500);
        return;
      } catch {
        /* try next */
      }
    }
    await page.waitForTimeout(500);
  }
}

async function fillEmailAndSubmit(page: Page, email: string): Promise<boolean> {
  try {
    const emailField = page
      .locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[placeholder*="email" i]')
      .first();
    await emailField.waitFor({ state: "visible", timeout: 10_000 });

    // Real keystrokes — Wolt's React form enables the submit button based on
    // input events. .fill() can set the value without triggering onChange,
    // leaving the button disabled.
    await emailField.click();
    await emailField.fill("");
    await emailField.pressSequentially(email, { delay: 30 });
    await page.waitForTimeout(800);

    // Stable Wolt selector — Aalto design system uses data-test-id attributes.
    const continueBtn = page.locator('button[data-test-id="StepMethodSelect.NextButton"]').first();
    try {
      await continueBtn.waitFor({ state: "visible", timeout: 5_000 });
      // Playwright's .click() waits for the button to be enabled (Wolt's React
      // form disables it until the email validates as well-formed).
      await continueBtn.click({ timeout: 10_000 });
      return true;
    } catch {
      logger.debug("Wolt Continue button not clickable — falling back to Enter key");
      await emailField.press("Enter");
      return true;
    }
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Wolt email auto-fill failed");
    return false;
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto("https://wolt.com/en/me", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500);
    await dismissWoltOverlays(page);
    const url = page.url();
    if (url.includes("/me/login") || url.includes("/login")) return false;
    if (!url.includes("/me")) return false;
    const loginModal = page.getByText(/create an account or log in/i);
    if (await loginModal.first().isVisible({ timeout: 500 }).catch(() => false)) return false;
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.first().isVisible({ timeout: 500 }).catch(() => false)) return false;
    return true;
  } catch {
    return false;
  }
}
