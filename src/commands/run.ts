import { appendRun } from "../audit.ts";
import { acquireBrowser } from "../browser.ts";
import { getCibusWeeklyBalance } from "../cibus.ts";
import { config } from "../config.ts";
import { tryLoadAuthClient } from "../gmail.ts";
import { resolveMagicLink, resolveOtp } from "../inputs.ts";
import { logger } from "../logger.ts";
import { ensureStateDir, screenshotDirFor } from "../paths.ts";
import { checkCibusSession, checkGmail, checkWoltSession, logPhaseBanner } from "../phases.ts";
import { buyAndRedeemWoltGiftCard } from "../wolt.ts";
import { ensureWoltLoggedIn } from "../woltLogin.ts";

import { startRun, finishRun, setState, getActiveRun } from "../mcp/runRegistry.ts";
import { randomUUID } from "node:crypto";

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
  // Fire-and-forget; errors are logged and captured in runRegistry state.
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
  logger.info({ dryRun, requestedAmount, minAmount: config.minAmount, maxSpend: config.maxSpend }, "Starting run");

  // Phase 1: Gmail (optional — only used as one of several input providers)
  logPhaseBanner(1, 5, "Gmail (optional)");
  const auth = config.gmailEnabled
    ? (await tryLoadAuthClient(config.google.clientId, config.google.clientSecret)) ?? undefined
    : undefined;
  if (auth) {
    const g = await checkGmail(auth);
    logger.info(g.ok ? `✓ ${g.summary}` : `→ Gmail configured but token invalid (${g.reason}); continuing without Gmail`);
  } else {
    logger.info("→ Gmail not configured; relying on webhook/MCP/stdin inputs");
  }

  // Phase 2: Cibus session preflight
  logPhaseBanner(2, 5, "Cibus session");
  const cibusStatus = await checkCibusSession();
  logger.info(cibusStatus.ok
    ? `✓ ${cibusStatus.summary} (skipping login unless expired)`
    : `→ will log in (${cibusStatus.reason})`);

  // Phase 3: Wolt session preflight
  logPhaseBanner(3, 5, "Wolt session");
  const woltStatus = await checkWoltSession();
  logger.info(woltStatus.ok
    ? `✓ ${woltStatus.summary} (skipping login unless expired)`
    : `→ Wolt session expired (${woltStatus.reason}) — run \`cibus-wolt wolt-login\` to re-authenticate`);

  // Phase 4: Balance
  logPhaseBanner(4, 5, "Balance fetch");
  const balance = await getCibusWeeklyBalance(config.cibus, {
    auth,
    fetchOtp: () => resolveOtp(5 * 60_000, { auth, allowStdin: true }),
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
    logger.info(`✓ Weekly balance: ₪${balance} → will spend requested ₪${amount} (₪${maxSpendable - amount} will stay in Cibus)`);
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

  // Phase 5: Purchase + redeem
  logPhaseBanner(5, 5, dryRun ? "Purchase (DRY RUN)" : "Purchase + redeem");
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
      auth,
      dryRun,
      screenshotDir,
      fetchOtp: () => resolveOtp(5 * 60_000, { auth, allowStdin: true }),
    });
    await appendRun({ ts: new Date().toISOString(), amount, status: result.status, url: result.url });
    logger.info(`✓ Run complete: ${result.status}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg, screenshotDir }, "Run failed");
    await appendRun({ ts: new Date().toISOString(), amount, status: "failed", reason: msg });
    throw e;
  } finally {
    await browser.close();
  }
}
