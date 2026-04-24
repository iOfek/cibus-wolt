import { chromium } from "playwright";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

async function attempt(company: string, headless: boolean): Promise<boolean> {
  logger.info({ company, headless }, "=== Attempt ===");
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "he-IL",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  await page.goto("https://consumers.pluxee.co.il/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  await page.locator("input#user").first().fill(config.cibus.username);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);

  const btns = page.locator('button.cib-btn:has-text("שנמשיך")');
  for (let i = 0; i < (await btns.count()); i++) {
    const el = btns.nth(i);
    if ((await el.isVisible()) && (await el.isEnabled())) {
      await el.click();
      break;
    }
  }
  await page.waitForTimeout(2500);

  const pwField = page.locator('input#password');
  for (let i = 0; i < (await pwField.count()); i++) {
    const el = pwField.nth(i);
    if (await el.isVisible()) {
      await el.fill(config.cibus.password);
      break;
    }
  }
  const companyField = page.locator('input#company-inp').first();
  if (await companyField.isVisible().catch(() => false)) {
    await companyField.fill(company);
  }
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);

  const loginBtns = page.locator('button.cib-btn');
  for (let i = 0; i < (await loginBtns.count()); i++) {
    const el = loginBtns.nth(i);
    const txt = await el.innerText().catch(() => "");
    if ((await el.isVisible()) && (await el.isEnabled()) && txt.includes("כניסה")) {
      await el.click();
      break;
    }
  }

  // Wait for either error or navigation
  const success = await Promise.race([
    page.waitForResponse(
      (r) =>
        r.url().includes("prx_user_info") && r.status() === 200,
      { timeout: 15_000 },
    )
      .then(() => true)
      .catch(() => false),
    page
      .waitForSelector('[class*="error"]:visible', { timeout: 15_000 })
      .then(() => false)
      .catch(() => null),
  ]);

  const result = await page.evaluate(() => ({
    url: location.href,
    err: Array.from(document.querySelectorAll('[class*="error" i]'))
      .map((e) => (e as HTMLElement).innerText.trim())
      .filter(Boolean)
      .slice(0, 3),
  }));
  logger.info({ success, result }, "Result");
  await browser.close();
  return !!success;
}

async function main() {
  const ok = await attempt(config.cibus.company, false);
  if (ok) logger.info("✅ Headful login succeeded");
  else logger.error("❌ Headful login ALSO failed — credentials are likely wrong (or company format is different)");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Inspect failed");
  process.exit(1);
});
