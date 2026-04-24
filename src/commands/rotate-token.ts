/* eslint-disable no-console */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { paths, ensureStateDir } from "../paths.ts";

export async function runRotateTokenCommand(): Promise<void> {
  await ensureStateDir();
  const fresh = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(paths.webhookToken, fresh, { mode: 0o600 });
  console.log("✓ Webhook token rotated.");
  console.log("Restart the server for changes to take effect:");
  console.log("  npm run mcp   (or: launchctl unload + load the plist)");
  console.log("Then update your phone Shortcut with the new webhook URL: cibus-wolt webhook-url");
}
