import fs from "node:fs/promises";
import { logger } from "../logger.ts";
import { paths } from "../paths.ts";

const STATE_PATHS = [paths.token, paths.chromeProfile, paths.chromeProfileCibus];
const OPTIONAL_PATHS = [paths.screenshots, paths.logsDir, paths.runs];

async function rm(p: string): Promise<boolean> {
  try {
    await fs.rm(p, { recursive: true, force: true });
    logger.info({ path: p }, "Removed");
    return true;
  } catch (e) {
    logger.error({ path: p, err: e instanceof Error ? e.message : String(e) }, "Failed to remove");
    return false;
  }
}

async function main() {
  const all = process.argv.includes("--all");
  const targets = all ? [...STATE_PATHS, ...OPTIONAL_PATHS] : STATE_PATHS;
  logger.warn({ targets, all }, "About to wipe cached auth + session state");
  for (const p of targets) await rm(p);
  logger.info("✓ Reset complete. Next run will re-do OAuth + logins from scratch.");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Reset failed");
  process.exit(1);
});
