import { withCibusSession } from "../cibus.ts";
import { config } from "../config.ts";
import { tryLoadGmailCreds } from "../gmail.ts";
import { logger } from "../logger.ts";
import { ensureStateDir } from "../paths.ts";
import {
  executePickupOnPage,
  fuzzySearch,
  loadRestaurantsDb,
  type RestaurantRecord,
} from "../pluxeePickup.ts";

export interface PickupOpts {
  query: string;
  amount?: number;
  /** If true, auto-submit (no prompt). Default: prompt. */
  yes?: boolean;
  /** If true, stop on the final-confirmation page — don't submit. */
  noCheckout?: boolean;
  /** If set, pick the restaurant with this id directly (bypass fuzzy match). */
  id?: string;
}

export async function runPickupCommand(opts: PickupOpts): Promise<void> {
  await ensureStateDir();
  const db = await loadRestaurantsDb();

  let chosen: RestaurantRecord;
  if (opts.id) {
    const found = db.restaurants.find((r) => r.id === opts.id);
    if (!found) throw new Error(`No restaurant with id=${opts.id} in DB (have ${db.count} entries)`);
    chosen = found;
  } else {
    const matches = fuzzySearch(opts.query, db);
    if (matches.length === 0) {
      throw new Error(`No restaurant matched "${opts.query}". Try a different query.`);
    }
    chosen = matches[0]!.record;
    logger.info(
      {
        topScore: matches[0]!.score.toFixed(2),
        chosen: { id: chosen.id, name: chosen.name, address: chosen.address },
      },
      "Top match",
    );
    if (matches.length > 1) {
      const alts = matches
        .slice(1, 5)
        .map((m) => `  ${m.score.toFixed(2)}  ${m.record.id}  ${m.record.name} — ${m.record.address}`)
        .join("\n");
      logger.info(`Alternatives (use --id <restId> to pick one):\n${alts}`);
    }
  }

  const gmail = config.gmailEnabled
    ? tryLoadGmailCreds(config.gmail.user, config.gmail.pass) ?? undefined
    : undefined;

  await withCibusSession(config.cibus, { gmail }, async ({ page, balance, shot }) => {
    const bal = await balance;
    const target = opts.amount != null ? Math.min(opts.amount, bal) : bal;
    logger.info({ balance: bal, requested: opts.amount, target }, "Computed target spend");
    if (target <= 0) {
      logger.warn("Target is ₪0 — nothing to spend.");
      return;
    }
    const mode = opts.noCheckout ? "dry-run" : opts.yes ? "auto" : "prompt";
    await executePickupOnPage(page, { restaurant: chosen, target, mode, shot });
  });
}
