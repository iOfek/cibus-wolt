import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";

export type PhaseStatus =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

const TOKEN_PATH = paths.token;
const CIBUS_USER_DATA = paths.chromeProfileCibus;
const WOLT_USER_DATA = paths.chromeProfile;

export function logPhaseBanner(index: number, total: number, name: string): void {
  logger.info(`━━━━━━━━━━ [${index}/${total}] ${name} ━━━━━━━━━━`);
}

export async function checkGmail(auth: OAuth2Client): Promise<PhaseStatus> {
  try {
    await fs.access(TOKEN_PATH);
  } catch {
    return { ok: false, reason: "token.json missing (OAuth consent needed)" };
  }
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress ?? "unknown";
    return { ok: true, summary: `Authenticated as ${email}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Gmail API error: ${msg}` };
  }
}

export async function checkCibusSession(): Promise<PhaseStatus> {
  return checkProfile(CIBUS_USER_DATA, "Cibus");
}

export async function checkWoltSession(): Promise<PhaseStatus> {
  return checkProfile(WOLT_USER_DATA, "Wolt");
}

async function checkProfile(userDataDir: string, label: string): Promise<PhaseStatus> {
  try {
    await fs.access(userDataDir);
  } catch {
    return { ok: false, reason: "No profile directory (needs first login)" };
  }

  const candidates = [
    path.join(userDataDir, "Default", "Cookies"),
    path.join(userDataDir, "Default", "Network", "Cookies"),
  ];
  let mtimeMs = 0;
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p);
      if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  if (mtimeMs === 0) {
    return { ok: false, reason: "Profile exists but no cookies file (needs login)" };
  }

  const ageMs = Date.now() - mtimeMs;
  const ageHrs = ageMs / (1000 * 60 * 60);
  const ageDays = ageHrs / 24;

  // Rough staleness heuristic. Wolt and Cibus sessions last weeks-to-months in practice.
  if (ageDays > 60) {
    return { ok: false, reason: `Cookies last updated ${Math.round(ageDays)}d ago — likely stale` };
  }

  const ageStr = ageDays >= 1 ? `${Math.round(ageDays)}d ago` : `${Math.round(ageHrs)}h ago`;
  return { ok: true, summary: `${label} profile cookies updated ${ageStr}` };
}

export interface LastRun {
  ts: string;
  amount: number;
  status: string;
  reason?: string;
  url?: string;
}

export async function getLastRun(): Promise<LastRun | null> {
  const runsPath = paths.runs;
  try {
    const data = await fs.readFile(runsPath, "utf8");
    const lines = data.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1]!;
    return JSON.parse(last) as LastRun;
  } catch {
    return null;
  }
}
