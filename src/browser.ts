import { chromium, type BrowserContext } from "playwright";
import { existsSync } from "node:fs";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";

/**
 * Acquire a Playwright BrowserContext driving the user's actual Google Chrome
 * binary (not Playwright's bundled Chromium) with a dedicated persistent
 * profile at ~/.cibus-wolt/chrome-profile. The profile caches Wolt/Cibus
 * cookies so logins survive across runs.
 *
 * We pass `channel: "chrome"` AND an explicit `executablePath` so there's no
 * ambiguity about which binary is running. Falls back to bundled Chromium
 * only if Google Chrome isn't installed.
 */
export interface AcquiredBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

export interface BrowserOpts {
  userDataDir?: string;
}

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

function findChromeBinary(): string | null {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function acquireBrowser(opts: BrowserOpts = {}): Promise<AcquiredBrowser> {
  const userDataDir = opts.userDataDir ?? paths.chromeProfile;
  const chromeBin = findChromeBinary();
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const common = {
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
    args,
    acceptDownloads: false,
  } as const;

  if (chromeBin) {
    logger.info({ chromeBin, userDataDir }, "Launching Google Chrome with dedicated profile");
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...common,
      channel: "chrome",
      executablePath: chromeBin,
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    return { context, close: () => context.close().catch(() => {}) };
  }

  logger.warn(
    "⚠ Google Chrome not found at /Applications/Google Chrome.app. Falling back to Playwright's bundled Chromium (higher Wolt bot-detection risk).",
  );
  const context = await chromium.launchPersistentContext(userDataDir, common);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return { context, close: () => context.close().catch(() => {}) };
}
