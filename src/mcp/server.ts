import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { config } from "../config.ts";
import { getCibusWeeklyBalance } from "../cibus.ts";
import { runDrainInBackground } from "../commands/run.ts";
import {
  describePrefs,
  loadDrainPrefs,
  saveDrainPrefs,
  type DrainPrefs,
} from "../drainPrefs.ts";
import { tryLoadGmailCreds } from "../gmail.ts";
import { logger } from "../logger.ts";
import { paths } from "../paths.ts";
import { fuzzySearch, loadRestaurantsDb } from "../pluxeePickup.ts";
import {
  checkCibusSession,
  checkGmail,
  checkWoltSession,
  getLastRun,
  type PhaseStatus,
} from "../phases.ts";
import { submit as submitInputBus } from "../inputs.ts";
import { getActiveRun, getRunById } from "./runRegistry.ts";
import {
  type Cadence,
  describeSchedule,
  findSchedule,
  loadSchedulesState,
  newSchedule,
  saveSchedulesState,
  validateScheduleInput,
} from "../schedules.ts";
import { nextFireTime, readMissed } from "../scheduler.ts";

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

async function readLastRuns(limit: number): Promise<unknown[]> {
  try {
    const data = await fs.readFile(paths.runs, "utf8");
    const lines = data.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
  } catch {
    return [];
  }
}

async function resetScope(scope: "all" | "gmail" | "cibus" | "wolt"): Promise<string[]> {
  const map: Record<string, string[]> = {
    gmail: [paths.token],
    cibus: [paths.chromeProfileCibus],
    wolt: [paths.chromeProfile],
    all: [paths.token, paths.chromeProfileCibus, paths.chromeProfile],
  };
  const deleted: string[] = [];
  for (const p of map[scope] ?? []) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      deleted.push(p);
    } catch (e) {
      logger.warn({ p, err: e instanceof Error ? e.message : String(e) }, "Reset: failed");
    }
  }
  return deleted;
}

