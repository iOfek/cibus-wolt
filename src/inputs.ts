import type { OAuth2Client } from "google-auth-library";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fetchCibusOtp, fetchWoltMagicLink } from "./gmail.ts";
import { logger } from "./logger.ts";

/**
 * Unified input bus for external signals a drain is waiting on.
 *
 * Single global pending slot per kind (we only support one active drain at a
 * time). Any provider — webhook POST, MCP `submit_*` tool, stdin prompt, or a
 * Gmail poller — can call `submit(kind, value)`; the drain's `waitFor(kind)`
 * resolves with that value.
 *
 * This replaces the per-runId registry that existed before — both webhook and
 * MCP paths now use this same bus.
 */

export type InputKind = "otp" | "magic_link" | "ack";

interface PendingSlot {
  kind: InputKind;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

const pending = new Map<InputKind, PendingSlot>();

export function getPendingInput(): InputKind[] {
  return Array.from(pending.keys());
}

/**
 * Wait for an external input of the given kind to arrive. Rejects on timeout.
 * Only one `waitFor` per kind may be in flight at once.
 */
export function waitFor(kind: InputKind, timeoutMs: number): Promise<string> {
  if (pending.has(kind)) {
    return Promise.reject(new Error(`Already waiting for ${kind}`));
  }
  logger.info({ kind }, "Drain waiting for external input");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(kind);
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${kind}`));
    }, timeoutMs);
    pending.set(kind, { kind, resolve, reject, timer, createdAt: Date.now() });
  });
}

/**
 * Submit a value for a pending input. Returns `true` if something was waiting,
 * `false` otherwise (the submit is a no-op — the value is discarded).
 */
export function submit(kind: InputKind, value: string): boolean {
  const slot = pending.get(kind);
  if (!slot) return false;
  clearTimeout(slot.timer);
  pending.delete(kind);
  logger.info({ kind }, "External input accepted");
  slot.resolve(value);
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Providers — functions that watch some source and call submit() when they
// have a value. Composed behind the scenes by resolveOtp / resolveMagicLink.
// ────────────────────────────────────────────────────────────────────────────

export interface ResolveOpts {
  auth?: OAuth2Client;
  expectEmail?: string;
  allowStdin?: boolean;
  since?: Date;
}

/** Race: webhook/MCP arrival → Gmail poll (if auth provided) → stdin prompt. */
export async function resolveOtp(timeoutMs: number, opts: ResolveOpts = {}): Promise<string> {
  return raceProviders("otp", timeoutMs, [
    waitForExternalSubmit("otp"),
    opts.auth ? pollGmailOtp(opts.auth, opts.since) : null,
    opts.allowStdin !== false ? promptStdin("📱 Enter the 6-digit Cibus SMS code: ") : null,
  ]);
}

/** Race: webhook/MCP arrival → Gmail poll (if auth) → stdin prompt for URL. */
export async function resolveMagicLink(timeoutMs: number, opts: ResolveOpts = {}): Promise<string> {
  return raceProviders("magic_link", timeoutMs, [
    waitForExternalSubmit("magic_link"),
    opts.auth && opts.expectEmail ? pollGmailMagicLink(opts.auth, opts.expectEmail, opts.since) : null,
    opts.allowStdin !== false ? promptStdin("🔗 Paste the Wolt magic-link URL (or press Enter after logging in manually — we'll retry): ") : null,
  ]);
}

async function raceProviders(kind: InputKind, timeoutMs: number, providers: Array<Promise<string> | null>): Promise<string> {
  const active = providers.filter((p): p is Promise<string> => p !== null);
  if (active.length === 0) throw new Error(`No providers configured for ${kind}`);

  // Race the external-submit path against any polling providers.
  const first = await Promise.race([
    Promise.race(active),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${kind}`)), timeoutMs),
    ),
  ]);

  // Flush the pending slot if a provider won directly (not via submit)
  if (pending.has(kind)) {
    const slot = pending.get(kind)!;
    clearTimeout(slot.timer);
    pending.delete(kind);
  }
  return first;
}

function waitForExternalSubmit(kind: InputKind): Promise<string> {
  // Create an unlimited wait; raceProviders applies the outer timeout.
  return new Promise<string>((resolve, reject) => {
    if (pending.has(kind)) return reject(new Error(`Slot ${kind} already in use`));
    const slot: PendingSlot = {
      kind,
      resolve,
      reject,
      timer: setTimeout(() => {}, 0), // replaced by outer timeout
      createdAt: Date.now(),
    };
    pending.set(kind, slot);
  });
}

async function pollGmailOtp(auth: OAuth2Client, since?: Date): Promise<string> {
  const sinceDate = since ?? new Date(Date.now() - 5 * 60_000);
  return fetchCibusOtp({ auth, since: sinceDate, timeoutMs: 24 * 60 * 60_000, pollMs: 5_000 });
}

async function pollGmailMagicLink(auth: OAuth2Client, expectEmail: string, since?: Date): Promise<string> {
  const sinceDate = since ?? new Date(Date.now() - 5 * 60_000);
  return fetchWoltMagicLink({ auth, since: sinceDate, expectEmail, timeoutMs: 24 * 60 * 60_000, pollMs: 10_000 });
}

async function promptStdin(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    // Never resolves — stdin prompt only viable in interactive terminals.
    return new Promise<string>(() => {});
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}
