import { appendRun } from "../audit.ts";
import { acquireBrowser } from "../browser.ts";
import { getCibusWeeklyBalance, withCibusSession } from "../cibus.ts";
import { config } from "../config.ts";
import { loadDrainPrefs, type DrainPrefs } from "../drainPrefs.ts";
import { tryLoadGmailCreds, type GmailCreds } from "../gmail.ts";
import { resolveOtp } from "../inputs.ts";
import { logger } from "../logger.ts";
import { ensureStateDir, screenshotDirFor } from "../paths.ts";
import { checkCibusSession, checkGmail, checkWoltSession, logPhaseBanner } from "../phases.ts";
import { executePickupOnPage, loadRestaurantsDb } from "../pluxeePickup.ts";
import { buyAndRedeemWoltGiftCard } from "../wolt.ts";
import { ensureWoltLoggedIn } from "../woltLogin.ts";

import { startRun, finishRun, setState, getActiveRun } from "../mcp/runRegistry.ts";

export interface DrainOpts {
  dryRun?: boolean;
  /** Force a specific amount (₪). Must be positive, an integer, and ≤ available balance and ≤ MAX_SPEND. */
  amount?: number;
}

/**
 * Kick off a drain in the background — used by the webhook /drain endpoint.
 * Returns immediately with a run_id; caller polls status endpoints.
 */
export function runDrainInBackground(opts: DrainOpts = {}): { runId: string } {
  const existing = getActiveRun();
  if (existing && (existing.state === "running" || existing.state === "waiting_for_magic_link" || existing.state === "waiting_for_otp")) {
    return { runId: existing.id };
  }
  const res = startRun(opts.dryRun ?? false);
  const runId = "error" in res ? res.existing.id : res.id;
  void (async () => {
    try {
      await runDrainCommand(opts);
      setState(runId, "completed");
      finishRun(runId, "completed", { status: "completed" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ runId, err: msg }, "Background drain failed");
      finishRun(runId, "failed", { status: "failed", error: msg });
    }
  })();
  return { runId };
}

export async function runDrainCommand(opts: DrainOpts = {}): Promise<void> {
  const dryRun = opts.dryRun ?? config.dryRun;
  const requestedAmount = opts.amount;
  if (requestedAmount !== undefined) {
    if (!Number.isFinite(requestedAmount) || !Number.isInteger(requestedAmount) || requestedAmount <= 0) {
      throw new Error(`--amount must be a positive integer, got: ${requestedAmount}`);
    }
    if (requestedAmount > config.maxSpend) {
      throw new Error(`--amount ${requestedAmount} exceeds MAX_SPEND ${config.maxSpend}`);
    }
  }
  await ensureStateDir();
  const prefs = await loadDrainPrefs();
  logger.info(
    { dryRun, requestedAmount, target: prefs.target, picks: prefs.coupons.length, minAmount: config.minAmount, maxSpend: config.maxSpend },
    "Starting run",
  );

  // Phase 1: Gmail (optional)
  logPhaseBanner(1, 5, "Gmail (optional)");
  const gmail = config.gmailEnabled
    ? tryLoadGmailCreds(config.gmail.user, config.gmail.pass) ?? undefined
    : undefined;
  if (gmail) {
    const g = await checkGmail(gmail);
    logger.info(g.ok ? `✓ ${g.summary}` : `→ Gmail configured but creds invalid (${g.reason}); continuing without Gmail`);
  } else {
    logger.info("→ Gmail not configured; relying on webhook/MCP/stdin inputs");
  }

  // Phase 2: Cibus session preflight
  logPhaseBanner(2, 5, "Cibus session");
  const cibusStatus = await checkCibusSession();
  logger.info(cibusStatus.ok ? `✓ ${cibusStatus.summary}` : `→ will log in (${cibusStatus.reason})`);

  // Phase 3: Wolt session preflight (skip if target === "coupons")
  const needWolt = prefs.target === "wolt" || prefs.target === "both";
  if (needWolt) {
    logPhaseBanner(3, 5, "Wolt session");
    const woltStatus = await checkWoltSession();
    logger.info(woltStatus.ok
      ? `✓ ${woltStatus.summary}`
      : `→ Wolt session expired (${woltStatus.reason}) — run \`cibus-wolt wolt-login\` to re-authenticate`);
  } else {
    logger.info("→ Target is 'coupons' — skipping Wolt phase");
  }

  // Dispatch by target
  if (prefs.target === "wolt") {
    await runWoltOnly({ dryRun, requestedAmount, gmail });
    return;
  }

  // target ∈ {"coupons", "both"} — do coupons in a single Cibus session.
  const couponsResult = await runCouponsPhase({ dryRun, requestedAmount, gmail, prefs });

  if (prefs.target === "both" && couponsResult.remaining >= config.minAmount) {
    logger.info({ remaining: couponsResult.remaining }, "Coupons done — draining remainder into Wolt");
    await runWoltDrain({ amount: couponsResult.remaining, gmail, dryRun });
  } else if (prefs.target === "both") {
    logger.info(
      { remaining: couponsResult.remaining, minAmount: config.minAmount },
      "Remainder below MIN_AMOUNT — skipping Wolt phase",
    );
  }

  await appendRun({
    ts: new Date().toISOString(),
    amount: couponsResult.spent,
    status: dryRun ? "dry-run" : couponsResult.spent > 0 ? "success" : "skipped",
    reason: couponsResult.notes.join("; ") || undefined,
  });
  logger.info({ totalSpent: couponsResult.spent, target: prefs.target }, "✓ Run complete");
}

