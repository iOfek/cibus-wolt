import { randomUUID } from "node:crypto";
import { logger } from "../logger.ts";

export type RunState =
  | "running"
  | "waiting_for_magic_link"
  | "waiting_for_otp"
  | "completed"
  | "failed";

export interface RunResult {
  status?: string;
  amount?: number;
  url?: string;
  error?: string;
}

interface ActiveRun {
  id: string;
  state: RunState;
  dryRun: boolean;
  result?: RunResult;
  startedAt: number;
  // Pending waits — a promise waiting for external input.
  pendingInput?: {
    kind: "magic_link" | "otp";
    resolve: (value: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
}

const WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let current: ActiveRun | null = null;

export function getActiveRun(): { id: string; state: RunState; result?: RunResult } | null {
  if (!current) return null;
  return { id: current.id, state: current.state, result: current.result };
}

export function getRunById(id: string): { id: string; state: RunState; result?: RunResult } | null {
  if (!current || current.id !== id) return null;
  return { id: current.id, state: current.state, result: current.result };
}

export function startRun(dryRun: boolean): { id: string } | { error: "already_running"; existing: { id: string; state: RunState } } {
  if (current && (current.state === "running" || current.state === "waiting_for_magic_link" || current.state === "waiting_for_otp")) {
    return { error: "already_running", existing: { id: current.id, state: current.state } };
  }
  const id = randomUUID();
  current = { id, state: "running", dryRun, startedAt: Date.now() };
  logger.info({ runId: id, dryRun }, "Run registered");
  return { id };
}

export function setState(runId: string, state: RunState, result?: RunResult): void {
  if (!current || current.id !== runId) return;
  current.state = state;
  if (result) current.result = { ...(current.result ?? {}), ...result };
}

export function finishRun(runId: string, state: "completed" | "failed", result: RunResult): void {
  if (!current || current.id !== runId) return;
  current.state = state;
  current.result = { ...(current.result ?? {}), ...result };
  if (current.pendingInput) {
    clearTimeout(current.pendingInput.timer);
    current.pendingInput.reject(new Error(`Run ${state}`));
    current.pendingInput = undefined;
  }
  logger.info({ runId, state }, "Run finished");
}

export function waitForExternalInput(runId: string, kind: "magic_link" | "otp"): Promise<string> {
  if (!current || current.id !== runId) return Promise.reject(new Error("Run not found"));
  if (current.pendingInput) return Promise.reject(new Error("Already awaiting external input"));
  current.state = kind === "magic_link" ? "waiting_for_magic_link" : "waiting_for_otp";
  logger.info({ runId, kind }, "Run paused awaiting external input");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (current?.pendingInput) current.pendingInput = undefined;
      reject(new Error(`Timeout waiting for ${kind}`));
    }, WAIT_TIMEOUT_MS);
    if (!current) return reject(new Error("Run lost"));
    current.pendingInput = { kind, resolve, reject, timer };
  });
}

export function submitInput(runId: string, kind: "magic_link" | "otp", value: string): { ok: true } | { ok: false; reason: string } {
  if (!current || current.id !== runId) return { ok: false, reason: "Run not found" };
  const p = current.pendingInput;
  if (!p) return { ok: false, reason: "Run is not waiting for external input" };
  if (p.kind !== kind) return { ok: false, reason: `Run is waiting for ${p.kind}, not ${kind}` };
  clearTimeout(p.timer);
  current.pendingInput = undefined;
  current.state = "running";
  p.resolve(value);
  logger.info({ runId, kind }, "External input accepted");
  return { ok: true };
}
