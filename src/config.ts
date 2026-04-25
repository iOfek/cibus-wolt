import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

// Load .env from ~/.cibus-wolt/ first (installed-tool convention), then
// project-relative (dev convention). Values already set in process.env win.
const homeEnv = path.join(os.homedir(), ".cibus-wolt", ".env");
if (existsSync(homeEnv)) dotenv.config({ path: homeEnv });
dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

const authMode = (process.env.CIBUS_AUTH_MODE ?? "password").toLowerCase();
if (authMode !== "password" && authMode !== "otp") {
  throw new Error(`CIBUS_AUTH_MODE must be "password" or "otp" (got: ${authMode})`);
}

export const config = {
  cibus: {
    username: required("CIBUS_USER"),
    password: required("CIBUS_PASS"),
    company: required("CIBUS_COMPANY"),
    authMode: authMode as "password" | "otp",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  /** True if Gmail OAuth is configured; false if the MCP will rely on submit_magic_link/submit_otp. */
  gmailEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
  minAmount: num("MIN_AMOUNT", 10),
  maxSpend: num("MAX_SPEND", 1200),
  dryRun: process.env.DRY_RUN === "1",
} as const;
