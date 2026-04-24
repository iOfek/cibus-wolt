import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { paths } from "./paths.ts";

export type Cadence = "weekly" | "monthly" | "daily";

export interface Schedule {
  id: string;
  name?: string;
  /** 0=Sun .. 6=Sat. Used when cadence === "weekly". */
  dayOfWeek?: number;
  /** 1..31 or -1 for "last day of month". Used when cadence === "monthly". */
  dayOfMonth?: number;
  /** "HH:MM" in local time, 24-hour. */
  time: string;
  /** Undefined = full drain. Number = exact ₪ amount. */
  amount?: number;
  enabled: boolean;
  createdAt: string;
  /** Last time this schedule was fired (success OR attempt). */
  lastFiredAt?: string;
  /** Period key at lastFiredAt — used to block same-period re-fires (e.g. Sat miss → Sun). */
  lastFiredPeriodKey?: string;
  /** Last time a fire *succeeded* (result.status === "completed"/"skipped"). */
  lastSuccessAt?: string;
  lastSuccessPeriodKey?: string;
  /** Last time we detected a period rolled over without a fire. */
  lastMissedAt?: string;
}

export interface SchedulesState {
  cadence: Cadence;
  schedules: Schedule[];
}

const DEFAULT_STATE: SchedulesState = { cadence: "weekly", schedules: [] };

export async function loadSchedulesState(): Promise<SchedulesState> {
  try {
    const raw = await fs.readFile(paths.schedules, "utf8");
    const parsed = JSON.parse(raw) as SchedulesState;
    if (!parsed.cadence || !Array.isArray(parsed.schedules)) return DEFAULT_STATE;
    return parsed;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveSchedulesState(state: SchedulesState): Promise<void> {
  await fs.writeFile(paths.schedules, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export interface ScheduleInput {
  name?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  time: string;
  amount?: number;
  enabled?: boolean;
}

export function validateScheduleInput(cadence: Cadence, input: ScheduleInput): string | null {
  if (!/^\d{1,2}:\d{2}$/.test(input.time)) return `Invalid time "${input.time}" — use HH:MM (24h).`;
  const [hStr, mStr] = input.time.split(":");
  const h = Number(hStr), m = Number(mStr);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return `Invalid time "${input.time}".`;
  if (cadence === "weekly") {
    if (input.dayOfWeek === undefined) return "Weekly schedule requires dayOfWeek (0=Sun..6=Sat).";
    if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
      return `dayOfWeek must be 0..6 (Sun..Sat), got ${input.dayOfWeek}.`;
    }
  }
  if (cadence === "monthly") {
    if (input.dayOfMonth === undefined) return "Monthly schedule requires dayOfMonth (1..31 or -1 for last day).";
    if (!Number.isInteger(input.dayOfMonth) || (input.dayOfMonth !== -1 && (input.dayOfMonth < 1 || input.dayOfMonth > 31))) {
      return `dayOfMonth must be 1..31 or -1, got ${input.dayOfMonth}.`;
    }
  }
  if (input.amount !== undefined) {
    if (!Number.isInteger(input.amount) || input.amount <= 0) return `amount must be a positive integer ₪ (or omit for full drain), got ${input.amount}.`;
  }
  return null;
}

export function newSchedule(input: ScheduleInput): Schedule {
  return {
    id: randomUUID(),
    name: input.name,
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    time: input.time,
    amount: input.amount,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
}

export function findSchedule(state: SchedulesState, idOrIndex: string): Schedule | null {
  const byId = state.schedules.find((s) => s.id === idOrIndex || s.id.startsWith(idOrIndex));
  if (byId) return byId;
  const idx = Number(idOrIndex);
  if (Number.isInteger(idx) && idx >= 1 && idx <= state.schedules.length) return state.schedules[idx - 1]!;
  return null;
}

export function describeSchedule(s: Schedule, cadence: Cadence): string {
  const amt = s.amount === undefined ? "full drain" : `₪${s.amount}`;
  const when =
    cadence === "weekly"
      ? `${DOW_NAMES[s.dayOfWeek ?? 0]} ${s.time}`
      : cadence === "monthly"
      ? `day ${s.dayOfMonth === -1 ? "LAST" : s.dayOfMonth} at ${s.time}`
      : `daily at ${s.time}`;
  const name = s.name ? `"${s.name}" ` : "";
  const off = s.enabled ? "" : " (disabled)";
  return `${name}${when} — ${amt}${off}`;
}

export const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
