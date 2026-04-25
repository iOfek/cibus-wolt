import fs from "node:fs/promises";
import { logger } from "../logger.ts";
import { paths } from "../paths.ts";

type Scope = "all" | "gmail" | "cibus" | "wolt" | "webhook" | "logs";

const map: Record<Scope, string[]> = {
  gmail: [paths.token],
  cibus: [paths.chromeProfileCibus],
  wolt: [paths.chromeProfile, paths.woltCookies],
  webhook: [paths.webhookToken],
  logs: [paths.logsDir, paths.screenshots, paths.runs],
  all: [paths.token, paths.chromeProfile, paths.chromeProfileCibus, paths.woltCookies, paths.webhookToken],
};

export async function runResetCommand(args: string[]): Promise<void> {
  const scope = (args[0] ?? "all") as Scope;
  if (!(scope in map)) {
    throw new Error(`Unknown reset scope: ${scope}. Valid: ${Object.keys(map).join(", ")}`);
  }
  const targets = map[scope];
  logger.warn({ scope, targets }, "Wiping cached state");
  for (const p of targets) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      logger.info({ path: p }, "Removed");
    } catch (e) {
      logger.error({ path: p, err: e instanceof Error ? e.message : String(e) }, "Failed to remove");
    }
  }
  logger.info("✓ Reset complete");
}
