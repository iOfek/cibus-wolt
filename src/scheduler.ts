import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import {
  type Cadence,
  type Schedule,
  loadSchedulesState,
  saveSchedulesState,
} from "./schedules.ts";
import { getActiveRun } from "./mcp/runRegistry.ts";

// ────────────────────────────────────────────────────────────────────────────
// Period math
//
// Conventions (Israeli Cibus norm):
//   • Week starts Sunday 00:00 local — dayOfWeek 0=Sun..6=Sat.
//   • Month = calendar month (local).
//   • Day = calendar day (local).
// ────────────────────────────────────────────────────────────────────────────

export function periodKey(date: Date, cadence: Cadence): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (cadence === "daily") return `${y}-${m}-${d}`;
  if (cadence === "monthly") return `${y}-${m}`;
  // weekly: key = ISO-like "YYYY-MM-DD" of the Sunday at the start of the week
  const start = periodStart(date, "weekly");
  const sy = start.getFullYear();
  const sm = String(start.getMonth() + 1).padStart(2, "0");
  const sd = String(start.getDate()).padStart(2, "0");
  return `W${sy}-${sm}-${sd}`;
}

export function periodStart(date: Date, cadence: Cadence): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (cadence === "daily") return d;
  if (cadence === "monthly") {
    d.setDate(1);
    return d;
  }
  // weekly: roll back to Sunday
  const dow = d.getDay(); // 0=Sun..6=Sat
  d.setDate(d.getDate() - dow);
  return d;
}

export function periodEnd(date: Date, cadence: Cadence): Date {
  const start = periodStart(date, cadence);
  const end = new Date(start);
  if (cadence === "daily") end.setDate(end.getDate() + 1);
  else if (cadence === "monthly") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + 7);
  return end;
}

