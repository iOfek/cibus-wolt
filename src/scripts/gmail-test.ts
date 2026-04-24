import { config } from "../config.ts";
import { fetchWoltMagicLink, getAuthClient } from "../gmail.ts";
import { logger } from "../logger.ts";

async function main() {
  const auth = await getAuthClient(config.google.clientId, config.google.clientSecret);
  logger.info("👉 Go to wolt.com in your browser, request a magic-link email NOW. I'll poll for 3 minutes.");
  const url = await fetchWoltMagicLink({
    auth,
    since: new Date(Date.now() - 5 * 60_000),
    expectEmail: config.wolt.email,
    timeoutMs: 3 * 60_000,
    pollMs: 5_000,
  });
  logger.info({ url }, "✅ Magic link retrieved");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Gmail test failed");
  process.exit(1);
});
