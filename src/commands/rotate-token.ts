/* eslint-disable no-console */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { paths, ensureStateDir } from "../paths.ts";
import { blank, cmd, info, note, success } from "../ui.ts";

export async function runRotateTokenCommand(): Promise<void> {
  await ensureStateDir();
  const fresh = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(paths.webhookToken, fresh, { mode: 0o600 });
  success("Webhook token rotated.");
  blank();
  note("Restart the server for changes to take effect:");
  info(`${cmd("npm run mcp")}   (or re-run ${cmd("npm run install-bg")} to bounce the background service)`);
  blank();
  note(`Then update your phone Shortcut with the new webhook URL: ${cmd("cibus-wolt webhook-url")}`);
}
