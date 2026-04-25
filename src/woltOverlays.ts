import type { Page } from "playwright";
import { logger } from "./logger.ts";

export async function dismissWoltOverlays(page: Page): Promise<void> {
  await dismissCookieBanner(page);
  await dismissGenericModalClose(page);
}

async function dismissCookieBanner(page: Page): Promise<void> {
  // Cookie banners often render after page hydration — give it a moment to appear.
  // Then poll a wide set of selectors covering Wolt's own banner, OneTrust,
  // Cookiebot, and Hebrew/English variants.
  const candidates = [
    // Wolt's own (Aalto)
    'button[data-test-id*="cookie" i]',
    'button[data-localization-key*="cookie" i]',
    '[data-localization-key*="cookie" i] button',
    // OneTrust (very common)
    "#onetrust-accept-btn-handler",
    "#onetrust-reject-all-handler",
    // Cookiebot
    "#CybotCookiebotDialogBodyButtonAccept",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    // Generic ID/class hints
    '[id*="cookie" i] button',
    '[class*="cookie" i] button',
    // Aalto button label divs (Wolt renders <button><div>...<div>Text</div></div></button>)
    'button:has-text("Use only necessary")',
    'button:has-text("Only necessary")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Allow")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    // Hebrew
    'button:has-text("קבל")',
    'button:has-text("אישור")',
    'button:has-text("רק הכרחיות")',
    // Aalto-class buttons (when not wrapped in <button>)
    '[class*="al-Button"]:has-text("Accept")',
    '[class*="al-Button"]:has-text("Only necessary")',
    '[class*="al-Button"]:has-text("Use only necessary")',
  ];

  // Up to 3 attempts with 500ms gaps — cookie banner may render slightly after
  // our first call, especially after a fresh-profile launch.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of candidates) {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        try {
          if (!(await el.isVisible({ timeout: 200 }))) continue;
          await el.click({ timeout: 2000 });
          logger.debug({ sel, index: i, attempt }, "Dismissed cookie banner");
          await page.waitForTimeout(500);
          return;
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(500);
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
