import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import { getPendingInput, submit } from "./inputs.ts";
import { getActiveRun } from "./mcp/runRegistry.ts";

/**
 * Webhook routes mounted at /webhook/:token/... The `:token` path segment is
 * the capability — treat the full URL as a password. Token is validated
 * constant-time against ~/.cibus-wolt/webhook-token.
 *
 * Unlike the MCP routes (which also carry a token and are consumed by Claude),
 * these routes exist for phone Shortcuts and raw curl use — no Claude involved.
 */

export async function loadOrCreateWebhookToken(): Promise<string> {
  try {
    const t = (await fs.readFile(paths.webhookToken, "utf8")).trim();
    if (t) return t;
  } catch {
    /* create fresh */
  }
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(paths.webhookToken, token, { mode: 0o600 });
  logger.info("Generated fresh webhook token and wrote ~/.cibus-wolt/webhook-token");
  return token;
}

function requireTokenMatch(expected: string) {
  return (req: Request, res: Response, next: () => void) => {
    const provided = String(req.params.token ?? "");
    if (provided.length !== expected.length) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // constant-time compare
    try {
      const ok = crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    } catch {
      res.status(404).json({ error: "not_found" });
      return;
    }
    next();
  };
}

interface TunnelUrlSource {
  /** Called on demand; returns the current public tunnel URL or null if unknown. */
  readCurrentUrl: () => Promise<string | null>;
}

export function createWebhookRouter(token: string, tunnelUrlSource?: TunnelUrlSource): Router {
  const router = createRouter();
  router.use("/:token", requireTokenMatch(token));

  router.post("/:token/drain", (async (req: Request, res: Response) => {
    const dryRun = Boolean(req.body?.dry_run);
    const amountRaw = req.body?.amount;
    let amount: number | undefined;
    if (amountRaw !== undefined && amountRaw !== null) {
      const n = Number(amountRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: "invalid_amount", detail: "must be a positive integer" });
        return;
      }
      amount = n;
    }
    const { runDrainInBackground } = await import("./commands/run.ts");
    const result = runDrainInBackground({ dryRun, amount });
    logger.info({ dryRun, amount, runId: result.runId }, "Webhook drain queued");
    res.status(202).json({ run_id: result.runId, state: "queued" });
  }) as any);

  router.post("/:token/otp", ((req: Request, res: Response) => {
    const code = String(req.body?.code ?? "").trim();
    if (!/^\d{4,8}$/.test(code)) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    const accepted = submit("otp", code);
    res.json({ accepted, message: accepted ? "OTP delivered" : "No active OTP wait" });
  }) as any);

  router.post("/:token/magic_link", ((req: Request, res: Response) => {
    const url = String(req.body?.url ?? "").trim();
    if (!/^https:\/\/wolt\.com\/me\/magic_login\?/.test(url)) {
      res.status(400).json({ error: "invalid_url", expected: "https://wolt.com/me/magic_login?..." });
      return;
    }
    const accepted = submit("magic_link", url);
    res.json({ accepted, message: accepted ? "Magic link delivered" : "No active magic-link wait" });
  }) as any);

  router.post("/:token/ack", ((_req: Request, res: Response) => {
    // Ack is interpreted as "user says they've re-logged-in; retry whatever was waiting"
    // Currently the drain doesn't have an `ack` kind — future extension if needed.
    res.json({ accepted: true, message: "Ack noted (no-op for now)" });
  }) as any);

  router.get("/:token/status", ((_req: Request, res: Response) => {
    const active = getActiveRun();
    const pending = getPendingInput();
    res.json({ active, waiting_for: pending });
  }) as any);

  router.get("/:token/url", (async (_req: Request, res: Response) => {
    const url = (await tunnelUrlSource?.readCurrentUrl()) ?? null;
    res.json({ url });
  }) as any);

  return router;
}
