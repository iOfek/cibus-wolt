import { config } from "../config.ts";
import { fetchWoltMagicLink, tryLoadGmailCreds } from "../gmail.ts";
import { logger } from "../logger.ts";

async function main() {
  const creds = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
  if (!creds) {
    logger.error("GMAIL_USER and/or GMAIL_APP_PASSWORD not set");
    process.exit(1);
  }
  logger.info("👉 Go to wolt.com in your browser, request a magic-link email NOW. I'll poll for 3 minutes.");
  const url = await fetchWoltMagicLink({
    creds,
    since: new Date(Date.now() - 5 * 60_000),
    expectEmail: process.env.WOLT_EMAIL ?? "",
    timeoutMs: 3 * 60_000,
    pollMs: 5_000,
  });
  logger.info({ url }, "✅ Magic link retrieved");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Gmail test failed");
  process.exit(1);
});