/** Compute the schedule's scheduled fire time within the period containing `ref`. */
export function fireTimeForPeriod(schedule: Schedule, cadence: Cadence, ref: Date): Date {
  const start = periodStart(ref, cadence);
  const [hStr, mStr] = schedule.time.split(":");
  const h = Number(hStr), m = Number(mStr);
  if (cadence === "weekly") {
    const dow = schedule.dayOfWeek ?? 0;
    const d = new Date(start);
    d.setDate(d.getDate() + dow);
    d.setHours(h, m, 0, 0);
    return d;
  }
  if (cadence === "monthly") {
    const d = new Date(start);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const dom = schedule.dayOfMonth === -1 ? daysInMonth : Math.min(schedule.dayOfMonth ?? 1, daysInMonth);
    d.setDate(dom);
    d.setHours(h, m, 0, 0);
    return d;
  }
  // daily
  const d = new Date(start);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Next time this schedule should fire, looking only forward from `now`. */
export function nextFireTime(schedule: Schedule, cadence: Cadence, now: Date): Date {
  const thisPeriod = fireTimeForPeriod(schedule, cadence, now);
  if (thisPeriod.getTime() > now.getTime()) return thisPeriod;
  // Look at the start of the next period.
  const nextPeriodRef = periodEnd(now, cadence);
  return fireTimeForPeriod(schedule, cadence, nextPeriodRef);
}

// ────────────────────────────────────────────────────────────────────────────
// Notification for missed periods
// ────────────────────────────────────────────────────────────────────────────

interface MissedRecord {
  ts: string;
  scheduleId: string;
  scheduleName?: string;
  missedPeriodKey: string;
  reason: string;
}

async function appendMissed(rec: MissedRecord): Promise<void> {
  try {
    await fs.appendFile(paths.missed, JSON.stringify(rec) + "\n");
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Failed to append missed.jsonl");
  }
}

function notifyDesktop(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  try {
    // display notification "<body>" with title "<title>"
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

async function notifyMissed(schedule: Schedule, missedPeriodKey: string, reason: string): Promise<void> {
  const name = schedule.name ?? `schedule ${schedule.id.slice(0, 8)}`;
  await appendMissed({
    ts: new Date().toISOString(),
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    missedPeriodKey,
    reason,
  });
  logger.warn({ scheduleId: schedule.id, missedPeriodKey, reason }, `Missed scheduled drain: ${name}`);
  notifyDesktop("Cibus-Wolt: missed drain", `${name} — period ${missedPeriodKey} passed without draining. ${reason}`);
}

export async function readMissed(limit = 20): Promise<MissedRecord[]> {
  try {
    const raw = await fs.readFile(paths.missed, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as MissedRecord);
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

const TICK_MS = 60_000;
/** Grace: don't fire catch-up if we're more than this far past the scheduled time AND the period has nearly ended. */
const NEAR_PERIOD_END_SAFETY_MS = 5 * 60_000;

let tickTimer: NodeJS.Timeout | null = null;
let fileWatcher: ReturnType<typeof import("node:fs").watch> | null = null;
/** In-flight schedule ids — prevents re-entrant fires from the same tick. */
const firing = new Set<string>();

/**
 * Reconcile every schedule against the current wall-clock time. Fires catch-ups,
 * arms for upcoming periods, logs misses that crossed period boundaries.
 */
async function reconcile(): Promise<void> {
  const state = await loadSchedulesState();
  const now = new Date();
  const nowKey = periodKey(now, state.cadence);
  let dirty = false;

  for (const s of state.schedules) {
    if (!s.enabled) continue;
    if (firing.has(s.id)) continue;

    // Detect missed previous period(s) — only mark a miss once per period.
    if (s.lastSuccessPeriodKey && s.lastMissedAt !== undefined) {
      // already recorded; nothing new to do here
    }
    try {
      if (await checkMissedPrevPeriod(s, state.cadence, now)) {
        s.lastMissedAt = new Date().toISOString();
        dirty = true;
      }
    } catch (e) {
      logger.warn({ scheduleId: s.id, err: e instanceof Error ? e.message : String(e) }, "Missed-period check failed");
    }

    // Already fired this period? Skip until next.
    if (s.lastFiredPeriodKey === nowKey) continue;

    const fireTime = fireTimeForPeriod(s, state.cadence, now);
    if (fireTime.getTime() > now.getTime()) continue; // not yet due this period

    // We're past the scheduled time AND haven't fired this period.
    // Safety: if we're within the last few minutes of the period, draining now
    // risks crossing the Cibus reset mid-run. Better to mark missed + skip.
    const end = periodEnd(now, state.cadence);
    if (end.getTime() - now.getTime() < NEAR_PERIOD_END_SAFETY_MS) {
      await notifyMissed(s, nowKey, "fire time elapsed and period is about to roll over");
      s.lastFiredPeriodKey = nowKey; // block further attempts this period
      s.lastMissedAt = new Date().toISOString();
      dirty = true;
      continue;
    }

    // Don't fire if another drain is already running (manual or prior schedule).
    const active = getActiveRun();
    if (active && (active.state === "running" || active.state === "waiting_for_magic_link" || active.state === "waiting_for_otp")) {
      logger.info({ scheduleId: s.id, activeRunId: active.id }, "Skipping scheduled fire — a drain is already in progress");
      continue;
    }

    logger.info(
      { scheduleId: s.id, name: s.name, due: fireTime.toISOString(), now: now.toISOString() },
      "Firing scheduled drain",
    );
    firing.add(s.id);
    s.lastFiredAt = new Date().toISOString();
    s.lastFiredPeriodKey = nowKey;
    dirty = true;

    // Fire-and-forget; settle on completion.
    const amount = s.amount;
    void (async () => {
      try {
        const { runDrainInBackground } = await import("./commands/run.ts");
        const { runId } = runDrainInBackground({ amount });
        await waitForRun(runId);
        // Mark success
        const st = await loadSchedulesState();
        const target = st.schedules.find((x) => x.id === s.id);
        if (target) {
          target.lastSuccessAt = new Date().toISOString();
          target.lastSuccessPeriodKey = nowKey;
          await saveSchedulesState(st);
        }
      } catch (e) {
        logger.error(
          { scheduleId: s.id, err: e instanceof Error ? e.message : String(e) },
          "Scheduled drain failed",
        );
      } finally {
        firing.delete(s.id);
      }
    })();
  }

  if (dirty) await saveSchedulesState(state);
}

async function waitForRun(runId: string): Promise<void> {
  // runRegistry has no subscribe API; poll every 10s.
  const DEADLINE_MS = 60 * 60_000; // 1h safety cap
  const start = Date.now();
  while (Date.now() - start < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 10_000));
    const active = getActiveRun();
    if (!active || active.id !== runId) return;
    if (active.state === "completed" || active.state === "failed") return;
  }
}

/**
 * Returns true if a miss notification was recorded just now.
 * Misses are defined as: a full period ended since lastSuccessPeriodKey without a success,
 * AND it hasn't already been noted.
 */
async function checkMissedPrevPeriod(s: Schedule, cadence: Cadence, now: Date): Promise<boolean> {
  // Only notify for weekly + monthly. Daily misses are too noisy.
  if (cadence === "daily") return false;

  // Avoid duplicate notifications within the same current period.
  if (s.lastMissedAt && periodKey(new Date(s.lastMissedAt), cadence) === periodKey(now, cadence)) {
    return false;
  }

  const prevStart = previousPeriodStart(now, cadence);
  const prevKey = periodKey(prevStart, cadence);

  // Did the schedule exist during the previous period? Only then could it have been missed.
  const created = new Date(s.createdAt);
  if (created.getTime() > prevStart.getTime()) return false;

  // Check if the schedule's fire time for the previous period has passed and
  // no fire/success happened in that period.
  const prevFireTime = fireTimeForPeriod(s, cadence, prevStart);
  if (prevFireTime.getTime() > Date.now()) return false;

  // Successful drain in the previous period? Not a miss.
  if (s.lastSuccessPeriodKey === prevKey) return false;
  // Attempted (failed) fire in the previous period — already logged via runs.jsonl; don't double-notify.
  if (s.lastFiredPeriodKey === prevKey) return false;

  await notifyMissed(s, prevKey, "previous period ended with no drain attempt");
  return true;
}

function previousPeriodStart(date: Date, cadence: Cadence): Date {
  const cur = periodStart(date, cadence);
  const prev = new Date(cur);
  if (cadence === "daily") prev.setDate(prev.getDate() - 1);
  else if (cadence === "monthly") prev.setMonth(prev.getMonth() - 1);
  else prev.setDate(prev.getDate() - 7);
  return prev;
}

export async function startScheduler(): Promise<void> {
  if (tickTimer) return;
  // First reconcile immediately (catch up missed fires from sleep/down-time).
  await reconcile().catch((e) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "Scheduler initial reconcile failed"));
  tickTimer = setInterval(() => {
    reconcile().catch((e) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "Scheduler tick failed"));
  }, TICK_MS);
  // Watch schedules.json for CLI edits so changes take effect without a service restart.
  try {
    const { watch } = await import("node:fs");
    fileWatcher = watch(paths.schedules, { persistent: false }, () => {
      reconcile().catch(() => {});
    });
  } catch {
    // schedules.json might not exist yet; that's fine
  }
  logger.info("Scheduler started (60s tick, catch-up enabled)");
}

export function stopScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (fileWatcher) fileWatcher.close();
  fileWatcher = null;
}
