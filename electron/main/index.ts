/**
 * Electron main process — the Node side of the app.
 *
 * Two concepts to know if you're new to Electron:
 *
 * 1. Two process types live in every Electron app:
 *    - Main (this file): runs Node, has full filesystem/OS access. Owns the
 *      app lifecycle, the BrowserWindow(s), the tray, and any long-running
 *      work (scheduler, Playwright, IMAP). There is exactly one.
 *    - Renderer (electron/renderer/*): runs Chromium, like a browser tab. No
 *      Node access by default. Talks to main only via IPC.
 *
 * 2. The main process must stay alive for the tray + scheduler to keep
 *    working. The window's close button HIDES instead of quitting; the only
 *    real exit is the tray "Quit" menu item.
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM doesn't have __dirname; reconstruct it from the module URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev/prod separation: use a different name + userData dir for the dev
// build, so running `npm run app:dev` doesn't share the single-instance
// lock with the installed /Applications/Cibus Drain.app. Otherwise quitting
// one would be required before launching the other.
if (!app.isPackaged) {
  app.setName("Cibus Drain (dev)");
  app.setPath("userData", path.join(app.getPath("appData"), "cibus-wolt-dev"));
}

/**
 * IPC handlers — the bridge between the window UI and the existing src/
 * modules. Each handler:
 *   1. Dynamic-imports from src/. We do this lazily (not at top of file)
 *      because src/config.ts validates env vars at import time and throws
 *      if any are missing — a top-level import would crash the whole app
 *      on launch when the user hasn't set up ~/.cibus-wolt/.env yet.
 *   2. Catches every error and returns a structured { ok, error } shape so
 *      the renderer can show a friendly message instead of a blank screen.
 */

type BalanceResult = { ok: true; balance: number } | { ok: false; error: string };
type DrainResult = { ok: true } | { ok: false; error: string };

