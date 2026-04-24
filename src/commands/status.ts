import { config } from "../config.ts";
import { tryLoadAuthClient } from "../gmail.ts";
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

function fmt(s: PhaseStatus): { state: string; detail: string } {
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
  // eslint-disable-next-line no-console
  console.log(header);
  // eslint-disable-next-line no-console
  console.log("-".repeat(header.length));
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`${pad(r.n, widths.n)}  ${pad(r.name, widths.name)}  ${pad(r.state, widths.state)}  ${r.detail}`);
  }
}

export async function runStatusCommand(): Promise<void> {
  await ensureStateDir();
  const rows: Row[] = [];

  let gmailStatus: PhaseStatus;
  if (!config.gmailEnabled) {
    gmailStatus = { ok: true, summary: "Not configured (optional — Gmail only needed for fully-unattended scheduled runs)" };
  } else {
    const auth = await tryLoadAuthClient(config.google.clientId, config.google.clientSecret);
    gmailStatus = auth
      ? await checkGmail(auth)
      : { ok: false, reason: "token.json missing (run cibus-wolt setup or cibus-wolt run to do OAuth)" };
  }
  const g = fmt(gmailStatus);
  rows.push({ n: "[1/5]", name: "Gmail", state: g.state, detail: g.detail });

  const cibus = fmt(await checkCibusSession());
  rows.push({ n: "[2/5]", name: "Cibus", state: cibus.state, detail: cibus.detail });

  const wolt = fmt(await checkWoltSession());
  rows.push({ n: "[3/5]", name: "Wolt", state: wolt.state, detail: wolt.detail });

  rows.push({ n: "[4/5]", name: "Balance", state: "—", detail: "(fetched on cibus-wolt run or cibus-wolt balance)" });
  rows.push({ n: "[5/5]", name: "Purchase", state: "—", detail: "(happens during cibus-wolt run)" });

  printTable(rows);

  const last = await getLastRun();
  // eslint-disable-next-line no-console
  console.log("");
  if (last) {
    const parts = [`status=${last.status}`, `amount=${last.amount}`];
    if (last.reason) parts.push(`reason=${last.reason}`);
    if (last.url) parts.push(`url=${last.url}`);
    // eslint-disable-next-line no-console
    console.log(`Last run: ${last.ts} — ${parts.join(", ")}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("Last run: (none yet — runs.jsonl empty or missing)");
  }
}
