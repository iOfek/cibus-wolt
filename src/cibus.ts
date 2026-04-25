import type { OAuth2Client } from "google-auth-library";
import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fetchCibusOtp } from "./gmail.ts";
import { logger } from "./logger.ts";
import { paths, screenshotDirFor } from "./paths.ts";

export interface CibusCreds {
  username: string;
  password: string;
  company: string;
}

export interface GetBalanceOpts {
  auth?: OAuth2Client;
  /** Override to fetch MFA OTP from an external source (e.g. MCP pause/resume). */
  fetchOtp?: () => Promise<string>;
}

const LOGIN_URL = "https://consumers.pluxee.co.il/login";
const HOME_URL = "https://consumers.pluxee.co.il/";
const BALANCE_API_HINT = "prx_user_info";
const BALANCE_TIMEOUT_MS = 5 * 60 * 1000;

export async function getCibusWeeklyBalance(creds: CibusCreds, opts: GetBalanceOpts = {}): Promise<number> {
  const USER_DATA_DIR = paths.chromeProfileCibus;
  await fs.mkdir(USER_DATA_DIR, { recursive: true });
  const screenshotDir = screenshotDirFor("cibus");
  await fs.mkdir(screenshotDir, { recursive: true });

  logger.info("Launching Playwright (persistent profile)");
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "he-IL",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true }).catch(() => {});
  };

  const balancePromise = captureBalance(page);

  try {
    logger.info({ url: HOME_URL }, "Navigating to Pluxee home");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    await shot("01-landing");

    const loggedIn = !page.url().includes("/login") && !(await page.locator("input#user").first().isVisible().catch(() => false));

    if (!loggedIn) {
      logger.info("Session expired or not present — logging in");
      await doLogin(page, creds, shot, opts.auth, opts.fetchOtp);
    } else {
      logger.info("Session cookie appears valid — skipping login");
    }

    const balance = await balancePromise;
    logger.info({ balance }, "Cibus weekly balance fetched");
    await shot("99-success");
    return balance;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg, screenshotDir }, "Cibus scrape failed — see screenshots");
    await shot("99-failure");
    throw e;
  } finally {
    await ctx.close();
  }
}

function captureBalance(page: Page): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out (${BALANCE_TIMEOUT_MS}ms) waiting for Cibus balance API`)),
      BALANCE_TIMEOUT_MS,
    );
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes(BALANCE_API_HINT) || response.status() !== 200) return;
      try {
        const data = await response.json();
        const budget =
          data?.budget ??
          data?.balance ??
          data?.weekly_budget ??
          data?.weeklyBudget ??
          data?.remaining_budget;
        if (budget == null) {
          logger.warn({ keys: Object.keys(data ?? {}) }, "Balance field not found");
          return;
        }
        const n = Number(budget);
        if (Number.isFinite(n)) {
          clearTimeout(timer);
          resolve(n);
        }
      } catch {
        /* not json */
      }
    });
  });
}

async function doLogin(
  page: Page,
  creds: CibusCreds,
  shot: (name: string) => Promise<void>,
  auth?: OAuth2Client,
  fetchOtpOverride?: () => Promise<string>,
): Promise<void> {
  const loginStartedAt = new Date();
  if (!page.url().includes("/login")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }

  await ensurePermanentPasswordTab(page);

  // Username
  await fillVisible(page, ["input#user"], creds.username, "username");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);
  await ensureRememberMe(page);
  await shot("02-username");

  // Step 1 continue
  await clickEnabled(
    page,
    [
      'button.cib-btn:has-text("שנמשיך")',
      'button:has-text("שנמשיך")',
    ],
    "step-1",
  );
  await page.waitForTimeout(2000);
  await shot("03-after-step1");

  // Password + company
  await fillVisible(page, ["input#password"], creds.password, "password");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);

  const companyField = page.locator("input#company-inp");
  if (await firstVisible(companyField).catch(() => null)) {
    await fillVisible(page, ["input#company-inp"], creds.company, "company");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
  }
  await ensureRememberMe(page);
  await shot("04-password");

  // Step 2 login
  await clickEnabled(
    page,
    [
      'button.cib-btn:has-text("כניסה")',
      'button:has-text("כניסה")',
    ],
    "step-2",
  );
  await page.waitForTimeout(3000);
  await shot("05-after-step2");

  // Detect MFA
  const mfa = await detectMfaField(page);
  if (mfa) {
    logger.warn("📱 Cibus is asking for an SMS MFA code");
    await shot("06-mfa-prompt");
    let code: string | null = null;
    if (fetchOtpOverride) {
      try {
        code = await fetchOtpOverride();
        logger.info("OTP received from external submitter (MCP)");
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "External OTP fetch failed — trying Gmail/stdin fallback");
      }
    }
    if (!code && auth) {
      try {
        code = await fetchCibusOtp({
          auth,
          since: new Date(loginStartedAt.getTime() - 30_000),
          timeoutMs: 90_000,
          pollMs: 5_000,
        });
        logger.info("OTP auto-fetched from Gmail");
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "OTP Gmail fetch failed — falling back to stdin");
      }
    }
    if (!code) code = await promptForCode();
    await mfa.fill(code);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    await clickEnabled(
      page,
      [
        'button.cib-btn:has-text("אישור")',
        'button.cib-btn:has-text("כניסה")',
        'button.cib-btn:has-text("שלח")',
        'button.cib-btn:has-text("אימות")',
        'button:has-text("Submit")',
        'button.cib-btn',
      ],
      "mfa-submit",
    );
    logger.info("MFA code submitted");
    await shot("07-after-mfa");
  }
}

async function detectMfaField(page: Page): Promise<ReturnType<Page["locator"]> | null> {
  const candidates = [
    'input[maxlength="6"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"][maxlength]',
    'input[placeholder*="קוד"]',
    'input[placeholder*="אימות"]',
    'input[aria-label*="קוד"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        logger.debug({ sel, index: i }, "Detected MFA field");
        return el;
      }
    }
  }
  return null;
}

async function promptForCode(): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const code = await rl.question("📱 Enter the 6-digit SMS code from Cibus (10 min window): ");
    return code.trim();
  } finally {
    rl.close();
  }
}

async function ensureRememberMe(page: Page): Promise<void> {
  const selectors = [
    'input#remember-me-checkbox',
    'input[type="checkbox"][id*="remember" i]',
    'input[type="checkbox"][name*="remember" i]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const checked = await el.isChecked().catch(() => true);
      if (!checked) {
        await el.check().catch(async () => {
          await el.click().catch(() => {});
        });
        logger.debug("Remember-me toggled on");
      }
      return;
    }
  }
}

async function ensurePermanentPasswordTab(page: Page): Promise<void> {
  const tab = page.locator('button:has-text("סיסמה קבועה"), [role="tab"]:has-text("סיסמה קבועה")').first();
  try {
    if (await tab.isVisible({ timeout: 2_000 })) {
      await tab.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  } catch {
    /* not always present */
  }
}

async function firstVisible(loc: ReturnType<Page["locator"]>): Promise<ReturnType<Page["locator"]> | null> {
  const count = await loc.count();
  for (let i = 0; i < count; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function fillVisible(page: Page, selectors: string[], value: string, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const all = page.locator(sel);
      const count = await all.count();
      for (let i = 0; i < count; i++) {
        const el = all.nth(i);
        try {
          if (!(await el.isVisible({ timeout: 200 }))) continue;
          await el.fill(value);
          logger.debug({ sel, index: i, label }, "Filled");
          return;
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No visible ${label} field (tried: ${selectors.join(", ")})`);
}

