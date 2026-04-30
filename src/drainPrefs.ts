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

export interface DrainPrefs {
  target: DrainTarget;
  /** Ordered. First entry is consumed first; "drain remaining" entries cap the chain. */
  coupons: CouponPick[];
}

const DEFAULT_PREFS: DrainPrefs = { target: "wolt", coupons: [] };

export async function loadDrainPrefs(): Promise<DrainPrefs> {
  try {
    const raw = await fs.readFile(paths.drainPrefs, "utf8");
    const parsed = JSON.parse(raw) as Partial<DrainPrefs>;
    const target = parsed.target;
    if (target !== "coupons" && target !== "wolt" && target !== "both") return { ...DEFAULT_PREFS };
    const coupons = Array.isArray(parsed.coupons) ? parsed.coupons.filter(isValidPick) : [];
    return { target, coupons };
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

export function describePrefs(prefs: DrainPrefs): string {
  if (prefs.target === "wolt") return "Wolt gift card (full drain)";
  const lines: string[] = [];
  prefs.coupons.forEach((c, i) => {
    const amt = c.amount === undefined ? "drain remaining" : `₪${c.amount}`;
    lines.push(`  ${i + 1}. ${c.restaurantName} — ${amt}`);
  });
  if (prefs.target === "both") lines.push(`  → leftover → Wolt gift card`);
  if (lines.length === 0) return prefs.target === "both" ? "Wolt gift card (no coupons configured)" : "Coupons (no places configured yet)";
  return [`Target: ${prefs.target}`, ...lines].join("\n");
}
