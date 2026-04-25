import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * All user-specific state lives under ~/.cibus-wolt/. This module is the
 * single source of truth for those paths. First-run migration pulls existing
 * project-relative state (from early development) into this layout so upgrades
 * are seamless.
 */

const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, ".cibus-wolt");

export const paths = {
  dir: STATE_DIR,
  config: path.join(STATE_DIR, "config.json"),
  token: path.join(STATE_DIR, "token.json"),
  webhookToken: path.join(STATE_DIR, "webhook-token"),
  chromeProfile: path.join(STATE_DIR, "chrome-profile"),
  chromeProfileCibus: path.join(STATE_DIR, "chrome-profile-cibus"),
  logsDir: path.join(STATE_DIR, "logs"),
  runs: path.join(STATE_DIR, "runs.jsonl"),
  screenshots: path.join(STATE_DIR, "screenshots"),
  migrationMarker: path.join(STATE_DIR, ".migrated-v1"),
  tunnelHostname: path.join(STATE_DIR, "tunnel-hostname"),
  tunnelKind: path.join(STATE_DIR, "tunnel-kind"),
  devtunnelId: path.join(STATE_DIR, "devtunnel-id"),
  schedules: path.join(STATE_DIR, "schedules.json"),
  missed: path.join(STATE_DIR, "missed.jsonl"),
};

interface MigrationStep {
  from: string;
  to: string;
  kind: "file" | "dir";
}

const MIGRATIONS: MigrationStep[] = [
  { from: path.resolve("token.json"), to: paths.token, kind: "file" },
  { from: path.resolve("user-data"), to: paths.chromeProfile, kind: "dir" },
  { from: path.resolve("user-data-cibus"), to: paths.chromeProfileCibus, kind: "dir" },
  { from: path.resolve("runs.jsonl"), to: paths.runs, kind: "file" },
  { from: path.resolve("screenshots"), to: paths.screenshots, kind: "dir" },
  { from: path.resolve("logs"), to: paths.logsDir, kind: "dir" },
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.cibus-wolt/ exists with subdirs, and migrates legacy
 * project-relative state once. Idempotent — the marker file short-circuits
 * subsequent calls.
 */
export async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.screenshots, { recursive: true });

  if (existsSync(paths.migrationMarker)) return;

  for (const step of MIGRATIONS) {
    if (!(await exists(step.from))) continue;
    if (await exists(step.to)) continue;
    try {
      await fs.rename(step.from, step.to);
      // eslint-disable-next-line no-console
      console.error(`Migrated ${step.kind} ${step.from} → ${step.to}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error(`Migration skipped ${step.from} → ${step.to}: ${msg}`);
    }
  }

  await fs.writeFile(paths.migrationMarker, new Date().toISOString(), "utf8");
}

/**
 * Returns a per-run screenshot directory path (doesn't create it).
 */
export function screenshotDirFor(prefix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(paths.screenshots, `${prefix}-${ts}`);
}
