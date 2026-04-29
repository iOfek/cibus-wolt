/* eslint-disable no-console */
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
import { describeSchedule, loadSchedulesState } from "../schedules.ts";
import { nextFireTime, readMissed } from "../scheduler.ts";
import {
  bold, cmd, cyan, dim, green, padVisible, red, visibleLength,
} from "../ui.ts";

interface Row {
  n: string;
  name: string;
  state: string;
  detail: string;
}

function fmt(s: PhaseStatus): { state: string; detail: string } {
  return s.ok
    ? { state: `${green("✓")} cached`, detail: s.summary }
    : { state: `${red("✗")} needs login`, detail: s.reason };
}

function printTable(rows: Row[]): void {
  const widths = {
    n: Math.max(3, ...rows.map((r) => visibleLength(r.n))),
    name: Math.max(8, ...rows.map((r) => visibleLength(r.name))),
    state: Math.max(12, ...rows.map((r) => visibleLength(r.state))),
  };
  const header = `${padVisible(bold("#"), widths.n)}  ${padVisible(bold("Phase"), widths.name)}  ${padVisible(bold("State"), widths.state)}  ${bold("Detail")}`;
  console.log(header);
  console.log(dim("-".repeat(widths.n + widths.name + widths.state + 6 + 20)));
  for (const r of rows) {
    console.log(`${padVisible(cyan(r.n), widths.n)}  ${padVisible(bold(r.name), widths.name)}  ${padVisible(r.state, widths.state)}  ${dim(r.detail)}`);
  }
}

export async function runStatusCommand(): Promise<void> {
  await ensureStateDir();
  const rows: Row[] = [];

  let gmailStatus: PhaseStatus;
  if (!config.gmailEnabled) {
    gmailStatus = { ok: true, summary: "Not configured (optional — Gmail only needed for fully-unattended scheduled runs)" };
  } else {
    const creds = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
    gmailStatus = creds
      ? await checkGmail(creds)
      : { ok: false, reason: "GMAIL_USER/GMAIL_APP_PASSWORD missing (run cibus-wolt setup)" };
  }
  const g = fmt(gmailStatus);
  rows.push({ n: "[1/5]", name: "Gmail", state: g.state, detail: g.detail });

  const cibus = fmt(await checkCibusSession());
  rows.push({ n: "[2/5]", name: "Cibus", state: cibus.state, detail: cibus.detail });

  const wolt = fmt(await checkWoltSession());
  rows.push({ n: "[3/5]", name: "Wolt", state: wolt.state, detail: wolt.detail });

  rows.push({ n: "[4/5]", name: "Balance", state: dim("—"), detail: "(fetched on cibus-wolt run or cibus-wolt balance)" });
  rows.push({ n: "[5/5]", name: "Purchase", state: dim("—"), detail: "(happens during cibus-wolt run)" });

  printTable(rows);

  const last = await getLastRun();
  console.log("");
  if (last) {
    const parts = [`${dim("status=")}${bold(last.status)}`, `${dim("amount=")}${bold(String(last.amount))}`];
    if (last.reason) parts.push(`${dim("reason=")}${last.reason}`);
    if (last.url) parts.push(`${dim("url=")}${last.url}`);
    console.log(`${bold("Last run:")} ${dim(last.ts)} — ${parts.join(", ")}`);
  } else {
    console.log(`${bold("Last run:")} ${dim("(none yet — runs.jsonl empty or missing)")}`);
  }

  const schedState = await loadSchedulesState();
  console.log("");
  console.log(`${bold("Schedules")} ${dim(`(${schedState.cadence})`)}:`);
  if (schedState.schedules.length === 0) {
    console.log(`  ${dim(`(none — add with: ${cmd("cibus-wolt schedule add")})`)}`);
  } else {
    const now = new Date();
    for (const s of schedState.schedules) {
      const next = s.enabled ? nextFireTime(s, schedState.cadence, now).toLocaleString() : dim("—");
      console.log(`  ${dim(s.id.slice(0, 8))}  ${describeSchedule(s, schedState.cadence)}  ${dim("next=")}${next}`);
    }
  }

  const missed = await readMissed(5);
  if (missed.length > 0) {
    console.log("");
    console.log(bold("Recent missed periods:"));
    for (const m of missed) {
      console.log(`  ${dim(m.ts)}  ${m.scheduleName ?? m.scheduleId.slice(0, 8)}  ${dim(`period=${m.missedPeriodKey}`)}  ${m.reason}`);
    }
  }
}
