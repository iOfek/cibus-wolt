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
  const { page, email, auth } = opts;

  await page.goto("https://wolt.com/en", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await dismissWoltOverlays(page);

  if (await isLoggedIn(page)) {
    logger.info("Wolt session already active");
    return;
  }

  logger.info("No Wolt session — opening login page");
  await page.goto("https://wolt.com/en/me/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissWoltOverlays(page);

  const sentAt = new Date();
  const autoFilled = await fillEmailAndSubmit(page, email);

  if (autoFilled) {
    logger.info(`Wolt email auto-filled and submitted: ${email}`);
  } else {
    // Fall back to manual: only path here is when our selectors miss a UI
    // change. The user types email + clicks Continue in the visible browser.
    logger.warn("👉 Auto-fill failed (selectors may be stale). Enter email + click Continue in the visible browser.");
    logger.warn(`   Expected email: ${email}`);
  }
  // Diagnostic pause: holds the page open for 10s so the user can inspect what
  // Wolt actually showed (success toast vs. automation warning vs. captcha)
  // before we start polling for the magic-link email.
  logger.info("⏸  Pausing 10s so you can inspect the page after email submit (look for: 'check your email' toast, captcha, or any error)...");
  await page.waitForTimeout(10_000);
  logger.info("   Awaiting magic-link delivery (Gmail / webhook / MCP / stdin) — up to 10 minutes.");

  let magicUrl: string;
  if (opts.fetchMagicLink) {
    logger.info("Awaiting magic-link from external submitter (MCP)");
    magicUrl = await opts.fetchMagicLink();
  } else if (auth) {
    magicUrl = await fetchWoltMagicLink({
      auth,
      since: new Date(sentAt.getTime() - 60_000),
      expectEmail: email,
      timeoutMs: 10 * 60 * 1000,
      pollMs: 10_000,
    });
  } else {
    throw new Error(
      "Wolt magic-link required but no Gmail auth and no external provider. Either set GOOGLE_CLIENT_ID (CLI mode) or wire fetchMagicLink (MCP mode).",
    );
  }

  logger.info("Magic link received — opening it in the same browser");
  await page.goto(magicUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissWoltOverlays(page);
  await clickConfirmBrowserButton(page);

  if (!(await isLoggedIn(page))) {
    throw new Error("Magic-link navigation did not produce a logged-in session");
  }
  logger.info("Wolt login complete");
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
