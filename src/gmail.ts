import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./logger.ts";

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;

export interface GmailCreds {
  user: string;
  pass: string;
}

export function tryLoadGmailCreds(user: string, pass: string): GmailCreds | null {
  if (!user || !pass) return null;
  return { user, pass };
}

async function connect(creds: GmailCreds): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
  await client.connect();
  await client.mailboxOpen("INBOX");
  return client;
}

interface SearchOpts {
  since: Date;
  subject?: string;
  from?: string;
}

interface RawMessage {
  uid: number;
  internalDate: number;
  text: string;
  html: string;
  subject: string;
  from: string;
}

async function searchAndFetch(client: ImapFlow, opts: SearchOpts): Promise<RawMessage[]> {
  // IMAP SINCE granularity is one day; the client-side `internalDate` filter
  // below handles sub-day precision.
  const criteria: Record<string, unknown> = { since: opts.since };
  if (opts.subject) criteria.subject = opts.subject;
  if (opts.from) criteria.from = opts.from;

  const uids = await client.search(criteria, { uid: true });
  logger.info({ criteria, found: uids ? uids.length : 0 }, "IMAP search");
  if (!uids || uids.length === 0) return [];

  // Fetch the most recent N to bound work — we only need the newest match.
  const recent = uids.slice(-10);
  const results: RawMessage[] = [];
  for (const uid of recent) {
    const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const parsed = await simpleParser(msg.source);
    const rawInternal = msg.internalDate;
    const internalDate = rawInternal instanceof Date
      ? rawInternal.getTime()
      : rawInternal
        ? new Date(rawInternal).getTime()
        : Date.now();
    results.push({
      uid,
      internalDate,
      text: parsed.text ?? "",
      html: typeof parsed.html === "string" ? parsed.html : "",
      subject: parsed.subject ?? "",
      from: parsed.from?.text ?? "",
    });
  }
  return results;
}

async function withConnection<T>(
  creds: GmailCreds,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = await connect(creds);
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort close.
    }
  }
}

export interface FindMagicLinkOpts {
  creds: GmailCreds;
  since: Date;
  expectEmail: string;
  timeoutMs?: number;
  pollMs?: number;
}

export async function fetchWoltMagicLink(opts: FindMagicLinkOpts): Promise<string> {
  const { creds, expectEmail, since, timeoutMs = 90_000, pollMs = 3_000 } = opts;
  const sinceMs = since.getTime();
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<number>();

  logger.info({ since: since.toISOString() }, "Polling Gmail (IMAP) for Wolt magic-link email (latest wins)");

  let client: ImapFlow | null = null;
  try {
    client = await connect(creds);
    while (Date.now() < deadline) {
      try {
        const msgs = await searchAndFetch(client, { since, from: "wolt" });
        for (const m of msgs) {
          if (seen.has(m.uid)) continue;
          seen.add(m.uid);
          const ageMin = Math.round((Date.now() - m.internalDate) / 60_000);
          logger.info({ uid: m.uid, subject: m.subject, from: m.from, ageMin }, "Gmail message candidate");

          if (m.internalDate < sinceMs) {
            logger.info({ uid: m.uid, sinceISO: since.toISOString() }, "Skipping stale message (older than `since`)");
            continue;
          }
          const url = extractMagicUrl(m);
          if (!url) {
            logger.debug({ uid: m.uid }, "Message has no magic URL");
            continue;
          }
          const urlEmail = new URL(url).searchParams.get("email") ?? "";
          if (urlEmail.toLowerCase() !== expectEmail.toLowerCase()) {
            logger.warn({ uid: m.uid, urlEmail, expectEmail }, "URL email differs from config — using anyway (mailbox scoped)");
          }
          logger.info(
            { uid: m.uid, subject: m.subject, from: m.from, ageMin },
            "✓ Using this Gmail message for the magic link",
          );
          return url;
        }
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, "Gmail IMAP search/fetch error — reconnecting");
        try {
          await client.logout();
        } catch {
          // Ignore cleanup error.
        }
        client = await connect(creds);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        // Best-effort close.
      }
    }
  }
  throw new Error(`Timed out waiting for Wolt magic-link email after ${timeoutMs}ms`);
}

function extractMagicUrl(m: RawMessage): string | null {
  const corpus = `${m.text}\n${m.html}`;
  const re = /https:\/\/wolt\.com\/[^\s"'<>]*magic_login[^\s"'<>]*/gi;
  const matches = corpus.match(re);
  if (!matches || matches.length === 0) return null;
  return matches[0]!.replace(/&amp;/g, "&");
}

export interface FetchCibusOtpOpts {
  creds: GmailCreds;
  since: Date;
  timeoutMs?: number;
  pollMs?: number;
}

export async function fetchCibusOtp(opts: FetchCibusOtpOpts): Promise<string> {
  const { creds, since, timeoutMs = 120_000, pollMs = 5_000 } = opts;
  const sinceMs = since.getTime();
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<number>();

  logger.info({ sinceIso: since.toISOString() }, "Polling Gmail (IMAP) for Cibus OTP email");

  let client: ImapFlow | null = null;
  try {
    client = await connect(creds);
    while (Date.now() < deadline) {
      try {
        const msgs = await searchAndFetch(client, { since, subject: "cibus-otp" });
        const candidates: Array<{ uid: number; internalDate: number; code: string }> = [];
        for (const m of msgs) {
          if (seen.has(m.uid)) continue;
          seen.add(m.uid);
          if (m.internalDate < sinceMs) {
            logger.info({ uid: m.uid, subject: m.subject, ageSec: Math.round((sinceMs - m.internalDate) / 1000) }, "Skipping pre-since OTP message");
            continue;
          }
          const code = extractOtpCode(m.text || m.html);
          if (!code) {
            logger.warn({ uid: m.uid, subject: m.subject, preview: (m.text || m.html || "").slice(0, 200) }, "OTP message found but no 6-digit code parsed");
            continue;
          }
          candidates.push({ uid: m.uid, internalDate: m.internalDate, code });
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.internalDate - a.internalDate);
          const newest = candidates[0]!;
          logger.info({ uid: newest.uid, code: newest.code, candidates: candidates.length }, "✓ Cibus OTP code found in Gmail");
          return newest.code;
        }
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, "Gmail IMAP OTP fetch error — reconnecting");
        try {
          await client.logout();
        } catch {
          // Ignore cleanup error.
        }
        client = await connect(creds);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        // Best-effort close.
      }
    }
  }
  throw new Error(`Timed out waiting for Cibus OTP email after ${timeoutMs}ms`);
}

function extractOtpCode(body: string): string | null {
  const hash = body.match(/#(\d{6})\b/);
  if (hash) return hash[1]!;
  const word = body.match(/(?:קוד|code|otp)[^\d]*(\d{6})\b/i);
  if (word) return word[1]!;
  const digits = body.match(/\b(\d{6})\b/);
  return digits ? digits[1]! : null;
}

export async function verifyGmailCreds(creds: GmailCreds): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  try {
    await withConnection(creds, async () => {
      // mailboxOpen already happened in connect(); reaching here = login + INBOX worked.
    });
    return { ok: true, email: creds.user };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
