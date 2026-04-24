import { getCibusWeeklyBalance } from "../cibus.ts";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

async function main() {
  const balance = await getCibusWeeklyBalance(config.cibus);
  logger.info({ balance }, "Cibus balance test succeeded");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Cibus balance test failed");
  process.exit(1);
});
