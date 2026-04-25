import { chromium, type BrowserContext } from "playwright";
import { spawn } from "node:child_process";
import net from "node:net";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import { findChrome } from "./platform.ts";

/**
 * Acquire a Playwright BrowserContext driving Google Chrome with our dedicated
 * persistent profile at ~/.cibus-wolt/chrome-profile. The profile caches Wolt
 * cookies so logins survive across runs.
 *
 * Why launch-then-attach (`spawn` + `connectOverCDP`) instead of `launchPersistentContext`?
 * Wolt's bot detection fingerprints CDP signals that Playwright's standard
 * launch path triggers (the Runtime.enable leak, --enable-automation flag,
 * "controlled by automated test software" banner). Launching Chrome ourselves
 * with stock args and attaching after Chrome is fully booted slips past it.
 * Diagnostic that proved this: src/scripts/test-cdp-attach.ts.
 *
 * Falls back to Playwright's bundled Chromium via launchPersistentContext only
 * if Google Chrome isn't installed — that fallback won't bypass bot detection,
 * but at least keeps the script runnable for unrelated debugging.
 */
export interface AcquiredBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

export interface BrowserOpts {
  userDataDir?: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdpReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`);
}

export async function acquireBrowser(opts: BrowserOpts = {}): Promise<AcquiredBrowser> {
  const userDataDir = opts.userDataDir ?? paths.chromeProfile;
  const chromeBin = findChrome();

  if (chromeBin) {
    const port = await findFreePort();
    // Note: deliberately NOT passing --disable-blink-features=AutomationControlled.
    // Chrome shows a yellow "unsupported command-line flag" banner when that's
    // set, which is visual noise for the user. The init script below overrides
    // navigator.webdriver to undefined before any page script runs, achieving
    // the same effect without the banner.
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];
    logger.info({ chromeBin, userDataDir, port }, "Launching Chrome with CDP debug port");
    const proc = spawn(chromeBin, args, { stdio: "ignore", detached: false });

    try {
      await waitForCdpReady(port);
    } catch (e) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      throw e;
    }

    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const close = async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    return { context, close };
  }

  logger.warn(
    "⚠ Google Chrome not found. Falling back to Playwright's bundled Chromium (Wolt bot detection will likely fire).",
  );
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
    args,
    acceptDownloads: false,
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return { context, close: () => context.close().catch(() => {}) };
}
