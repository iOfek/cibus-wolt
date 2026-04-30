import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { logger } from "./logger.ts";

export interface RestaurantRecord {
  id: string;
  name: string;
  href: string;
  url: string;
  tag: string;
  rating: number | null;
  ratingCount: number;
  address: string;
  closed: boolean;
}

export interface RestaurantsDb {
  source: string;
  filters: Record<string, unknown>;
  fetchedAt: string;
  count: number;
  restaurants: RestaurantRecord[];
}

const DB_URL = new URL("./data/cibus_restaurants.json", import.meta.url);

let cachedDb: RestaurantsDb | null = null;

export async function loadRestaurantsDb(): Promise<RestaurantsDb> {
  if (cachedDb) return cachedDb;
  const buf = await fs.readFile(fileURLToPath(DB_URL), "utf8");
  const db = JSON.parse(buf) as RestaurantsDb;
  cachedDb = db;
  return db;
}

export interface FuzzyMatch {
  record: RestaurantRecord;
  score: number;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'״׳`]/g, "")
    .replace(/[־\-]/g, " ")
    .replace(/[|/,.()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

function tokenScore(qtok: string, rtoks: string[]): number {
  let best = 0;
  for (const r of rtoks) {
    if (r === qtok) {
      best = Math.max(best, 1);
      continue;
    }
    if (r.startsWith(qtok) || qtok.startsWith(r)) {
      best = Math.max(best, 0.85);
      continue;
    }
    if (r.includes(qtok) || qtok.includes(r)) {
      best = Math.max(best, 0.7);
      continue;
    }
    const maxLen = Math.max(qtok.length, r.length);
    if (maxLen >= 3) {
      const dist = levenshtein(qtok, r);
      const ratio = 1 - dist / maxLen;
      if (ratio >= 0.7) best = Math.max(best, ratio * 0.8);
    }
  }
  return best;
}

export function fuzzySearch(query: string, db: RestaurantsDb, limit = 8): FuzzyMatch[] {
  const qtoks = tokenize(query);
  if (qtoks.length === 0) return [];
  const matches: FuzzyMatch[] = [];
  for (const rec of db.restaurants) {
    const haystack = `${rec.name} ${rec.address}`;
    const rtoks = tokenize(haystack);
    if (rtoks.length === 0) continue;
    let total = 0;
    let allMatched = true;
    for (const qt of qtoks) {
      const s = tokenScore(qt, rtoks);
      if (s < 0.5) allMatched = false;
      total += s;
    }
    let score = total / qtoks.length;
    if (allMatched) score += 0.1;
    if (rec.closed) score -= 0.3;
    if (score > 0.4) matches.push({ record: rec, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

export interface KnapsackResult {
  /** Map denom (₪) → count chosen */
  picks: Map<number, number>;
  /** Total ₪ chosen */
  total: number;
  /** Target ₪ (input) */
  target: number;
}

/**
 * Unbounded knapsack maximizing sum ≤ target. Works in agorot (₪×100) so
 * fractional denominations like ₪19.50 don't drift.
 */
export function maxFit(denoms: number[], target: number): KnapsackResult {
  const validDenoms = denoms.filter((d) => d > 0 && Number.isFinite(d));
  if (validDenoms.length === 0 || target <= 0) {
    return { picks: new Map(), total: 0, target };
  }
  const T = Math.floor(target * 100);
  // Sort denoms descending so on equal sums the reconstruction prefers
  // larger denominations (fewer vouchers).
  const indexed = validDenoms.map((d, i) => ({ d, i }));
  indexed.sort((a, b) => b.d - a.d);
  const sortedDenoms = indexed.map((x) => x.d);
  const ds = sortedDenoms.map((d) => Math.round(d * 100));
  const dp = new Int32Array(T + 1);
  const choice = new Int32Array(T + 1);
  choice.fill(-1);
  for (let j = 1; j <= T; j++) {
    let best = dp[j - 1]!;
    let pickIdx = -1;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]!;
      if (d > j) continue;
      const cand = dp[j - d]! + d;
      if (cand > best) {
        best = cand;
        pickIdx = i;
      }
    }
    dp[j] = best;
    choice[j] = pickIdx;
  }
  const picks = new Map<number, number>();
  let cents = T;
  while (cents > 0 && dp[cents]! > 0) {
    const idx = choice[cents]!;
    if (idx < 0) {
      cents -= 1;
      continue;
    }
    const d = ds[idx]!;
    const denomNis = sortedDenoms[idx]!;
    picks.set(denomNis, (picks.get(denomNis) ?? 0) + 1);
    cents -= d;
  }
  return { picks, total: dp[T]! / 100, target };
}

const RESTAURANT_PAGE_TIMEOUT_MS = 30_000;
const MENU_CARD_SELECTOR = "app-rest-menu-card";

export interface DenominationCard {
  /** Denomination in ₪ (e.g., 15, 20, 100). */
  denom: number;
  /** Index in the rendered cards list (0-based). */
  index: number;
}

export async function readDenominations(page: Page): Promise<DenominationCard[]> {
  await page.waitForSelector(MENU_CARD_SELECTOR, { timeout: RESTAURANT_PAGE_TIMEOUT_MS });
  const cards = await page.locator(MENU_CARD_SELECTOR).all();
  const out: DenominationCard[] = [];
  for (let i = 0; i < cards.length; i++) {
    const label = cards[i]!.locator(".card-footer label").first();
    const txt = (await label.textContent({ timeout: 5_000 }).catch(() => null))?.trim() ?? "";
    const m = txt.match(/(\d+(?:\.\d+)?)/);
    if (!m) {
      logger.warn({ idx: i, txt }, "Card with no parseable denomination — skipping");
      continue;
    }
    out.push({ denom: parseFloat(m[1]!), index: i });
  }
  return out;
}

export async function navigateToRestaurant(page: Page, rec: RestaurantRecord): Promise<void> {
  logger.info({ id: rec.id, name: rec.name, url: rec.url }, "Navigating to restaurant");
  await page.goto(rec.url, { waitUntil: "domcontentloaded", timeout: RESTAURANT_PAGE_TIMEOUT_MS });
  await page.waitForTimeout(1500);
}

export async function addVouchersToCart(
  page: Page,
  cards: DenominationCard[],
  picks: Map<number, number>,
): Promise<{ clicked: number; perDenom: Map<number, number> }> {
  const perDenom = new Map<number, number>();
  let clicked = 0;
  for (const [denom, count] of picks) {
    const card = cards.find((c) => c.denom === denom);
    if (!card) {
      logger.warn({ denom }, "DP picked a denom with no matching card on page — skipping");
      continue;
    }
    const cardLoc = page.locator(MENU_CARD_SELECTOR).nth(card.index);
    const plus = cardLoc.locator('input[type="image"][src*="round-plus"]').first();
    await plus.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < count; i++) {
      await plus.click({ timeout: 5_000 });
      await page.waitForTimeout(250);
      clicked += 1;
      perDenom.set(denom, (perDenom.get(denom) ?? 0) + 1);
    }
  }
  return { clicked, perDenom };
}

export async function openCart(page: Page): Promise<void> {
  const cart = page.locator('img[src*="cart.svg"], img[alt="icon"][src*="cart"]').first();
  await cart.waitFor({ state: "visible", timeout: 10_000 });
  await cart.click({ timeout: 5_000 });
  await page.waitForTimeout(800);
}

export async function clickContinueToFinish(page: Page): Promise<void> {
  const btn = page
    .locator('button.finishOrderBtn, button:has-text("המשך לסיום הזמנה")')
    .first();
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click({ timeout: 5_000 });
  await page.waitForTimeout(1200);
}

/**
 * Click the final "אישור ההזמנה" submit button. This is the point of no
 * return — caller must obtain explicit confirmation before invoking.
 */
export async function submitOrder(page: Page): Promise<void> {
  const btn = page
    .locator('button.submit-order, button:has-text("אישור ההזמנה")')
    .first();
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click({ timeout: 5_000 });
  await page.waitForTimeout(1500);
}

export interface ExecutePickupOpts {
  restaurant: RestaurantRecord;
  /** Max ₪ to spend at this restaurant. DP picks the largest fit ≤ target. */
  target: number;
  /**
   * - "auto":    submit without prompting (cron-friendly)
   * - "prompt":  ask stdin "yes" before submitting
   * - "dry-run": stop on the final-confirmation page; never submit
   */
  mode: "auto" | "prompt" | "dry-run";
  shot?: (name: string) => Promise<void>;
}

export interface ExecutePickupResult {
  spent: number;
  picks: Map<number, number>;
  submitted: boolean;
  reason?: string;
}

/**
 * Drive one full restaurant pickup on an already-logged-in page: navigate,
 * read denoms, DP, click "+"s, open cart, continue to finish-order, then
 * either submit or stop based on `mode`. Returns `spent: 0` if the target
 * is below the smallest available denomination.
 */
export async function executePickupOnPage(
  page: Page,
  opts: ExecutePickupOpts,
): Promise<ExecutePickupResult> {
  const { restaurant, target, mode, shot } = opts;
  await navigateToRestaurant(page, restaurant);
  await shot?.(`pickup-${restaurant.id}-10-restaurant`);

  const cards = await readDenominations(page);
  if (cards.length === 0) {
    return { spent: 0, picks: new Map(), submitted: false, reason: "no-denoms" };
  }
  const denoms = cards.map((c) => c.denom);
  const result = maxFit(denoms, target);
  if (result.picks.size === 0 || result.total === 0) {
    const minDenom = Math.min(...denoms);
    logger.warn(
      { target, minDenom, restaurant: restaurant.name },
      "Target below smallest denomination — skipping",
    );
    return { spent: 0, picks: new Map(), submitted: false, reason: "below-min-denom" };
  }
  const breakdown = Array.from(result.picks.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([d, n]) => `${n}×₪${d}`)
    .join(" + ");
  logger.info(
    { restaurant: restaurant.name, target, total: result.total, breakdown },
    "Pickup picks",
  );

  await addVouchersToCart(page, cards, result.picks);
  await shot?.(`pickup-${restaurant.id}-11-cart-filled`);

  await openCart(page);
  await shot?.(`pickup-${restaurant.id}-12-cart-open`);

  await clickContinueToFinish(page);
  await shot?.(`pickup-${restaurant.id}-13-final-confirm`);

  if (mode === "dry-run") {
    logger.info({ total: result.total, restaurant: restaurant.name }, "DRY RUN — not submitting");
    return { spent: 0, picks: result.picks, submitted: false, reason: "dry-run" };
  }

  if (mode === "prompt") {
    const readline = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let answered = "";
    try {
      answered = (
        await rl.question(
          `\n⚠️  Final confirmation: spend ₪${result.total} at ${restaurant.name} (${breakdown})?\n   Type 'yes' to submit: `,
        )
      ).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answered !== "yes") {
      return { spent: 0, picks: result.picks, submitted: false, reason: "user-declined" };
    }
  }

  await submitOrder(page);
  await shot?.(`pickup-${restaurant.id}-14-after-submit`);
  logger.info(
    { total: result.total, restaurant: restaurant.name, breakdown },
    "✓ Order submitted",
  );
  return { spent: result.total, picks: result.picks, submitted: true };
}
