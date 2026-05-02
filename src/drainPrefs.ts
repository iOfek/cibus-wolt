import fs from "node:fs/promises";
import { paths } from "./paths.ts";

export type DrainTarget = "coupons" | "wolt" | "both";

export interface CouponPick {
  restaurantId: string;
  /** Cached for display — the canonical name lives in the restaurants DB. */
  restaurantName: string;
  /** Cached for display. */
  restaurantAddress: string;
  /** Undefined = drain whatever is left at this place. */
  amount?: number;
}

export interface DonationPref {
  /** ₪ to donate per drain. Undefined = donate the entire weekly balance. */
  amount?: number;
}

export interface DrainPrefs {
  target: DrainTarget;
  /** Ordered. First entry is consumed first; "drain remaining" entries cap the chain. */
  coupons: CouponPick[];
  /** Always runs first as a Cibus pickup, regardless of target. */
  donation?: DonationPref;
}

/** Pluxee restaurant id for קליר גיבינג (Clear Giving). Pickup flow works the same as a regular voucher restaurant. */
export const DONATION_ORG_ID = "147828";
export const DONATION_ORG_NAME = "תרומות - קליר גיבינג";
export const DONATION_ORG_ADDRESS = "תרומה לעמותה (Clear Giving)";

const DEFAULT_PREFS: DrainPrefs = { target: "wolt", coupons: [] };

export async function loadDrainPrefs(): Promise<DrainPrefs> {
  try {
    const raw = await fs.readFile(paths.drainPrefs, "utf8");
    const parsed = JSON.parse(raw) as Partial<DrainPrefs>;
    const target = parsed.target;
    if (target !== "coupons" && target !== "wolt" && target !== "both") return { ...DEFAULT_PREFS };
    const coupons = Array.isArray(parsed.coupons) ? parsed.coupons.filter(isValidPick) : [];
    const donation = isValidDonation(parsed.donation) ? parsed.donation : undefined;
    return donation ? { target, coupons, donation } : { target, coupons };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function saveDrainPrefs(prefs: DrainPrefs): Promise<void> {
  await fs.writeFile(paths.drainPrefs, JSON.stringify(prefs, null, 2), { mode: 0o600 });
}

function isValidPick(p: unknown): p is CouponPick {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  if (typeof r.restaurantId !== "string" || !r.restaurantId) return false;
  if (typeof r.restaurantName !== "string") return false;
  if (typeof r.restaurantAddress !== "string") return false;
  if (r.amount !== undefined && (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0)) return false;
  return true;
}

function isValidDonation(d: unknown): d is DonationPref {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  if (r.amount === undefined) return true;
  return typeof r.amount === "number" && Number.isFinite(r.amount) && Number.isInteger(r.amount) && r.amount > 0;
}

export function describePrefs(prefs: DrainPrefs): string {
  const lines: string[] = [];
  // Hebrew name goes at line-end so the terminal's bidi pass renders it RTL
  // cleanly (mid-line Hebrew between English runs flips visual order on some
  // terminals — match the pattern used by autocomplete restaurant rows).
  if (prefs.donation) {
    const amt = prefs.donation.amount === undefined ? "entire balance" : `₪${prefs.donation.amount}`;
    lines.push(`  ♥ Donation: ${amt} → ${DONATION_ORG_NAME}`);
  }
  if (prefs.target === "wolt") {
    const tail = prefs.donation ? "Wolt gift card (drain remainder)" : "Wolt gift card (full drain)";
    return prefs.donation ? [...lines, `  → ${tail}`].join("\n") : tail;
  }
  prefs.coupons.forEach((c, i) => {
    const amt = c.amount === undefined ? "drain remaining" : `₪${c.amount}`;
    lines.push(`  ${i + 1}. ${c.restaurantName} — ${amt}`);
  });
  if (prefs.target === "both") lines.push(`  → leftover → Wolt gift card`);
  if (lines.length === 0) return prefs.target === "both" ? "Wolt gift card (no coupons configured)" : "Coupons (no places configured yet)";
  // Donate-only (no extra coupons): the donation line is self-describing,
  // skip the "Target: coupons" header.
  if (prefs.donation && prefs.coupons.length === 0 && prefs.target === "coupons") {
    return lines.join("\n");
  }
  return [`Target: ${prefs.target}`, ...lines].join("\n");
}
