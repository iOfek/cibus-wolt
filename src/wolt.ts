import type { OAuth2Client } from "google-auth-library";
import type { BrowserContext, FrameLocator, Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchCibusOtp } from "./gmail.ts";
import { logger } from "./logger.ts";
import { dismissWoltOverlays } from "./woltOverlays.ts";

export interface BuyGiftCardOpts {
  page: Page;
  context: BrowserContext;
  amount: number;
  cibus: { username: string; password: string; authMode: "password" | "otp" };
  /** Required unless fetchOtp is provided (used for Gmail-polling OTP fetch in OTP mode). */
  auth?: OAuth2Client;
  dryRun: boolean;
  screenshotDir: string;
  /**
   * Override to fetch the Cibus OTP from an external source (MCP pause/resume).
   * Receives the click-submit timestamp so the resolver can filter out OTPs
   * issued before the SMS-trigger click.
   */
  fetchOtp?: (since: Date) => Promise<string>;
}

export interface BuyGiftCardResult {
  status: "success" | "dry-run";
  amount: number;
  url?: string;
}

export async function buyAndRedeemWoltGiftCard(opts: BuyGiftCardOpts): Promise<BuyGiftCardResult> {
  const { page, amount, cibus, auth, dryRun, screenshotDir, fetchOtp } = opts;
  await fs.mkdir(screenshotDir, { recursive: true });

  const shot = async (name: string) => {
    const p = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  };

  logger.info({ amount }, "Navigating to Wolt gift-card shop");
  await page.goto("https://wolt.com/en/gift-card-shop/isr", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissWoltOverlays(page);
  await shot("01-gift-card-shop");

  const otherBtn = page
    .getByRole("button", { name: /^other$/i })
    .or(page.getByText(/^other$/i, { exact: true }));
  await otherBtn.first().waitFor({ state: "visible", timeout: 20_000 });
  await otherBtn.first().click();
  await page.waitForTimeout(500);
  await shot("02-selected-other");

  await ensureBuyingForMyself(page);
  await shot("03-self-toggle-on");

  await setAmount(page, amount);
  await shot("04-amount-entered");

  const continueBtn = page
    .getByRole("button", { name: new RegExp(`continue`, "i") });
  await continueBtn.first().waitFor({ state: "visible", timeout: 10_000 });
  await continueBtn.first().click();
  await page.waitForTimeout(2000);
  await shot("05-after-continue");

  await selectCibusPayment(page);
  await shot("06-cibus-selected");

  const payBtn = page
    .getByRole("button", { name: /click to pay/i })
    .or(page.getByRole("button", { name: /לחץ.*לתשלום/ }))
    .or(page.getByRole("button", { name: /^pay$/i }));
  await payBtn.first().waitFor({ state: "visible", timeout: 10_000 });
  await payBtn.first().click();
  logger.info("Clicked 'Click to pay' — Cibus iframe should load");
  await page.waitForTimeout(5000);
  await shot("07-pay-clicked");

  await signInCibusPopup(page, cibus, auth, fetchOtp);
  await shot("08-cibus-signed-in");

  if (dryRun) {
    logger.warn({ amount }, "DRY_RUN=1 — stopping before Cibus payment confirm (no charge)");
    await shot("99-dry-run-stop");
    return { status: "dry-run", amount };
  }

  await confirmCibusPayment(page);
  await shot("09-cibus-authorized");

  await clickRedeemTwice(page);
  await shot("10-redeemed");

  const url = page.url();
  return { status: "success", amount, url };
}

async function ensureBuyingForMyself(page: Page): Promise<void> {
  const toggle = page
    .getByRole("switch", { name: /buying for myself/i })
    .or(page.locator('[role="switch"]').filter({ hasText: /myself/i }));

  try {
    await toggle.first().waitFor({ state: "visible", timeout: 5000 });
    const checked = await toggle.first().getAttribute("aria-checked");
    if (checked !== "true") {
      await toggle.first().click();
      await page.waitForTimeout(500);
    }
  } catch {
    logger.warn("Could not locate 'Buying for myself' toggle — assuming already on");
  }
}

async function setAmount(page: Page, amount: number): Promise<void> {
  const input = page
    .locator('[data-test-id="amount-chooser-custom-input"]')
    .or(page.locator('input[aria-label="Custom gift card amount"]'))
    .or(page.locator('input[aria-label*="gift card amount" i]'))
    .or(page.locator('input[type="number"]'))
    .or(page.locator('input[inputmode="numeric"]'))
    .or(page.getByRole("spinbutton"))
    .first();

  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.click();
  await input.press("ControlOrMeta+A").catch(() => {});
  await input.fill(String(amount));
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
}

async function selectCibusPayment(page: Page): Promise<void> {
  // Open the Payment methods modal if not already open
  const modalTitle = page.getByText(/^Payment methods$/i);
  const modalOpen = await modalTitle.first().isVisible({ timeout: 500 }).catch(() => false);
  if (!modalOpen) {
    const paymentTrigger = page
      .getByRole("button", { name: /payment/i })
      .or(page.getByText(/payment/i).locator(".."));
    if (await paymentTrigger.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await paymentTrigger.first().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  await modalTitle.first().waitFor({ state: "visible", timeout: 10_000 });

  const cibusBtn = page.locator('[data-payment-method-id="cibus"]').first();
  await cibusBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cibusBtn.click();
  logger.info("Cibus payment method selected");
  await page.waitForTimeout(1200);

  // Close the payment-methods modal if it's open
  const closeBtn = page
    .locator('#cb-portal [aria-label="Close" i]')
    .or(page.locator('[aria-label="Close" i]'))
    .first();
  if (await closeBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
    await closeBtn.click();
    logger.info("Payment methods modal closed via X");
    await page.waitForTimeout(1200);
  }
}

async function tickRememberInFrame(cibusFrame: FrameLocator): Promise<void> {
  // 1) English attribute selectors.
  const candidates = [
    'input#remember-me-checkbox',
    'input[type="checkbox"][id*="remember" i]',
    'input[type="checkbox"][name*="remember" i]',
  ];
  for (const sel of candidates) {
    const loc = cibusFrame.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
      const checked = await el.isChecked().catch(() => true);
      if (!checked) {
        await el.check().catch(async () => { await el.click().catch(() => {}); });
        logger.debug({ sel, index: i }, "Cibus iframe: ticked 'remember' checkbox");
      }
      return;
    }
  }

  // 2) Hebrew accessibility-name fallback — covers "זכור מכשיר זה" on the
  //    SMS-MFA screen where the input has no remember-y id/name.
  const byRole = cibusFrame.getByRole("checkbox", { name: /זכור/ });
  const roleCount = await byRole.count().catch(() => 0);
  for (let i = 0; i < roleCount; i++) {
    const el = byRole.nth(i);
    if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const checked = await el.isChecked().catch(() => true);
    if (!checked) {
      await el.check().catch(async () => { await el.click().catch(() => {}); });
      logger.debug({ index: i }, "Cibus iframe: ticked 'remember' via role/name");
    }
    return;
  }

  // 3) Last resort — click the label text directly (toggles its for=… input).
  const labelled = cibusFrame.locator('label:has-text("זכור")').first();
  if (await labelled.isVisible({ timeout: 200 }).catch(() => false)) {
    await labelled.click().catch(() => {});
    logger.debug("Cibus iframe: clicked 'זכור' label");
  }
}

async function signInWithPermanentPassword(
  page: Page,
  cibusFrame: FrameLocator,
  username: string,
  password: string,
): Promise<void> {
  const permTab = cibusFrame.getByText(/סיסמה קבועה/).first();
  try {
    await permTab.waitFor({ state: "visible", timeout: 30_000 });
    await permTab.click().catch(() => {});
  } catch {
    logger.warn("Cibus permanent-password tab not located — continuing");
  }

  await fillFirstVisibleInFrame(
    cibusFrame,
    username,
    'input#user',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[type="text"]:not([id="vendor-search-handler"])',
  );
  await page.waitForTimeout(400);

  await clickFirstEnabledInFrame(
    cibusFrame,
    'button.cib-btn.cib-pink-grad:has-text("שנמשיך")',
    'button.cib-btn:has-text("שנמשיך")',
    'button:has-text("שנמשיך")',
  );
  logger.debug("Cibus iframe: advanced past username");

  await fillFirstVisibleInFrame(
    cibusFrame,
    password,
    'input#password',
    'input[type="password"]',
  );
  await page.waitForTimeout(400);

  // Tick "זכור" checkbox so Cibus remembers this device and skips MFA next time
  await tickRememberInFrame(cibusFrame);
  await page.waitForTimeout(200);

  await clickFirstEnabledInFrame(
    cibusFrame,
    'button.cib-btn.cib-pink-grad:has-text("כניסה")',
    'button.cib-btn:has-text("כניסה")',
    'button:has-text("כניסה")',
  );
}

async function signInWithOtp(
  page: Page,
  cibusFrame: FrameLocator,
  username: string,
  auth: OAuth2Client | undefined,
  fetchOtp?: (since: Date) => Promise<string>,
): Promise<void> {
  logger.info("Cibus sign-in: OTP mode");

  // Switch to the OTP tab
  const otpTab = cibusFrame.locator('.tab.code, div.tab.code, [class*="tab"]:has-text("קוד חד פעמי")').first();
  await otpTab.waitFor({ state: "visible", timeout: 30_000 });
  await otpTab.click();
  await page.waitForTimeout(600);

  await fillFirstVisibleInFrame(
    cibusFrame,
    username,
    'input#firstInput',
    'input[id*="first" i]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[type="text"]:not([id="vendor-search-handler"])',
  );
  await page.waitForTimeout(400);

  const submittedAt = new Date();

  // Send OTP
  await clickFirstEnabledInFrame(
    cibusFrame,
    'button.cib-btn.cib-pink-grad:has-text("שנמשיך")',
    'button.cib-btn:has-text("שנמשיך")',
    'button.cib-btn:has-text("שלח")',
    'button.cib-btn',
  );
  logger.info("Cibus OTP request submitted; polling Gmail for code");

  // Wait for the OTP field to appear, then tick "זכור מכשיר זה" *before*
  // blocking on Gmail/MCP — that way the user-visible state is correct
  // while we wait, and Cibus actually trusts the device on submit.
  const otpField = cibusFrame
    .locator(
      'input[maxlength="6"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"][maxlength], input#code, input[name*="code" i]',
    )
    .first();
  await otpField.waitFor({ state: "visible", timeout: 20_000 });
  await tickRememberInFrame(cibusFrame);

  let code: string;
  if (fetchOtp) {
    code = await fetchOtp(submittedAt);
  } else if (auth) {
    code = await fetchCibusOtp({
      auth,
      since: submittedAt,
      timeoutMs: 120_000,
      pollMs: 5_000,
    });
  } else {
    throw new Error("Cibus OTP required but no Gmail auth and no external provider (MCP must pass fetchOtp).");
  }

  await otpField.fill(code);
  await page.waitForTimeout(400);

  // Tick "זכור" checkbox so Cibus remembers this device
  await tickRememberInFrame(cibusFrame);
  await page.waitForTimeout(200);

  // Submit OTP
  await clickFirstEnabledInFrame(
    cibusFrame,
    'button.cib-btn.cib-pink-grad:has-text("אישור")',
    'button.cib-btn:has-text("כניסה")',
    'button.cib-btn:has-text("שלח")',
    'button.cib-btn',
  );
}

async function fillFirstVisibleInFrame(frame: FrameLocator, value: string, ...selectors: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const all = frame.locator(sel);
      const count = await all.count();
      for (let i = 0; i < count; i++) {
        const el = all.nth(i);
        try {
          if (!(await el.isVisible({ timeout: 200 }))) continue;
          await el.fill(value);
          logger.debug({ sel, index: i }, "Filled in iframe");
          return;
        } catch {
          /* try next */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No visible input in iframe within 20s (tried: ${selectors.join(", ")})`);
}

async function clickFirstEnabledInFrame(frame: FrameLocator, ...selectors: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const all = frame.locator(sel);
      const count = await all.count();
      for (let i = 0; i < count; i++) {
        const el = all.nth(i);
        try {
          if (!(await el.isVisible({ timeout: 200 }))) continue;
          if (!(await el.isEnabled().catch(() => true))) continue;
          await el.click();
          logger.debug({ sel, index: i }, "Clicked in iframe");
          return;
        } catch {
          /* try next */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No enabled element in iframe within 15s (tried: ${selectors.join(", ")})`);
}

async function signInCibusPopup(
  page: Page,
  creds: { username: string; password: string; authMode: "password" | "otp" },
  auth: OAuth2Client | undefined,
  fetchOtp?: (since: Date) => Promise<string>,
): Promise<void> {
  logger.info({ authMode: creds.authMode }, "Waiting for Cibus iframe to render (up to 30s)");

  // Wait for the Cibus iframe to actually exist in the DOM
  const iframeSel = 'iframe[src*="cibus"], iframe[src*="pluxee"]';
  await page.locator(iframeSel).first().waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(2000);

  const cibusFrame = page.frameLocator(iframeSel).first();

  // Dismiss OneTrust cookie banner inside the Cibus iframe
  const cookieAccept = cibusFrame.locator('#onetrust-accept-btn-handler').first();
  try {
    await cookieAccept.waitFor({ state: "visible", timeout: 5000 });
    await cookieAccept.click();
    logger.debug("Dismissed Cibus iframe cookie banner");
    await page.waitForTimeout(500);
  } catch {
    logger.debug("No Cibus iframe cookie banner");
  }

  // Fast path: if Cibus session is still valid, the final confirm button shows immediately
  const confirmBtn = cibusFrame.locator('button.cib-btn:has-text("אישור התשלום")').first();
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    logger.info("Cibus session still valid — skipping sign-in, confirm screen already visible");
    return;
  }

  if (creds.authMode === "otp") {
    await signInWithOtp(page, cibusFrame, creds.username, auth, fetchOtp);
  } else {
    await signInWithPermanentPassword(page, cibusFrame, creds.username, creds.password);
  }
  logger.info("Cibus sign-in submitted; waiting for confirmation screen or second MFA");

  // Two possible next screens:
  //   a) Confirm button (אישור התשלום) — ready to pay
  //   b) A second OTP prompt — Cibus wants a fresh SMS code before authorising
  //
  // Race the two; handle OTP if it shows up, then re-wait for the confirm button.
  await handleMaybeSecondMfa(page, cibusFrame, auth, fetchOtp);
}

async function handleMaybeSecondMfa(
  page: Page,
  cibusFrame: FrameLocator,
  auth: OAuth2Client | undefined,
  fetchOtp: ((since: Date) => Promise<string>) | undefined,
): Promise<void> {
  // Floor for OTP freshness: capture before we start watching. Cibus triggers
  // the second SMS after the first OTP submit (which already happened); the
  // forwarded email's internalDate will be later than this in practice
  // because of iOS Shortcut → Gmail forwarding latency.
  const watchStartedAt = new Date();

  const confirmBtn = cibusFrame.locator('button.cib-btn:has-text("אישור התשלום")').first();
  const otpField = cibusFrame
    .locator(
      'input[maxlength="6"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"][maxlength], input#code, input[name*="code" i]',
    )
    .first();

  const winner = await Promise.race([
    confirmBtn.waitFor({ state: "visible", timeout: 45_000 }).then(() => "confirm" as const),
    otpField.waitFor({ state: "visible", timeout: 45_000 }).then(() => "otp" as const),
  ]).catch(() => null);

  if (winner === "confirm") {
    logger.info("Cibus confirmation screen visible (no second MFA)");
    return;
  }

  if (winner === "otp") {
    logger.warn("Cibus asked for a second OTP after login — resolving via input bus");
    // Tick "זכור מכשיר זה" before we block on Gmail/MCP for the code.
    await tickRememberInFrame(cibusFrame);
    const { resolveOtp } = await import("./inputs.ts");
    const code = fetchOtp
      ? await fetchOtp(watchStartedAt)
      : await resolveOtp(5 * 60_000, { auth, allowStdin: true, since: watchStartedAt });
    await otpField.fill(code);
    await page.waitForTimeout(400);
    // Tick remember checkbox if present (second MFA often shows it too)
    await tickRememberInFrame(cibusFrame);
    await page.waitForTimeout(200);
    // Submit the OTP form — same button pattern as the main Cibus signin
    await clickFirstEnabledInFrame(
      cibusFrame,
      'button.cib-btn.cib-pink-grad:has-text("אישור")',
      'button.cib-btn.cib-pink-grad:has-text("כניסה")',
      'button.cib-btn:has-text("אישור")',
      'button.cib-btn:has-text("כניסה")',
      'button.cib-btn',
    );
    logger.info("Second-MFA OTP submitted; waiting for confirmation screen");
    await confirmBtn.waitFor({ state: "visible", timeout: 45_000 });
    logger.info("Cibus confirmation screen visible");
    return;
  }

  throw new Error("Neither confirm button nor OTP prompt appeared in Cibus iframe within 45s");
}

async function confirmCibusPayment(page: Page): Promise<void> {
  const cibusFrame = page.frameLocator('iframe[src*="cibus"], iframe[src*="pluxee"]').first();
  const confirmBtn = cibusFrame.locator('button.cib-btn:has-text("אישור התשלום")').first();
  await confirmBtn.waitFor({ state: "visible", timeout: 30_000 });
  await confirmBtn.click();
  logger.info("Cibus payment confirmed");
  await page.waitForTimeout(3000);
}

async function clickRedeemTwice(page: Page): Promise<void> {
  logger.info("Waiting for Wolt thank-you / redeem screen");
  const redeem = page.getByRole("button", { name: /^redeem$/i });
  await redeem.first().waitFor({ state: "visible", timeout: 30_000 });
  await redeem.first().click();
  await page.waitForTimeout(1500);

  const redeem2 = page.getByRole("button", { name: /^redeem$/i });
  if (await redeem2.first().isVisible().catch(() => false)) {
    await redeem2.first().click();
    await page.waitForTimeout(1500);
  }
  logger.info("Gift card redeemed");
}
