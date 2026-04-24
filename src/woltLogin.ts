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

  logger.info("No Wolt session — opening login page for manual email submit");
  await page.goto("https://wolt.com/en/me/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissWoltOverlays(page);

  const sentAt = new Date();

  logger.warn("👉 ACTION NEEDED: In the visible browser, enter your email and click the 'Continue' / 'Send' button on the Wolt login form.");
  logger.warn(`   Expected email: ${email}`);
  logger.warn("   I'll poll Gmail every 10s (up to 10 minutes) and continue automatically when the magic-link email arrives. Do NOT click the link — just send the email.");

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

  if (!(await isLoggedIn(page))) {
    throw new Error("Magic-link navigation did not produce a logged-in session");
  }
  logger.info("Wolt login complete");
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
