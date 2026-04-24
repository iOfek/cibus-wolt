import { getCibusWeeklyBalance } from "../cibus.ts";
import { config } from "../config.ts";
import { tryLoadAuthClient } from "../gmail.ts";
import { logger } from "../logger.ts";
import { ensureStateDir } from "../paths.ts";

export async function runBalanceCommand(): Promise<number> {
  await ensureStateDir();
  const auth = config.gmailEnabled
    ? (await tryLoadAuthClient(config.google.clientId, config.google.clientSecret)) ?? undefined
    : undefined;
  const balance = await getCibusWeeklyBalance(config.cibus, { auth });
  logger.info(`✓ Weekly balance: ₪${balance}`);
  return balance;
}