ipcMain.handle("cibus:getBalance", async (): Promise<BalanceResult> => {
  try {
    const { config } = await import("../../src/config.ts");
    const { getCibusWeeklyBalance } = await import("../../src/cibus.ts");
    const { tryLoadGmailCreds } = await import("../../src/gmail.ts");

    const gmail = config.gmailEnabled
      ? tryLoadGmailCreds(config.gmail.user, config.gmail.pass) ?? undefined
      : undefined;

    const balance = await getCibusWeeklyBalance(config.cibus, { gmail });
    return { ok: true, balance };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("cibus:drainNow", async (): Promise<DrainResult> => {
  try {
    const { runDrainCommand } = await import("../../src/commands/run.ts");
    await runDrainCommand();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Env file management — what `cibus-wolt setup` produces in the CLI.
//
// Lives at ~/.cibus-wolt/.env (mode 0600). Same format the existing src/
// modules consume. We read/write here so the in-app Credentials screen can
// replace the terminal `setup` wizard for the basics.
// ────────────────────────────────────────────────────────────────────────────

const envFilePath = () => path.join(os.homedir(), ".cibus-wolt", ".env");

async function readEnvFile(file: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(file, "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnvFile(file: string, env: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = Object.entries(env)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${v}`);
  await fs.writeFile(file, lines.join("\n") + "\n", { mode: 0o600 });
}

ipcMain.handle("cibus:readEnv", async (): Promise<Record<string, string>> => {
  return readEnvFile(envFilePath());
});

ipcMain.handle("cibus:writeEnv", async (_event, partial: Record<string, string>) => {
  const file = envFilePath();
  const current = await readEnvFile(file);
  const next: Record<string, string> = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v === "" || v == null) delete next[k];
    else next[k] = v;
  }
  // CIBUS_AUTH_MODE is hardcoded to "password" in the wizard; mirror that here
  // so the Credentials screen doesn't have to expose the choice.
  if (next.CIBUS_USER) next.CIBUS_AUTH_MODE = next.CIBUS_AUTH_MODE ?? "password";
  await writeEnvFile(file, next);
  return { ok: true as const };
});

ipcMain.handle("cibus:isConfigured", async (): Promise<boolean> => {
  const env = await readEnvFile(envFilePath());
  return Boolean(env.CIBUS_USER && env.CIBUS_PASS && env.CIBUS_COMPANY);
});

// ────────────────────────────────────────────────────────────────────────────
// Setup wizard handlers — wrappers around existing src/ helpers so the in-app
// wizard can replace the terminal `cibus-wolt setup` for the basics.
// ────────────────────────────────────────────────────────────────────────────

ipcMain.handle("cibus:checkChrome", async () => {
  try {
    const { findChrome } = await import("../../src/platform.ts");
    const found = findChrome();
    return { found: Boolean(found), path: found ?? null };
  } catch (e) {
    return {
      found: false,
      path: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle(
  "cibus:verifyGmail",
  async (_event, creds: { user: string; pass: string }) => {
    try {
      const { verifyGmailCreds } = await import("../../src/gmail.ts");
      return await verifyGmailCreds(creds);
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
);

ipcMain.handle("cibus:woltLogin", async () => {
  try {
    const { acquireBrowser } = await import("../../src/browser.ts");
    const { ensureWoltLoggedIn } = await import("../../src/woltLogin.ts");
    const browser = await acquireBrowser();
    try {
      const page = browser.context.pages()[0] ?? (await browser.context.newPage());
      await ensureWoltLoggedIn({ page });
      return { ok: true as const };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

ipcMain.handle("cibus:dryRunDrain", async () => {
  try {
    const { runDrainCommand } = await import("../../src/commands/run.ts");
    await runDrainCommand({ dryRun: true });
    return { ok: true as const };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Schedules — wraps src/schedules.ts state file with server-side validation.
// Loaders return state (default-on-error); mutations return { ok, error? }.
// ────────────────────────────────────────────────────────────────────────────

ipcMain.handle("cibus:loadSchedules", async () => {
  try {
    const { loadSchedulesState } = await import("../../src/schedules.ts");
    return await loadSchedulesState();
  } catch {
    return { cadence: "weekly", schedules: [] };
  }
});

ipcMain.handle("cibus:setCadence", async (_event, cadence: "weekly" | "monthly" | "daily") => {
  try {
    const { loadSchedulesState, saveSchedulesState } = await import("../../src/schedules.ts");
    const state = await loadSchedulesState();
    state.cadence = cadence;
    await saveSchedulesState(state);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle(
  "cibus:addSchedule",
  async (
    _event,
    input: {
      name?: string;
      dayOfWeek?: number;
      dayOfMonth?: number;
      time: string;
      amount?: number;
      enabled?: boolean;
    },
  ) => {
    try {
      const { loadSchedulesState, saveSchedulesState, validateScheduleInput, newSchedule } =
        await import("../../src/schedules.ts");
      const { fireTimeForPeriod, periodKey } = await import("../../src/scheduler.ts");
      const state = await loadSchedulesState();
      const err = validateScheduleInput(state.cadence, input);
      if (err) return { ok: false as const, error: err };
      const sched = newSchedule(input);

      // If the fire time for the current period has already passed, mark
      // this period as already-handled. Without this, the scheduler's
      // catch-up logic treats the just-created schedule as a missed fire
      // and runs it immediately — surprising for a schedule the user just
      // added. Wait until the next period instead.
      const now = new Date();
      const fireTime = fireTimeForPeriod(sched, state.cadence, now);
      if (fireTime.getTime() <= now.getTime()) {
        const key = periodKey(now, state.cadence);
        sched.lastFiredPeriodKey = key;
        sched.lastSuccessPeriodKey = key;
      }

      state.schedules.push(sched);
      await saveSchedulesState(state);
      return { ok: true as const, schedule: sched };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle("cibus:deleteSchedule", async (_event, id: string) => {
  try {
    const { loadSchedulesState, saveSchedulesState } = await import("../../src/schedules.ts");
    const state = await loadSchedulesState();
    state.schedules = state.schedules.filter((s) => s.id !== id);
    await saveSchedulesState(state);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle(
  "cibus:setScheduleEnabled",
  async (_event, id: string, enabled: boolean) => {
    try {
      const { loadSchedulesState, saveSchedulesState } = await import("../../src/schedules.ts");
      const state = await loadSchedulesState();
      const sched = state.schedules.find((s) => s.id === id);
      if (sched) sched.enabled = enabled;
      await saveSchedulesState(state);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// MCP HTTP server — local-only, listens on 127.0.0.1:MCP_PORT.
//
// Mirrors src/scripts/mcp.ts but runs in-process so the UI can start/stop it
// and the tray can reflect status. Skips the webhook router and the cloudflared
// tunnel detection — those are out of MVP scope (no remote access).
// ────────────────────────────────────────────────────────────────────────────

const MCP_PORT = Number(process.env.MCP_PORT ?? 3737);
let mcpHttpServer: HttpServer | null = null;

async function startMcpHttpServer(): Promise<
  { ok: true; port: number; token: string } | { ok: false; error: string }
> {
  if (mcpHttpServer) return { ok: false, error: "Server already running" };

  // Read or generate the bearer token. Save to .env so it survives restarts
  // and stays in sync with whatever the CLI version of the app uses.
  const envPath = envFilePath();
  const env = await readEnvFile(envPath);
  let token = env.MCP_BEARER_TOKEN;
  if (!token || token === "change-me") {
    token = crypto.randomBytes(32).toString("hex");
    env.MCP_BEARER_TOKEN = token;
    await writeEnvFile(envPath, env);
  }

  try {
    // All MCP deps are lazy-imported. createMcpServer pulls in src/config.ts
    // which throws on missing env vars — catching surfaces a clean error
    // instead of a cryptic stack trace.
    const expressMod = await import("express");
    const expressFn = (expressMod as unknown as { default: typeof import("express") }).default;
    const { createMcpServer } = await import("../../src/mcp/server.ts");
    const transportMod = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const { StreamableHTTPServerTransport } = transportMod;

    const expressApp = expressFn();
    expressApp.use(expressFn.json({ limit: "1mb" }));

    expressApp.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    const requireToken = (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
      const header = req.header("authorization") ?? "";
      const headerOk = header === `Bearer ${token}`;
      const pathOk = typeof req.params.token === "string" && req.params.token === token;
      if (!headerOk && !pathOk) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      next();
    };

    const handleMcp = async (req: import("express").Request, res: import("express").Response) => {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        if (!res.headersSent) {
          res.status(500).json({
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    expressApp.all("/mcp/:token", requireToken, handleMcp);
    expressApp.all("/mcp", requireToken, handleMcp);

    mcpHttpServer = await new Promise<HttpServer>((resolve, reject) => {
      const srv = expressApp.listen(MCP_PORT, "127.0.0.1", () => resolve(srv));
      srv.once("error", reject);
    });

    updateTray();
    broadcastMcpStatus();
    return { ok: true, port: MCP_PORT, token };
  } catch (e) {
    mcpHttpServer = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function stopMcpHttpServer(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!mcpHttpServer) return { ok: true };
  const srv = mcpHttpServer;
  mcpHttpServer = null;
  try {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
    updateTray();
    broadcastMcpStatus();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface McpStatus {
  running: boolean;
  port: number;
  token: string;
  url: string | null;
  active: { id: string; state: string } | null;
}

async function getMcpStatus(): Promise<McpStatus> {
  const env = await readEnvFile(envFilePath());
  const token = env.MCP_BEARER_TOKEN ?? "";
  let active: McpStatus["active"] = null;
  try {
    const { getActiveRun } = await import("../../src/mcp/runRegistry.ts");
    const run = getActiveRun();
    if (run) active = { id: run.id, state: run.state };
  } catch {
    /* runRegistry import failed — leave active null */
  }
  return {
    running: mcpHttpServer !== null,
    port: MCP_PORT,
    token,
    url: mcpHttpServer && token ? `http://127.0.0.1:${MCP_PORT}/mcp/${token}` : null,
    active,
  };
}

/** Push current MCP status to all open windows. Renderer subscribes via preload. */
function broadcastMcpStatus(): void {
  void (async () => {
    const status = await getMcpStatus();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("mcp:status", status);
    }
  })();
}

ipcMain.handle("cibus:mcpStatus", async () => getMcpStatus());
ipcMain.handle("cibus:startMcp", async () => startMcpHttpServer());
ipcMain.handle("cibus:stopMcp", async () => stopMcpHttpServer());

ipcMain.handle("cibus:rotateMcpToken", async () => {
  try {
    const envPath = envFilePath();
    const env = await readEnvFile(envPath);
    env.MCP_BEARER_TOKEN = crypto.randomBytes(32).toString("hex");
    await writeEnvFile(envPath, env);
    // Restart the server if it was running so the new token takes effect.
    if (mcpHttpServer) {
      await stopMcpHttpServer();
      const result = await startMcpHttpServer();
      if (!result.ok) return result;
    }
    broadcastMcpStatus();
    return { ok: true as const, token: env.MCP_BEARER_TOKEN };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// Stop the MCP server cleanly on quit so the port frees immediately.
app.on("before-quit", () => {
  if (mcpHttpServer) {
    try {
      mcpHttpServer.close();
    } catch {
      /* best-effort */
    }
    mcpHttpServer = null;
  }
  if (ngrokProcess) {
    try {
      ngrokProcess.kill();
    } catch {
      /* best-effort */
    }
    ngrokProcess = null;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Tunnel (ngrok) — detect, configure, supervise the subprocess.
//
// We can't auto-install ngrok itself (Homebrew/installers need privileges
// outside Electron), so the UI falls back to opening the install page when
// the binary isn't on PATH.
//
// When packaged, macOS apps launched from Finder inherit the system PATH
// (no /opt/homebrew/bin), so we augment PATH for ngrok subprocess calls.
// ────────────────────────────────────────────────────────────────────────────

let ngrokProcess: ChildProcess | null = null;
let tunnelPublicUrl: string | null = null;

function ngrokSpawnEnv(): NodeJS.ProcessEnv {
  const PATH = process.env.PATH ?? "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = PATH.split(path.delimiter);
  const augmented = [...extra.filter((p) => !dirs.includes(p)), ...dirs]
    .filter(Boolean)
    .join(path.delimiter);
  return { ...process.env, PATH: augmented };
}

function tunnelHostnameFile(): string {
  return path.join(os.homedir(), ".cibus-wolt", "tunnel-hostname");
}

function tunnelKindFile(): string {
  return path.join(os.homedir(), ".cibus-wolt", "tunnel-kind");
}

ipcMain.handle("cibus:openExternal", async (_event, url: string) => {
  // Renderer can only open URLs from a small allowlist — prevents arbitrary
  // navigation if a future renderer surface accepts user-typed URLs.
  const allowed = [
    "https://ngrok.com/",
    "https://dashboard.ngrok.com/",
    "https://claude.ai/",
    "https://www.google.com/chrome/",
    "https://myaccount.google.com/apppasswords",
  ];
  if (!allowed.some((prefix) => url.startsWith(prefix))) {
    return { ok: false as const, error: `URL not in allowlist: ${url}` };
  }
  await shell.openExternal(url);
  return { ok: true as const };
});

ipcMain.handle("cibus:ngrokDetect", async () => {
  const env = ngrokSpawnEnv();

  const versionResult = await new Promise<{ ok: boolean; version?: string; error?: string }>(
    (resolve) => {
      const child = spawn("ngrok", ["version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", () => resolve({ ok: false }));
      child.on("exit", (code) => {
        if (code === 0) resolve({ ok: true, version: stdout.trim().split("\n")[0] });
        else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
      });
    },
  );

  if (!versionResult.ok) {
    return { installed: false as const };
  }

  // `ngrok config check` exits 0 when an authtoken is configured.
  const authResult = await new Promise<boolean>((resolve) => {
    const child = spawn("ngrok", ["config", "check"], { stdio: "ignore", env });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

  return {
    installed: true as const,
    version: versionResult.version,
    authenticated: authResult,
  };
});

ipcMain.handle("cibus:setNgrokAuthToken", async (_event, token: string) => {
  if (!token || !token.trim()) {
    return { ok: false as const, error: "Empty authtoken" };
  }
  const env = ngrokSpawnEnv();
  return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    const child = spawn("ngrok", ["config", "add-authtoken", token.trim()], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `ngrok exited with code ${code}` });
    });
  });
});

ipcMain.handle("cibus:loadTunnelConfig", async () => {
  const hostname = await fs
    .readFile(tunnelHostnameFile(), "utf8")
    .then((s) => s.trim())
    .catch(() => "");
  const kind = await fs
    .readFile(tunnelKindFile(), "utf8")
    .then((s) => s.trim())
    .catch(() => "ngrok");
  return { hostname, kind };
});

ipcMain.handle(
  "cibus:saveTunnelConfig",
  async (_event, hostname: string, kind: "ngrok" | "devtunnel" = "ngrok") => {
    try {
      const dir = path.join(os.homedir(), ".cibus-wolt");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tunnelHostnameFile(), hostname, { mode: 0o600 });
      await fs.writeFile(tunnelKindFile(), kind, { mode: 0o600 });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle("cibus:tunnelStatus", async () => {
  const hostname = await fs
    .readFile(tunnelHostnameFile(), "utf8")
    .then((s) => s.trim())
    .catch(() => "");
  return {
    running: ngrokProcess !== null,
    hostname,
    publicUrl: tunnelPublicUrl,
  };
});

ipcMain.handle("cibus:startTunnel", async () => {
  if (ngrokProcess) {
    return { ok: false as const, error: "Tunnel already running" };
  }

  let hostname: string;
  try {
    hostname = (await fs.readFile(tunnelHostnameFile(), "utf8")).trim();
  } catch {
    return { ok: false as const, error: "No tunnel domain configured" };
  }
  if (!hostname) {
    return { ok: false as const, error: "Tunnel domain is empty" };
  }

  const env = ngrokSpawnEnv();

  return new Promise<{ ok: true; publicUrl: string } | { ok: false; error: string }>(
    (resolve) => {
      const proc = spawn(
        "ngrok",
        ["http", String(MCP_PORT), `--domain=${hostname}`, "--log=stdout"],
        { stdio: ["ignore", "pipe", "pipe"], env },
      );

      let settled = false;
      let stderr = "";

      const settle = (
        result: { ok: true; publicUrl: string } | { ok: false; error: string },
      ) => {
        if (settled) return;
        settled = true;
        if (result.ok) {
          ngrokProcess = proc;
          tunnelPublicUrl = result.publicUrl;
          // Update state when the subprocess later exits (crash, kill, etc).
          proc.on("exit", () => {
            ngrokProcess = null;
            tunnelPublicUrl = null;
            broadcastTunnelStatus();
          });
          broadcastTunnelStatus();
        } else if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        }
        resolve(result);
      };

      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (text: string) => {
        if (text.includes("started tunnel") || text.includes(`url=https://${hostname}`)) {
          settle({ ok: true, publicUrl: `https://${hostname}` });
        }
      });

      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (text: string) => {
        stderr += text;
      });

      proc.on("error", (err) => {
        settle({ ok: false, error: err.message });
      });

      proc.on("exit", (code) => {
        if (!settled) {
          settle({
            ok: false,
            error: stderr.trim() || `ngrok exited with code ${code}`,
          });
        }
      });

      // Hard timeout — ngrok normally connects in 1–3s; 15s is generous.
      setTimeout(() => {
        if (!settled) {
          settle({ ok: false, error: "Timed out waiting for tunnel to start" });
        }
      }, 15000);
    },
  );
});

ipcMain.handle("cibus:stopTunnel", async () => {
  if (!ngrokProcess) return { ok: true as const };
  const proc = ngrokProcess;
  return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    proc.once("exit", () => {
      ngrokProcess = null;
      tunnelPublicUrl = null;
      broadcastTunnelStatus();
      resolve({ ok: true });
    });
    try {
      proc.kill();
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
});

function broadcastTunnelStatus(): void {
  void (async () => {
    const hostname = await fs
      .readFile(tunnelHostnameFile(), "utf8")
      .then((s) => s.trim())
      .catch(() => "");
    const status = {
      running: ngrokProcess !== null,
      hostname,
      publicUrl: tunnelPublicUrl,
    };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("tunnel:status", status);
    }
  })();
}

ipcMain.handle("cibus:getRunHistory", async () => {
  try {
    const { paths } = await import("../../src/paths.ts");
    const text = await fs.readFile(paths.runs, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .reverse()
      .slice(0, 20);
  } catch {
    return [];
  }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Flips to true only when the user picks "Quit" from the tray menu.
// The window-close handler reads this to tell intentional quit apart from
// "user clicked the X" (which should just hide).
let isQuitting = false;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    show: false, // wait for ready-to-show — avoids the empty-flash
    webPreferences: {
      // Preload runs in the renderer's process but with privileged access.
      // It's the bridge that exposes specific main-side functions to the UI
      // without giving the UI full Node powers. Empty placeholder for now.
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true, // keeps renderer JS isolated from preload globals
      sandbox: false,
    },
  });

  // electron-vite sets ELECTRON_RENDERER_URL during dev so we get HMR.
  // In packaged builds the env var is absent and we load the built HTML.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Intercept close: hide instead of destroy so the scheduler keeps running.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

/**
 * Build a 16x16 RGBA tray icon. Two states:
 *   - stopped: black template image (macOS adapts color to light/dark menu bar)
 *   - running: solid green (drawn directly, NOT template, so the green shows)
 *
 * We avoid shipping a PNG asset by generating the bitmap at runtime; swap
 * in a designed icon later by replacing this function.
 */
function makeTrayIcon(running: boolean): Electron.NativeImage {
  const W = 16;
  const H = 16;
  const buf = Buffer.alloc(W * H * 4);
  const r = running ? 44 : 0;
  const g = running ? 140 : 0;
  const b = running ? 68 : 0;
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(buf, { width: W, height: H });
  if (process.platform === "darwin" && !running) icon.setTemplateImage(true);
  return icon;
}

function createTray(): void {
  tray = new Tray(makeTrayIcon(false));

  // Click the icon to toggle window visibility (in addition to right-click).
  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  updateTray();
}

/**
 * Refresh tray icon, tooltip, and context menu based on the current MCP
 * server state. Called whenever state changes (start/stop/rotate).
 */
function updateTray(): void {
  if (!tray) return;
  const running = mcpHttpServer !== null;
  tray.setImage(makeTrayIcon(running));
  tray.setToolTip(`Cibus Drain · MCP: ${running ? "running" : "stopped"}`);

  const menu = Menu.buildFromTemplate([
    {
      label: `MCP server: ${running ? "running" : "stopped"}`,
      enabled: false,
    },
    { type: "separator" },
    { label: "Show window", click: () => showWindow() },
    { type: "separator" },
    {
      label: running ? "Stop MCP server" : "Start MCP server",
      click: async () => {
        if (running) await stopMcpHttpServer();
        else await startMcpHttpServer();
      },
    },
    {
      label: "Drain now",
      click: async () => {
        try {
          const { runDrainCommand } = await import("../../src/commands/run.ts");
          await runDrainCommand();
        } catch (e) {
          console.error("Tray drain failed:", e instanceof Error ? e.message : String(e));
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Single-instance lock: a second launch of the app exits and pings us
// instead. Without this, two schedulers would fire weekly drains in
// parallel and double-charge.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    createMainWindow();
    createTray();

    // Kick off the in-process scheduler. It reads ~/.cibus-wolt/schedules.json,
    // ticks every 60s, and fires due drains in the background. Best-effort —
    // if it fails (missing creds, file errors), manual drain still works.
    try {
      const { startScheduler } = await import("../../src/scheduler.ts");
      await startScheduler();
    } catch (e) {
      console.error("Scheduler failed to start:", e instanceof Error ? e.message : String(e));
    }
  });

  // Tray keeps the app alive — don't quit when the last window closes,
  // even on Windows where that's the platform default.
  app.on("window-all-closed", () => {
    // Intentionally empty.
  });
}
