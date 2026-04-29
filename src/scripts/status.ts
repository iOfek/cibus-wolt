import { config } from "../config.ts";
import { tryLoadGmailCreds } from "../gmail.ts";
import { ensureStateDir } from "../paths.ts";
import {
  checkCibusSession,
  checkGmail,
  checkWoltSession,
  getLastRun,
  type PhaseStatus,
} from "../phases.ts";

interface Row {
  n: string;
  name: string;
  state: string;
  detail: string;
}

function fmtStatus(s: PhaseStatus): { state: string; detail: string } {
  return s.ok ? { state: "✓ cached", detail: s.summary } : { state: "✗ needs login", detail: s.reason };
}

function printTable(rows: Row[]): void {
  const widths = {
    n: Math.max(3, ...rows.map((r) => r.n.length)),
    name: Math.max(8, ...rows.map((r) => r.name.length)),
    state: Math.max(12, ...rows.map((r) => r.state.length)),
  };
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length));
  const header = `${pad("#", widths.n)}  ${pad("Phase", widths.name)}  ${pad("State", widths.state)}  Detail`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(`${pad(r.n, widths.n)}  ${pad(r.name, widths.name)}  ${pad(r.state, widths.state)}  ${r.detail}`);
  }
}

async function main() {
  await ensureStateDir();
  const rows: Row[] = [];

  const creds = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
  const gmailStatus: PhaseStatus = creds
    ? await checkGmail(creds)
    : { ok: false, reason: "GMAIL_USER/GMAIL_APP_PASSWORD missing (run cibus-wolt setup)" };
  const g = fmtStatus(gmailStatus);
  rows.push({ n: "[1/5]", name: "Gmail", state: g.state, detail: g.detail });

  const cibus = fmtStatus(await checkCibusSession());
  rows.push({ n: "[2/5]", name: "Cibus", state: cibus.state, detail: cibus.detail });

  const wolt = fmtStatus(await checkWoltSession());
  rows.push({ n: "[3/5]", name: "Wolt", state: wolt.state, detail: wolt.detail });

  rows.push({ n: "[4/5]", name: "Balance", state: "—", detail: "(fetched on npm start)" });
  rows.push({ n: "[5/5]", name: "Purchase", state: "—", detail: "(fetched on npm start)" });

  printTable(rows);

  const last = await getLastRun();
  console.log("");
  if (last) {
    const parts = [`status=${last.status}`, `amount=${last.amount}`];
    if (last.reason) parts.push(`reason=${last.reason}`);
    if (last.url) parts.push(`url=${last.url}`);
    console.log(`Last run: ${last.ts} — ${parts.join(", ")}`);
  } else {
    console.log("Last run: (none yet — runs.jsonl empty or missing)");
  }
}

main().catch((e) => {
  console.error(e?.message ?? String(e));
  process.exit(1);
});
