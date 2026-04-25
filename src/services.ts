/* eslint-disable no-console */
import { execSync } from "node:child_process";
import { IS_MAC, IS_WIN } from "./platform.ts";

/**
 * Names of the two background services we register: the MCP server (always)
 * and the ngrok tunnel (when a static domain is configured). Naming follows
 * each OS's convention — reverse-DNS for launchd, plain task name for Task
 * Scheduler.
 */
export const SERVICE_LABELS = {
  mac: {
    mcp: "com.ofek.cibus-wolt.mcp",
    tunnel: "com.ofek.cibus-wolt.tunnel",
  },
  win: {
    mcp: "CibusWolt-MCP",
    tunnel: "CibusWolt-Tunnel",
  },
} as const;

export type ServiceKind = "mcp" | "tunnel";

export function serviceLabel(kind: ServiceKind): string {
  if (IS_MAC) return SERVICE_LABELS.mac[kind];
  if (IS_WIN) return SERVICE_LABELS.win[kind];
  return SERVICE_LABELS.mac[kind]; // Linux uses launchd-style names if/when added
}

/**
 * True iff *both* services (MCP + tunnel) appear registered with the OS
 * service manager. Used by setup.ts to decide whether to offer to install them.
 */
export function bothServicesInstalled(): boolean {
  if (IS_MAC) {
    try {
      const out = execSync("launchctl list", { encoding: "utf8" });
      return out.includes(SERVICE_LABELS.mac.mcp) && out.includes(SERVICE_LABELS.mac.tunnel);
    } catch {
      return false;
    }
  }
  if (IS_WIN) {
    return queryWinTask(SERVICE_LABELS.win.mcp) && queryWinTask(SERVICE_LABELS.win.tunnel);
  }
  return false;
}

/** Restart the MCP service (called after MCP_BEARER_TOKEN rotation). */
export function restartMcpService(): void {
  if (IS_MAC) {
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${SERVICE_LABELS.mac.mcp}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
    return;
  }
  if (IS_WIN) {
    try {
      execSync(`schtasks /End /TN "${SERVICE_LABELS.win.mcp}"`, { stdio: "ignore" });
    } catch {
      /* not running */
    }
    try {
      execSync(`schtasks /Run /TN "${SERVICE_LABELS.win.mcp}"`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

function queryWinTask(name: string): boolean {
  try {
    execSync(`schtasks /Query /TN "${name}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
