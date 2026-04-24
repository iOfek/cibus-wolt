import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.ts";

const LAUNCH_AGENTS = path.join(os.homedir(), "Library", "LaunchAgents");
const LABELS = ["com.ofek.cibus-wolt.mcp", "com.ofek.cibus-wolt.tunnel"];

async function main() {
  for (const label of LABELS) {
    const plist = path.join(LAUNCH_AGENTS, `${label}.plist`);
    try {
      execSync(`/bin/launchctl unload -w "${plist}"`, { stdio: "ignore" });
      logger.info({ label }, "Unloaded");
    } catch {
      logger.debug({ label }, "Not loaded (ok)");
    }
    try {
      await fs.unlink(plist);
      logger.info({ plist }, "Removed");
    } catch {
      /* not present */
    }
  }
  logger.info("✓ Services uninstalled");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Uninstall failed");
  process.exit(1);
});