interface WoltRunOpts {
  dryRun: boolean;
  requestedAmount?: number;
  gmail: GmailCreds | undefined;
}

async function runWoltOnly(opts: WoltRunOpts): Promise<void> {
  const { dryRun, requestedAmount, gmail } = opts;

  // Phase 4: Balance
  logPhaseBanner(4, 5, "Balance fetch");
  const balance = await getCibusWeeklyBalance(config.cibus, {
    gmail,
    fetchOtp: (since) => resolveOtp(5 * 60_000, { gmail, allowStdin: true, since }),
  });
  const maxSpendable = Math.floor(balance);

  let amount: number;
  if (requestedAmount !== undefined) {
    if (requestedAmount > maxSpendable) {
      const msg = `Requested amount ₪${requestedAmount} exceeds available balance ₪${maxSpendable}`;
      logger.error({ balance, requestedAmount }, msg);
      await appendRun({ ts: new Date().toISOString(), amount: requestedAmount, status: "failed", reason: "exceeds-balance" });
      throw new Error(msg);
    }
    amount = requestedAmount;
    logger.info(`✓ Weekly balance: ₪${balance} → will spend requested ₪${amount} (₪${maxSpendable - amount} stays in Cibus)`);
  } else {
    amount = maxSpendable;
    logger.info(`✓ Weekly balance: ₪${balance} → will spend ₪${amount}`);
  }

  if (amount < config.minAmount) {
    logger.info({ balance, amount, minAmount: config.minAmount }, "Amount below threshold; skipping");
    await appendRun({ ts: new Date().toISOString(), amount, status: "skipped", reason: "below-min" });
    return;
  }
  if (amount > config.maxSpend) {
    logger.error({ balance, amount, maxSpend: config.maxSpend }, "Amount exceeds MAX_SPEND; aborting");
    await appendRun({ ts: new Date().toISOString(), amount, status: "failed", reason: "exceeds-max" });
    throw new Error(`Amount ${amount} exceeds MAX_SPEND ${config.maxSpend}`);
  }

  await runWoltDrain({ amount, gmail, dryRun });
}

interface WoltDrainOpts {
  amount: number;
  gmail: GmailCreds | undefined;
  dryRun: boolean;
}

