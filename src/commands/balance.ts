import { getCibusWeeklyBalance } from "../cibus.ts";
import { config } from "../config.ts";
import { tryLoadGmailCreds } from "../gmail.ts";
import { logger } from "../logger.ts";
import { ensureStateDir } from "../paths.ts";

export async function runBalanceCommand(): Promise<number> {
  await ensureStateDir();
  const gmail = config.gmailEnabled
    ? tryLoadGmailCreds(config.gmail.user, config.gmail.pass) ?? undefined
    : undefined;
  const balance = await getCibusWeeklyBalance(config.cibus, { gmail });
  logger.info(`✓ Weekly balance: ₪${balance}`);
  return balance;
}
