import type { BrowserContext, Page } from "playwright";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs/promises";
import { type GmailCreds } from "./gmail.ts";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import { dismissWoltOverlays } from "./woltOverlays.ts";

export interface WoltLoginOpts {
  page: Page;
  /** Reserved for the (currently inactive) magic-link helpers. */
  gmail?: GmailCreds;
  /** Reserved for the (currently inactive) magic-link helpers. */
  fetchMagicLink?: () => Promise<string>;
}

export async function ensureWoltLoggedIn(opts: WoltLoginOpts): Promise<void> {
  const { page } = opts;
  const context = page.context();

  // Restore Wolt cookies from our own JSON cache. Chrome's profile cookie
  // store can lose late Set-Cookie writes (e.g. from a Google OAuth callback)
  // when shutdown doesn't flush in time. We persist to JSON ourselves so the
  // session survives regardless of Chrome's flush behavior.
  await loadCookiesFromDisk(context);

  if (await hasWoltSessionCookie(page)) {
    logger.info("Wolt session cookie present — skipping login");
    // Best-effort keep-alive: one authenticated page hit nudges Wolt's
    // sliding-window session forward; the new Set-Cookie response updates
    // both the Chrome profile and our JSON cache.
    await refreshWoltSession(page);
    await saveCookiesToDisk(context);
    return;
  }

  logger.info("No Wolt session cookie — navigating to login page");
  await page.goto("https://wolt.com/en/me/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissWoltOverlays(page);

  // Manual login path: Wolt's bot detection rejects automated email submission
  // on fresh profiles, so we hand the browser to the user. The auto-fill +
  // magic-link-poll helpers below (fillEmailAndSubmit, fetchWoltMagicLink,
  // clickConfirmBrowserButton) are kept for future re-enablement.
  logger.info("👉 Please log in to Wolt manually in the visible browser.");
  logger.info("   Sign-in via Google / email-link / whatever Wolt offers — all are fine.");
  logger.info("   When you're logged in, come back to this terminal and press Enter.");
  await waitForEnter("   Press Enter once Wolt shows you logged in: ");

  if (!(await hasWoltSessionCookie(page))) {
    throw new Error(
      "No Wolt session cookie found after manual login. Re-run and make sure the login completed in the visible browser window before pressing Enter.",
    );
  }
  await saveCookiesToDisk(context);
  logger.info("✓ Wolt session cookie present — login confirmed and saved");
}

/**
 * Persist Wolt cookies (.wolt.com + wolt.com) to JSON. Called after every
 * successful auth check so the file is always fresh. Chmod 0600 — these
 * cookies are credential-equivalent.
 */
async function saveCookiesToDisk(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies("https://wolt.com");
    if (cookies.length === 0) {
      logger.debug("No Wolt cookies to save");
      return;
    }
    await fs.writeFile(paths.woltCookies, JSON.stringify(cookies, null, 2), { mode: 0o600 });
    logger.debug({ count: cookies.length, path: paths.woltCookies }, "Saved Wolt cookies");
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Failed to save Wolt cookies");
  }
}

/**
 * Restore Wolt cookies from our JSON cache into the browser context. No-op
 * when the file is missing (first run) or unreadable.
 */
async function loadCookiesFromDisk(context: BrowserContext): Promise<void> {
  try {
    const raw = await fs.readFile(paths.woltCookies, "utf8");
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
      logger.debug({ count: cookies.length }, "Loaded Wolt cookies from disk");
    }
  } catch {
    /* first run, or file removed — proceed without */
  }
}

async function refreshWoltSession(page: Page): Promise<void> {
  try {
    await page.goto("https://wolt.com/en/me", { waitUntil: "domcontentloaded", timeout: 10_000 });
    logger.debug("Wolt session keep-alive hit /me");
  } catch (e) {
    logger.debug({ err: e instanceof Error ? e.message : String(e) }, "Wolt session keep-alive skipped");
  }
}

/**
 * Validate Wolt login by inspecting the browser profile's cookies for an
 * auth/session token. This is the cheap Gmail-style "do we have credentials?"
 * check — no navigation, no API call. The Chrome profile persists cookies
 * across runs, so a successful login once means subsequent runs hit the
 * fast path above.
 */
async function hasWoltSessionCookie(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies("https://wolt.com");
    const candidate = cookies.find((c) => {
      if (!c.value || c.value.length < 16) return false;
      // Skip CSRF / cross-site / consent-shaped cookies — they're not auth.
      if (/(csrf|consent|locale|cf[-_])/i.test(c.name)) return false;
      return /(token|session|auth|userid|jwt)/i.test(c.name);
    });
    if (candidate) {
      logger.debug({ name: candidate.name, valueLen: candidate.value.length }, "Wolt session cookie matched");
      return true;
    }
    logger.debug(
      { cookieCount: cookies.length, names: cookies.map((c) => c.name) },
      "No Wolt session cookie matched",
    );
    return false;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Wolt cookie check failed");
    return false;
  }
}

async function waitForEnter(prompt: string): Promise<void> {
  if (!stdin.isTTY) {
    // No interactive terminal (e.g. MCP / scripted run) — fall back to a
    // fixed delay so the script doesn't hang forever.
    logger.warn("Non-TTY stdin — sleeping 60s instead of waiting for Enter");
    await new Promise((r) => setTimeout(r, 60_000));
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
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
