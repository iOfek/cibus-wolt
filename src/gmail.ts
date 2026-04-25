import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import { google } from "googleapis";
import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { URL } from "node:url";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";

const TOKEN_PATH = paths.token;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

async function loadToken(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(creds: Credentials): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(creds, null, 2));
}

function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) logger.warn({ err: err.message }, "Could not auto-open browser; paste URL manually");
  });
}

async function interactiveAuth(clientId: string, clientSecret: string): Promise<OAuth2Client> {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = crypto.randomBytes(16).toString("hex");

  const { port, code } = await new Promise<{ port: number; code: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!req.url) return;
        const reqUrl = new URL(req.url, `http://127.0.0.1`);
        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const gotState = reqUrl.searchParams.get("state");
        const gotCode = reqUrl.searchParams.get("code");
        const err = reqUrl.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "content-type": "text/html" }).end(`<h1>Auth error: ${err}</h1>`);
          server.close();
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        if (gotState !== state || !gotCode) {
          res.writeHead(400, { "content-type": "text/html" }).end("<h1>Invalid callback</h1>");
          server.close();
          reject(new Error("Invalid OAuth callback"));
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<h1>Authorized ✓</h1><p>You can close this tab.</p>");
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        server.close();
        resolve({ port: p, code: gotCode });
      } catch (e) {
        reject(e as Error);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("Failed to bind local server"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        prompt: "consent",
      });
      logger.info("Opening browser for Google OAuth consent...");
      logger.info(`If the browser doesn't open, paste this URL: ${authUrl}`);
      openBrowser(authUrl);
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { tokens } = await client.getToken({
    code,
    codeVerifier,
  } as { code: string; codeVerifier: string });
  client.setCredentials(tokens);
  await saveToken(tokens);
  logger.info("Google OAuth complete; token saved to token.json");
  return client;
}

export async function tryLoadAuthClient(clientId: string, clientSecret: string): Promise<OAuth2Client | null> {
  const existing = await loadToken();
  if (!existing?.refresh_token) return null;
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(existing);
  client.on("tokens", async (t) => {
    const merged = { ...existing, ...t };
    await saveToken(merged);
  });
  return client;
}

export async function getAuthClient(clientId: string, clientSecret: string): Promise<OAuth2Client> {
  const cached = await tryLoadAuthClient(clientId, clientSecret);
  if (cached) return cached;
  return interactiveAuth(clientId, clientSecret);
}

export interface FindMagicLinkOpts {
  auth: OAuth2Client;
  since?: Date;
  expectEmail: string;
  timeoutMs?: number;
  pollMs?: number;
}

export async function fetchWoltMagicLink(opts: FindMagicLinkOpts): Promise<string> {
  const { auth, expectEmail, timeoutMs = 90_000, pollMs = 3_000 } = opts;
  const gmail = google.gmail({ version: "v1", auth });
  const query = `from:wolt newer_than:1d`;
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();

  logger.info({ query }, "Polling Gmail for Wolt magic-link email (latest wins)");

  while (Date.now() < deadline) {
    try {
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
      const msgs = list.data.messages ?? [];
      logger.debug({ found: msgs.length }, "Gmail search returned");

      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const headers = full.data.payload?.headers ?? [];
        const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
        const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
        const internalDate = Number(full.data.internalDate ?? 0);
        const ageMin = Math.round((Date.now() - internalDate) / 60_000);
        logger.info({ id: m.id, subject, from, ageMin }, "Gmail message candidate");

        const url = extractMagicUrl(full.data);
        if (!url) {
          logger.debug({ id: m.id }, "Message has no magic URL");
          continue;
        }
        const urlEmail = new URL(url).searchParams.get("email") ?? "";
        if (urlEmail.toLowerCase() !== expectEmail.toLowerCase()) {
          logger.warn({ id: m.id, urlEmail, expectEmail }, "URL email differs from config — using anyway (mailbox scoped)");
        }
        const dateStr = new Date(internalDate).toISOString();
        logger.info(
          { messageId: m.id, subject, from, dateStr, ageMin },
          "✓ Using this Gmail message for the magic link",
        );
        return url;
      }
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "Gmail list/get error");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for Wolt magic-link email after ${timeoutMs}ms`);
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[];
}

function decodePart(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

function collectBody(part: GmailPart): string {
  if (part.parts && part.parts.length > 0) {
    return part.parts.map(collectBody).join("\n");
  }
  const mt = part.mimeType ?? "";
  if (mt.startsWith("text/")) return decodePart(part);
  return "";
}

function extractMagicUrl(msg: { payload?: GmailPart | null }): string | null {
  if (!msg.payload) return null;
  const body = collectBody(msg.payload);
  const re = /https:\/\/wolt\.com\/[^\s"'<>]*magic_login[^\s"'<>]*/gi;
  const matches = body.match(re);
  if (!matches || matches.length === 0) return null;
  return matches[0]!.replace(/&amp;/g, "&");
}

export interface FetchCibusOtpOpts {
  auth: OAuth2Client;
  since: Date;
  timeoutMs?: number;
  pollMs?: number;
}

export async function fetchCibusOtp(opts: FetchCibusOtpOpts): Promise<string> {
  const { auth, since, timeoutMs = 120_000, pollMs = 5_000 } = opts;
  const gmail = google.gmail({ version: "v1", auth });
  const query = `subject:cibus-otp newer_than:1d`;
  const sinceMs = since.getTime();
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();

  logger.info({ query, sinceIso: since.toISOString() }, "Polling Gmail for Cibus OTP email");

  while (Date.now() < deadline) {
    try {
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 5 });
      const msgs = list.data.messages ?? [];

      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const internalDate = Number(full.data.internalDate ?? 0);
        if (internalDate < sinceMs) {
          logger.debug({ id: m.id }, "OTP email older than request — skipping");
          continue;
        }
        const body = full.data.payload ? collectBody(full.data.payload) : "";
        const code = extractOtpCode(body);
        if (code) {
          logger.info({ id: m.id, code }, "✓ Cibus OTP code found in Gmail");
          return code;
        }
        logger.debug({ id: m.id, bodyPreview: body.slice(0, 100) }, "OTP not parsed");
      }
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "Gmail OTP fetch error");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for Cibus OTP email after ${timeoutMs}ms`);
}

function extractOtpCode(body: string): string | null {
  // "#357011" hashtag pattern
  const hash = body.match(/#(\d{6})\b/);
  if (hash) return hash[1]!;
  // Any 6-digit number preceded by OTP keywords
  const word = body.match(/(?:קוד|code|otp)[^\d]*(\d{6})\b/i);
  if (word) return word[1]!;
  // Fallback: first standalone 6-digit number
  const digits = body.match(/\b(\d{6})\b/);
  return digits ? digits[1]! : null;
}
