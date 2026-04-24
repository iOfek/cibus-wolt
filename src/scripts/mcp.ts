import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.ts";
import { createMcpServer } from "../mcp/server.ts";
import { ensureStateDir, paths } from "../paths.ts";
import { startScheduler } from "../scheduler.ts";
import { createWebhookRouter, loadOrCreateWebhookToken } from "../webhook.ts";

const PORT = Number(process.env.MCP_PORT ?? 3737);

async function readCurrentTunnelUrl(): Promise<string | null> {
  // Prefer stable named tunnel if configured
  try {
    const hostname = (await fs.readFile(paths.tunnelHostname, "utf8")).trim();
    if (hostname) return `https://${hostname}`;
  } catch {
    /* no named tunnel configured */
  }
  // Fallback: parse cloudflared logs for the quick-tunnel URL
  const candidates = [
    path.join(paths.logsDir, "tunnel.cloudflared.log"),
    path.join(paths.logsDir, "tunnel.err.log"),
    path.join(paths.logsDir, "tunnel.log"),
  ];
  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
  for (const f of candidates) {
    try {
      const text = await fs.readFile(f, "utf8");
      const matches = text.match(re);
      if (matches && matches.length > 0) return matches[matches.length - 1]!;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function requireMcpToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const headerOk = header === `Bearer ${expected}`;
    const pathOk = typeof req.params.token === "string" && req.params.token === expected;
    if (!headerOk && !pathOk) {
      logger.warn({ path: req.path, ip: req.ip }, "Unauthorized MCP request");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

async function handleMcp(req: Request, res: Response) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "MCP request failed");
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  }
}

async function main() {
  await ensureStateDir();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Webhook routes (phone Shortcuts + curl). Token in URL path.
  const webhookToken = await loadOrCreateWebhookToken();
  app.use("/webhook", createWebhookRouter(webhookToken, { readCurrentUrl: readCurrentTunnelUrl }));

  // MCP routes (Claude). Token in URL path OR Authorization header.
  if (process.env.MCP_BEARER_TOKEN && process.env.MCP_BEARER_TOKEN !== "change-me") {
    const BEARER = process.env.MCP_BEARER_TOKEN;
    app.all("/mcp/:token", requireMcpToken(BEARER), handleMcp);
    app.all("/mcp", requireMcpToken(BEARER), handleMcp);
    logger.info(`MCP enabled at /mcp (bearer) and /mcp/:token (path)`);
  } else {
    logger.info("MCP disabled (set MCP_BEARER_TOKEN to enable)");
  }

  app.listen(PORT, "127.0.0.1", () => {
    logger.info(`Server listening on 127.0.0.1:${PORT}`);
    logger.info(`  Webhook endpoints: /webhook/${webhookToken.slice(0, 4)}…/{drain|otp|magic_link|ack|status|url}`);
    logger.info(`Expose via: cloudflared tunnel --url http://127.0.0.1:${PORT}`);
  });

  // Scheduler runs in-process: loads schedules.json, fires due drains on a 60s tick,
  // catches up missed fires within the same Cibus period, notifies on full-period misses.
  await startScheduler();
}

main().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Server startup failed");
  process.exit(1);
});
