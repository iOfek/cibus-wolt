/* eslint-disable no-console */
import { config } from "../config.ts";
import { paths } from "../paths.ts";
import { logger } from "../logger.ts";

/**
 * Open a Chrome window for the user to log in to Wolt manually, then exit.
 * Use this when the persistent profile's session has expired (`run` complains
 * "no Wolt session cookie") or when first-time setup needs to seed a session.
 *
 * The session cookie is stored in the dedicated chrome-profile and reused on
 * every subsequent drain — `run` refreshes the expiry on each invocation.
 */
export async function runWoltLoginCommand(): Promise<void> {
  const email = config.wolt.email;

  console.log("Opening Chrome to Wolt's login page. Sign in manually, then come back here.");
  console.log(`Account: ${email}`);
  console.log(`Profile: ${paths.chromeProfile}`);
  console.log("");

  const { acquireBrowser } = await import("../browser.ts");
  const { ensureWoltLoggedIn } = await import("../woltLogin.ts");
  const browser = await acquireBrowser();
  try {
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await ensureWoltLoggedIn({ page, email });
    console.log("");
    console.log(`  ✓ Wolt session saved to ${paths.chromeProfile}`);
    console.log("  Subsequent `cibus-wolt run` calls will reuse this session and silently refresh it.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg }, "Wolt login failed");
    console.log(`  ✗ ${msg}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}