async function runWoltDrain(opts: WoltDrainOpts): Promise<void> {
  const { amount, gmail, dryRun } = opts;
  logPhaseBanner(5, 5, dryRun ? "Wolt drain (DRY RUN)" : "Wolt drain");
  const browser = await acquireBrowser();
  const { context } = browser;
  const page = context.pages()[0] ?? (await context.newPage());
  const screenshotDir = screenshotDirFor("run");
  try {
    await ensureWoltLoggedIn({ page });
    const result = await buyAndRedeemWoltGiftCard({
      page,
      context,
      amount,
      cibus: {
        username: config.cibus.username,
        password: config.cibus.password,
        authMode: config.cibus.authMode,
      },
      gmail,
      dryRun,
      screenshotDir,
      fetchOtp: (since) => resolveOtp(5 * 60_000, { gmail, allowStdin: true, since }),
    });
    await appendRun({ ts: new Date().toISOString(), amount, status: result.status, url: result.url });
    logger.info(`✓ Wolt drain: ${result.status}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg, screenshotDir }, "Wolt drain failed");
    await appendRun({ ts: new Date().toISOString(), amount, status: "failed", reason: msg });
    throw e;
  } finally {
    await browser.close();
  }
}

interface CouponsPhaseOpts {
  dryRun: boolean;
  requestedAmount?: number;
  gmail: GmailCreds | undefined;
  prefs: DrainPrefs;
}

interface CouponsPhaseResult {
  /** Total ₪ spent across all pickups (0 in dry-run). */
  spent: number;
  /** Balance remaining after pickups (for `target === "both"` Wolt fallback). */
  remaining: number;
  /** Per-pickup notes. */
  notes: string[];
}

async function runCouponsPhase(opts: CouponsPhaseOpts): Promise<CouponsPhaseResult> {
  const { dryRun, requestedAmount, gmail, prefs } = opts;
  if (prefs.coupons.length === 0) {
    logger.warn("Target is 'coupons' but no places configured. Run `cibus-wolt setup` to add some.");
    return { spent: 0, remaining: 0, notes: ["no-places-configured"] };
  }

  const db = await loadRestaurantsDb();

  return withCibusSession(
    config.cibus,
    {
      gmail,
      fetchOtp: (since) => resolveOtp(5 * 60_000, { gmail, allowStdin: true, since }),
    },
    async ({ page, balance, shot }) => {
      logPhaseBanner(4, 5, "Balance fetch");
      const bal = await balance;
      const maxSpendable = Math.floor(bal);
      const totalTarget = requestedAmount !== undefined ? Math.min(requestedAmount, maxSpendable) : maxSpendable;
      logger.info(
        { balance: bal, requested: requestedAmount, totalTarget },
        `✓ Weekly balance: ₪${bal} → total target ₪${totalTarget}`,
      );
      if (totalTarget < config.minAmount) {
        logger.info({ totalTarget, minAmount: config.minAmount }, "Below MIN_AMOUNT — skipping");
        return { spent: 0, remaining: totalTarget, notes: ["below-min"] };
      }
      if (totalTarget > config.maxSpend) {
        throw new Error(`Total target ₪${totalTarget} exceeds MAX_SPEND ₪${config.maxSpend}`);
      }

      logPhaseBanner(5, 5, dryRun ? "Coupons (DRY RUN)" : "Coupons");
      let remaining = totalTarget;
      let spent = 0;
      const notes: string[] = [];

      for (const pick of prefs.coupons) {
        if (remaining <= 0) {
          notes.push(`${pick.restaurantName}: skipped (no remaining)`);
          continue;
        }
        const restaurant = db.restaurants.find((r) => r.id === pick.restaurantId);
        if (!restaurant) {
          logger.warn({ id: pick.restaurantId }, "Pick refers to a restaurant not in DB — skipping");
          notes.push(`${pick.restaurantName}: not-in-db`);
          continue;
        }
        const desired = pick.amount !== undefined ? Math.min(pick.amount, remaining) : remaining;
        if (desired <= 0) {
          notes.push(`${pick.restaurantName}: skipped (target ₪0)`);
          continue;
        }
        logger.info(
          { restaurant: restaurant.name, target: desired, remaining },
          `→ Pickup at ${restaurant.name} for ₪${desired}`,
        );
        const result = await executePickupOnPage(page, {
          restaurant,
          target: desired,
          mode: dryRun ? "dry-run" : "auto",
          shot,
        });
        if (result.submitted) {
          spent += result.spent;
          remaining -= result.spent;
          notes.push(`${restaurant.name}: ₪${result.spent}`);
        } else if (result.reason === "dry-run") {
          notes.push(`${restaurant.name}: dry-run (would-spend ₪${pickPicksTotal(result.picks)})`);
        } else {
          notes.push(`${restaurant.name}: skipped (${result.reason ?? "unknown"})`);
        }
      }
      return { spent, remaining, notes };
    },
  );
}

function pickPicksTotal(picks: Map<number, number>): number {
  let t = 0;
  for (const [d, n] of picks) t += d * n;
  return t;
}
