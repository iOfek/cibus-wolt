/* eslint-disable no-console */
import { paths } from "../paths.ts";
import { logger } from "../logger.ts";
import { blank, cmd, failure, info, note, success, val } from "../ui.ts";

/**
 * Open a Chrome window for the user to log in to Wolt manually, then exit.
 * Use this when the persistent profile's session has expired (`run` complains
 * "no Wolt session cookie") or when first-time setup needs to seed a session.
 *
 * The session cookie is stored in the dedicated chrome-profile and reused on
 * every subsequent drain — `run` refreshes the expiry on each invocation.
 */
export async function runWoltLoginCommand(): Promise<void> {
  info("Opening Chrome to Wolt's login page. Sign in manually, then come back here.");
  note(`Profile: ${val(paths.chromeProfile)}`);
  blank();

  const { acquireBrowser } = await import("../browser.ts");
  const { ensureWoltLoggedIn } = await import("../woltLogin.ts");
  const browser = await acquireBrowser();
  try {
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await ensureWoltLoggedIn({ page });
    blank();
    success(`Wolt session saved to ${val(paths.chromeProfile)}`);
    note(`Subsequent ${cmd("cibus-wolt run")} calls will reuse this session and silently refresh it.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg }, "Wolt login failed");
    failure(msg);
    process.exit(1);
  } finally {
    await browser.close();
  }
}