async function clickEnabled(page: Page, selectors: string[], label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const all = page.locator(sel);
      const count = await all.count();
      for (let i = 0; i < count; i++) {
        const el = all.nth(i);
        try {
          if (!(await el.isVisible({ timeout: 200 }))) continue;
          if (!(await el.isEnabled().catch(() => true))) continue;
          await el.click();
          logger.debug({ sel, index: i, label }, "Clicked");
          return;
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No clickable ${label} within 15s (tried: ${selectors.join(", ")})`);
}

/**
 * Open Cibus in the real chrome-profile-cibus, switch to the OTP-only tab,
 * submit username + click 'send code' to provoke an SMS, then wait for the
 * caller's `fetchOtp` to deliver the code (typically via Gmail/webhook
 * polling). Submits the code, waits for login redirect, closes — leaving
 * a logged-in profile so the first real drain skips the login step.
 *
 * Always wipes the profile beforehand so MFA fires unconditionally
 * (cached device trust would skip it). OTP mode is used over password+MFA
 * to guarantee an SMS regardless of trust state.
 */
export async function triggerCibusSmsAndCompleteLogin(
  username: string,
  fetchOtp: () => Promise<string>,
): Promise<{ ok: boolean; reason: string; code?: string }> {
  // Wipe so the login is fresh and SMS fires unconditionally.
  await fs.rm(paths.chromeProfileCibus, { recursive: true, force: true });
  await fs.mkdir(paths.chromeProfileCibus, { recursive: true });

  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(paths.chromeProfileCibus, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      locale: "he-IL",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Switch to the one-time-code tab — always sends an SMS, regardless of trust.
    const otpTab = page
      .locator('.tab.code, div.tab.code, [class*="tab"]:has-text("קוד חד פעמי"), [role="tab"]:has-text("קוד חד פעמי")')
      .first();
    await otpTab.waitFor({ state: "visible", timeout: 15_000 });
    await otpTab.click();
    await page.waitForTimeout(600);

    await fillVisible(
      page,
      ["input#user", "input#firstInput", 'input[autocomplete="username"]', 'input[type="email"]'],
      username,
      "username",
    );
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    await clickEnabled(
      page,
      [
        'button.cib-btn:has-text("שנמשיך")',
        'button:has-text("שנמשיך")',
        'button.cib-btn:has-text("שלח")',
      ],
      "send-otp",
    );

    // OTP-input field appearing = SMS was sent.
    await page.waitForTimeout(3000);
    const otpField = await detectMfaField(page);
    if (!otpField) {
      return { ok: false, reason: "no OTP input — likely bad username or unexpected page state" };
    }

    // Hand off to caller to fetch the code (Gmail / webhook poll).
    let code: string;
    try {
      code = await fetchOtp();
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }

    await otpField.fill(code);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    await clickEnabled(
      page,
      [
        'button.cib-btn:has-text("אישור")',
        'button.cib-btn:has-text("כניסה")',
        'button.cib-btn:has-text("שלח")',
        'button.cib-btn:has-text("אימות")',
        'button:has-text("Submit")',
        'button.cib-btn',
      ],
      "otp-submit",
    );

    // Login redirect away from /login = success.
    await page
      .waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 30_000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
    if (page.url().includes("/login")) {
      return { ok: false, reason: "login did not complete — OTP may have been wrong", code };
    }
    return { ok: true, reason: "login complete, profile saved", code };
  } finally {
    await ctx?.close();
  }
}
