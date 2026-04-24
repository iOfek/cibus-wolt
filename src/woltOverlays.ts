import type { Page } from "playwright";
import { logger } from "./logger.ts";

export async function dismissWoltOverlays(page: Page): Promise<void> {
  await dismissCookieBanner(page);
  await dismissGenericModalClose(page);
}

async function dismissCookieBanner(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Use only necessary")',
    'button:has-text("Only necessary")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Allow")',
    '[data-localization-key*="cookie" i] button',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 200 }))) continue;
        await el.click({ timeout: 2000 });
        logger.debug({ sel, index: i }, "Dismissed cookie banner");
        await page.waitForTimeout(500);
        return;
      } catch {
        /* try next */
      }
    }
  }
}

async function dismissGenericModalClose(page: Page): Promise<void> {
  const closeButtons = [
    '[aria-label="Close" i]',
    '[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
  ];
  for (const sel of closeButtons) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 200 }))) continue;
        const role = await el.evaluate((n) => {
          const btn = n as HTMLElement;
          return btn.closest('[role="dialog"]')?.textContent?.toLowerCase() ?? "";
        });
        if (role.includes("log in") || role.includes("sign in") || role.includes("account")) continue;
        /* leave login modal open; only close cookie / misc overlays */
      } catch {
        /* ignore */
      }
    }
  }
}
