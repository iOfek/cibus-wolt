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
 * Google Chrome is required — there is no bundled-Chromium fallback because
 * Wolt's bot detection trips on it anyway.
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

  throw new Error(
    "Google Chrome not found. Install it from https://www.google.com/chrome/ — this tool requires real Chrome (Wolt's bot detection blocks bundled Chromium).",
  );
}
