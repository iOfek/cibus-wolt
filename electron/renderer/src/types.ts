/**
 * Shared types for the renderer side, plus the `window.cibus` global
 * declaration that augments the DOM Window interface.
 *
 * The renderer compiles separately from the preload (different bundle,
 * different process), so we restate the shape here for TypeScript. Keep
 * in sync with electron/preload/index.ts and the IPC handlers in
 * electron/main/index.ts.
 */

export interface RunRecord {
  ts: string;
  amount: number;
  status: "success" | "dry-run" | "skipped" | "failed";
  reason?: string;
  url?: string;
}

export type BalanceResult =
  | { ok: true; balance: number }
  | { ok: false; error: string };

export type DrainResult = { ok: true } | { ok: false; error: string };

export type EnvMap = Record<string, string>;

export type ChromeCheck = { found: boolean; path: string | null; error?: string };
export type GmailVerify =
  | { ok: true; email: string }
  | { ok: false; error: string };

export type Cadence = "weekly" | "monthly" | "daily";

export interface Schedule {
  id: string;
  name?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  time: string;
  amount?: number;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  lastFiredPeriodKey?: string;
  lastSuccessAt?: string;
  lastSuccessPeriodKey?: string;
  lastMissedAt?: string;
}

export interface SchedulesState {
  cadence: Cadence;
  schedules: Schedule[];
}

export interface ScheduleInput {
  name?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  time: string;
  amount?: number;
}

export type ScheduleResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; error: string };

export interface McpStatus {
  running: boolean;
  port: number;
  token: string;
  url: string | null;
  active: { id: string; state: string } | null;
}

export type McpStartResult =
  | { ok: true; port: number; token: string }
  | { ok: false; error: string };

export type NgrokDetect =
  | { installed: false }
  | { installed: true; version?: string; authenticated: boolean };

export interface TunnelConfig {
  hostname: string;
  kind: "ngrok" | "devtunnel" | string;
}

export interface TunnelStatus {
  running: boolean;
  hostname: string;
  publicUrl: string | null;
}

export type TunnelStartResult =
  | { ok: true; publicUrl: string }
  | { ok: false; error: string };

declare global {
  interface Window {
    cibus: {
      getBalance(): Promise<BalanceResult>;
      drainNow(): Promise<DrainResult>;
      getRunHistory(): Promise<RunRecord[]>;
      readEnv(): Promise<EnvMap>;
      writeEnv(partial: EnvMap): Promise<{ ok: true }>;
      isConfigured(): Promise<boolean>;
      checkChrome(): Promise<ChromeCheck>;
      verifyGmail(creds: { user: string; pass: string }): Promise<GmailVerify>;
      woltLogin(): Promise<{ ok: true } | { ok: false; error: string }>;
      dryRunDrain(): Promise<{ ok: true } | { ok: false; error: string }>;
      loadSchedules(): Promise<SchedulesState>;
      setCadence(cadence: Cadence): Promise<{ ok: true } | { ok: false; error: string }>;
      addSchedule(input: ScheduleInput): Promise<ScheduleResult>;
      deleteSchedule(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
      setScheduleEnabled(
        id: string,
        enabled: boolean,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      mcpStatus(): Promise<McpStatus>;
      startMcp(): Promise<McpStartResult>;
      stopMcp(): Promise<{ ok: true } | { ok: false; error: string }>;
      rotateMcpToken(): Promise<
        { ok: true; token: string } | { ok: false; error: string }
      >;
      onMcpStatus(callback: (status: McpStatus) => void): () => void;
      ngrokDetect(): Promise<NgrokDetect>;
      setNgrokAuthToken(
        token: string,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      loadTunnelConfig(): Promise<TunnelConfig>;
      saveTunnelConfig(
        hostname: string,
        kind?: "ngrok" | "devtunnel",
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      startTunnel(): Promise<TunnelStartResult>;
      stopTunnel(): Promise<{ ok: true } | { ok: false; error: string }>;
      tunnelStatus(): Promise<TunnelStatus>;
      onTunnelStatus(callback: (status: TunnelStatus) => void): () => void;
      openExternal(
        url: string,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}