// Drain orchestration lives in commands/run.ts (`runDrainInBackground`) so the
// MCP and CLI share a single dispatcher that honours drainPrefs.

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "cibus-wolt", version: "0.1.0" });

  server.registerTool(
    "status",
    {
      description: "Check auth state of Gmail, Cibus, and Wolt phases. Plus info about any active drain.",
      inputSchema: {},
    },
    async () => {
      let gmail: PhaseStatus;
      if (!config.gmailEnabled) {
        gmail = { ok: true, summary: "Gmail not configured (MCP mode — Claude's Gmail integration supplies magic-links + OTPs via submit_magic_link / submit_otp)" };
      } else {
        const creds = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
        gmail = creds ? await checkGmail(creds) : { ok: false, reason: "Gmail creds missing" };
      }
      const cibus = await checkCibusSession();
      const wolt = await checkWoltSession();
      const lastRun = await getLastRun();
      const active = getActiveRun();
      const state = await loadSchedulesState();
      const now = new Date();
      const schedules = state.schedules.map((s) => ({
        id: s.id.slice(0, 8),
        description: describeSchedule(s, state.cadence),
        enabled: s.enabled,
        nextFire: s.enabled ? nextFireTime(s, state.cadence, now).toISOString() : null,
        lastSuccessAt: s.lastSuccessAt ?? null,
      }));
      const missed = await readMissed(5);
      return textResult({
        gmail,
        cibus,
        wolt,
        lastRun,
        activeRun: active,
        cadence: state.cadence,
        schedules,
        missed,
      });
    },
  );

  server.registerTool(
    "balance",
    {
      description:
        "Fetch current Cibus weekly balance (₪). Takes 10–30s. Requires Gmail auth cached. Uses existing Cibus session profile.",
      inputSchema: {},
    },
    async () => {
      const gmail = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
      if (!gmail) return errorResult("Gmail creds missing — run `cibus-wolt setup` to configure GMAIL_USER + GMAIL_APP_PASSWORD.");
      try {
        const balance = await getCibusWeeklyBalance(config.cibus, { gmail });
        return textResult({ balance });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "last_runs",
    {
      description: "Return the N most recent drain runs (default 10) from runs.jsonl, newest first.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit }) => {
      const runs = await readLastRuns(limit ?? 10);
      return textResult({ runs });
    },
  );

  server.registerTool(
    "reset",
    {
      description:
        "Delete cached auth/session state. Scope: 'gmail' (token.json), 'cibus' (user-data-cibus), 'wolt' (user-data), or 'all'.",
      inputSchema: { scope: z.enum(["all", "gmail", "cibus", "wolt"]) },
    },
    async ({ scope }) => {
      const deleted = await resetScope(scope);
      return textResult({ scope, deleted });
    },
  );

  server.registerTool(
    "start_drain",
    {
      description:
        "Start a drain run in the background. Returns a run_id and initial state. Optionally accepts an `amount` in ₪ to spend exactly that much (must be ≤ available balance). Without `amount`, drains the full available balance.",
      inputSchema: {
        dry_run: z.boolean().optional(),
        amount: z.number().int().positive().optional().describe("Spend exactly this many ₪ (must be ≤ available balance)"),
      },
    },
    async ({ dry_run, amount }) => {
      const existing = getActiveRun();
      if (
        existing &&
        (existing.state === "running" ||
          existing.state === "waiting_for_magic_link" ||
          existing.state === "waiting_for_otp")
      ) {
        return textResult({
          error: "already_running",
          active: existing,
          message: "A run is already in progress. Use its run_id with drain_status / submit_* tools.",
        });
      }
      // Delegate to the run dispatcher so drainPrefs (coupons / wolt / both)
      // are respected — same path as the CLI `run` command.
      const { runId } = runDrainInBackground({ dryRun: dry_run ?? false, amount });
      // Give task a brief moment to hit a waiting state
      await new Promise((r) => setTimeout(r, 1500));
      return textResult(getRunById(runId) ?? { id: runId, state: "running" });
    },
  );

  server.registerTool(
    "drain_status",
    {
      description: "Poll the current state of a drain run.",
      inputSchema: { run_id: z.string() },
    },
    async ({ run_id }) => {
      const r = getRunById(run_id);
      if (!r) return errorResult("Unknown run_id (it may have completed + been replaced, or never existed).");
      return textResult(r);
    },
  );

  server.registerTool(
    "drain_prefs_get",
    {
      description:
        "Get the current drain preferences (target + ordered coupon places + optional donation). target ∈ {coupons, wolt, both}; coupons is the ordered list of places to spend at, each with optional fixed ₪ amount (undefined = drain remaining at that place); donation (if set) is a fixed ₪ amount donated to קליר גיבינג at the start of every drain.",
      inputSchema: {},
    },
    async () => {
      const prefs = await loadDrainPrefs();
      return textResult({ ...prefs, summary: describePrefs(prefs) });
    },
  );

  server.registerTool(
    "drain_prefs_set",
    {
      description:
        "Replace drain preferences. target=wolt clears any coupons. target=coupons|both keeps the ordered list — each entry needs a restaurant_id (use search_restaurants to find one) and an optional ₪ amount (omit for 'drain remaining at this place'). donation (optional) is a fixed ₪/drain donation to קליר גיבינג that runs first. Omit donation to clear it. Validates that all IDs exist in the restaurants DB.",
      inputSchema: {
        target: z.enum(["coupons", "wolt", "both"]),
        coupons: z
          .array(
            z.object({
              restaurant_id: z.string().describe("Restaurant id from search_restaurants"),
              amount: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Fixed ₪ to spend here; omit for 'drain remaining at this place'"),
            }),
          )
          .optional(),
        donation: z
          .object({
            amount: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Fixed ₪ to donate every drain. Omit to donate the entire weekly balance."),
          })
          .optional()
          .describe("Donate to קליר גיבינג at the start of every drain. Omit to clear."),
      },
    },
    async ({ target, coupons, donation }) => {
      const requested = coupons ?? [];
      if (target === "wolt" && requested.length > 0) {
        return errorResult("target=wolt does not accept coupons. Use target=coupons or target=both.");
      }
      const db = await loadRestaurantsDb();
      const resolved: DrainPrefs["coupons"] = [];
      for (const pick of requested) {
        const rec = db.restaurants.find((r) => r.id === pick.restaurant_id);
        if (!rec) {
          return errorResult(`Unknown restaurant_id: ${pick.restaurant_id}. Use search_restaurants to find a valid id.`);
        }
        resolved.push({
          restaurantId: rec.id,
          restaurantName: rec.name,
          restaurantAddress: rec.address,
          amount: pick.amount,
        });
      }
      if ((target === "coupons" || target === "both") && resolved.length === 0 && !donation) {
        return errorResult(
          `target=${target} requires at least one coupon entry (or a donation). Use target=wolt for a Wolt-only drain.`,
        );
      }
      const prefs: DrainPrefs = donation
        ? {
            target,
            coupons: resolved,
            donation: donation.amount === undefined ? {} : { amount: donation.amount },
          }
        : { target, coupons: resolved };
      await saveDrainPrefs(prefs);
      return textResult({ ...prefs, summary: describePrefs(prefs) });
    },
  );

  server.registerTool(
    "search_restaurants",
    {
      description:
        "Fuzzy search the Cibus restaurants DB by name/address (Hebrew or Latin). Returns top matches with id (use with drain_prefs_set), name, address, rating, ratingCount.",
      inputSchema: {
        query: z.string().describe("Free-text query — name or address fragment"),
        limit: z.number().int().positive().max(20).optional().describe("Max matches to return (default 8)"),
      },
    },
    async ({ query, limit }) => {
      const db = await loadRestaurantsDb();
      const matches = fuzzySearch(query, db, limit ?? 8);
      return textResult({
        count: matches.length,
        matches: matches.map((m) => ({
          score: Number(m.score.toFixed(2)),
          id: m.record.id,
          name: m.record.name,
          address: m.record.address,
          rating: m.record.rating,
          ratingCount: m.record.ratingCount,
          closed: m.record.closed,
          url: m.record.url,
        })),
      });
    },
  );

  server.registerTool(
    "submit_magic_link",
    {
      description:
        "Provide a Wolt magic-link URL to a paused run. Claude should fetch this URL from the Wolt login email via its Gmail integration.",
      inputSchema: {
        run_id: z.string(),
        url: z.string().describe("The wolt.com/me/magic_login?... URL from the login email"),
      },
    },
    async ({ run_id, url }) => {
      const accepted = submitInputBus("magic_link", url);
      if (!accepted) return errorResult("No run is currently waiting for a magic link.");
      await new Promise((r) => setTimeout(r, 1200));
      return textResult(getRunById(run_id) ?? { id: run_id });
    },
  );

  server.registerTool(
    "submit_otp",
    {
      description:
        "Provide a 6-digit Cibus OTP code to a paused run. Claude should fetch this from the 'cibus-otp' email via its Gmail integration.",
      inputSchema: {
        run_id: z.string(),
        code: z.string().regex(/^\d{4,8}$/u).describe("Numeric OTP code, typically 6 digits"),
      },
    },
    async ({ run_id, code }) => {
      const accepted = submitInputBus("otp", code);
      if (!accepted) return errorResult("No run is currently waiting for an OTP.");
      await new Promise((r) => setTimeout(r, 1200));
      return textResult(getRunById(run_id) ?? { id: run_id });
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Schedule management
  // ────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_schedules",
    {
      description:
        "List all recurring drain schedules with next-fire time + last-success + any recent missed periods. Schedules fire only while the background MCP service is running.",
      inputSchema: {},
    },
    async () => {
      const state = await loadSchedulesState();
      const now = new Date();
      const schedules = state.schedules.map((s) => ({
        id: s.id,
        name: s.name,
        description: describeSchedule(s, state.cadence),
        enabled: s.enabled,
        dayOfWeek: s.dayOfWeek,
        dayOfMonth: s.dayOfMonth,
        time: s.time,
        amount: s.amount ?? null,
        nextFire: s.enabled ? nextFireTime(s, state.cadence, now).toISOString() : null,
        lastFiredAt: s.lastFiredAt ?? null,
        lastSuccessAt: s.lastSuccessAt ?? null,
        lastMissedAt: s.lastMissedAt ?? null,
      }));
      const missed = await readMissed(10);
      return textResult({ cadence: state.cadence, schedules, missed });
    },
  );

  server.registerTool(
    "set_cadence",
    {
      description:
        "Set the Cibus reset cadence (weekly/monthly/daily). Determines how schedules repeat + catch-up boundaries. Default is weekly (most Israeli companies, Sun 00:00 reset).",
      inputSchema: { cadence: z.enum(["weekly", "monthly", "daily"]) },
    },
    async ({ cadence }) => {
      const state = await loadSchedulesState();
      state.cadence = cadence as Cadence;
      await saveSchedulesState(state);
      return textResult({ cadence: state.cadence });
    },
  );

  server.registerTool(
    "add_schedule",
    {
      description:
        "Create a recurring drain schedule. Weekly → provide day_of_week (0=Sun..6=Sat). Monthly → provide day_of_month (1-31 or -1 for last day). Daily → time only. Omit `amount` to drain the full available balance each fire; or pass an integer ₪ for a fixed partial drain.",
      inputSchema: {
        name: z.string().optional().describe("Optional human-readable label"),
        day_of_week: z.number().int().min(0).max(6).optional().describe("0=Sun..6=Sat, for weekly cadence"),
        day_of_month: z.number().int().min(-1).max(31).optional().describe("1..31 or -1 for last day, for monthly cadence"),
        time: z.string().regex(/^\d{1,2}:\d{2}$/u).describe("HH:MM 24h in local time"),
        amount: z.number().int().positive().optional().describe("₪ to spend; omit for full drain"),
      },
    },
    async ({ name, day_of_week, day_of_month, time, amount }) => {
      const state = await loadSchedulesState();
      const input = { name, dayOfWeek: day_of_week, dayOfMonth: day_of_month, time, amount };
      const err = validateScheduleInput(state.cadence, input);
      if (err) return errorResult(err);
      const s = newSchedule(input);
      state.schedules.push(s);
      await saveSchedulesState(state);
      return textResult({ id: s.id, description: describeSchedule(s, state.cadence) });
    },
  );

  server.registerTool(
    "update_schedule",
    {
      description:
        "Update fields of an existing schedule. All fields optional; only provided ones are changed. Set `amount` to null to clear (= full drain).",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        day_of_week: z.number().int().min(0).max(6).optional(),
        day_of_month: z.number().int().min(-1).max(31).optional(),
        time: z.string().regex(/^\d{1,2}:\d{2}$/u).optional(),
        amount: z.number().int().positive().nullable().optional(),
        enabled: z.boolean().optional(),
      },
    },
    async ({ id, name, day_of_week, day_of_month, time, amount, enabled }) => {
      const state = await loadSchedulesState();
      const s = findSchedule(state, id);
      if (!s) return errorResult(`No schedule matching "${id}"`);
      if (name !== undefined) s.name = name;
      if (day_of_week !== undefined) s.dayOfWeek = day_of_week;
      if (day_of_month !== undefined) s.dayOfMonth = day_of_month;
      if (time !== undefined) s.time = time;
      if (amount !== undefined) s.amount = amount === null ? undefined : amount;
      if (enabled !== undefined) s.enabled = enabled;
      const err = validateScheduleInput(state.cadence, {
        name: s.name,
        dayOfWeek: s.dayOfWeek,
        dayOfMonth: s.dayOfMonth,
        time: s.time,
        amount: s.amount,
      });
      if (err) return errorResult(err);
      await saveSchedulesState(state);
      return textResult({ id: s.id, description: describeSchedule(s, state.cadence) });
    },
  );

  server.registerTool(
    "remove_schedule",
    {
      description: "Delete a schedule by id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const state = await loadSchedulesState();
      const s = findSchedule(state, id);
      if (!s) return errorResult(`No schedule matching "${id}"`);
      state.schedules = state.schedules.filter((x) => x.id !== s.id);
      await saveSchedulesState(state);
      return textResult({ removed: s.id, description: describeSchedule(s, state.cadence) });
    },
  );

  server.registerTool(
    "set_schedule_enabled",
    {
      description: "Enable or disable a schedule without deleting it.",
      inputSchema: { id: z.string(), enabled: z.boolean() },
    },
    async ({ id, enabled }) => {
      const state = await loadSchedulesState();
      const s = findSchedule(state, id);
      if (!s) return errorResult(`No schedule matching "${id}"`);
      s.enabled = enabled;
      await saveSchedulesState(state);
      return textResult({ id: s.id, enabled: s.enabled });
    },
  );

  return server;
}
