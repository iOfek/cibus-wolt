import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.ts";
import { IS_MAC, IS_WIN } from "../platform.ts";
import { SERVICE_LABELS } from "../services.ts";

async function uninstallMac(): Promise<void> {
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  for (const label of [SERVICE_LABELS.mac.mcp, SERVICE_LABELS.mac.tunnel]) {
    const plist = path.join(launchAgents, `${label}.plist`);
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
}

function uninstallWin(): void {
  for (const taskName of [SERVICE_LABELS.win.mcp, SERVICE_LABELS.win.tunnel]) {
    try {
      execSync(`schtasks /End /TN "${taskName}"`, { stdio: "ignore" });
    } catch {
      /* not running */
    }
    try {
      execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: "ignore" });
      logger.info({ taskName }, "Removed scheduled task");
    } catch {
      logger.debug({ taskName }, "Task not present (ok)");
    }
  }
}

async function main() {
  if (IS_MAC) await uninstallMac();
  else if (IS_WIN) uninstallWin();
  else {
    logger.error(`Unsupported platform: ${process.platform}.`);
    process.exit(1);
  }
  logger.info("✓ Services uninstalled");
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Uninstall failed");
  process.exit(1);
});
