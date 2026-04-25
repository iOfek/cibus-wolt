/* eslint-disable no-console */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDir } from "../paths.ts";
import {
  type Cadence,
  type Schedule,
  DOW_NAMES,
  DOW_SHORT,
  describeSchedule,
  findSchedule,
  loadSchedulesState,
  newSchedule,
  saveSchedulesState,
  validateScheduleInput,
  type ScheduleInput,
} from "../schedules.ts";
import { nextFireTime, readMissed } from "../scheduler.ts";

async function ask(prompt: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = def !== undefined ? ` [${def || "(empty)"}]` : "";
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    if (answer === "") return def ?? "";
    return answer;
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  const def = defaultYes ? "Y/n" : "y/N";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = (await ask(`${prompt} (${def})`)).toLowerCase();
    if (ans === "") return defaultYes;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    console.log(`  Please answer y or n (got: "${ans}").`);
  }
}

function formatNextFire(s: Schedule, cadence: Cadence): string {
  if (!s.enabled) return "(disabled)";
  const t = nextFireTime(s, cadence, new Date());
  return t.toLocaleString();
}

function printList(state: { cadence: Cadence; schedules: Schedule[] }): void {
  console.log(`Cadence: ${state.cadence}`);
  if (state.schedules.length === 0) {
    console.log("  (no schedules — add one with: cibus-wolt schedule add)");
    return;
  }
  const rows = state.schedules.map((s, i) => ({
    n: String(i + 1),
    id: s.id.slice(0, 8),
    desc: describeSchedule(s, state.cadence),
    next: formatNextFire(s, state.cadence),
    lastOk: s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : "—",
  }));
  const w = {
    n: Math.max(1, ...rows.map((r) => r.n.length)),
    id: 8,
    desc: Math.max(10, ...rows.map((r) => r.desc.length)),
    next: Math.max(10, ...rows.map((r) => r.next.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  console.log(`${pad("#", w.n)}  ${pad("id", w.id)}  ${pad("when + amount", w.desc)}  ${pad("next fire", w.next)}  last success`);
  console.log("-".repeat(w.n + w.id + w.desc + w.next + 22));
  for (const r of rows) {
    console.log(`${pad(r.n, w.n)}  ${pad(r.id, w.id)}  ${pad(r.desc, w.desc)}  ${pad(r.next, w.next)}  ${r.lastOk}`);
  }
}

async function promptCadence(current: Cadence): Promise<Cadence> {
  console.log("  Cibus balance reset cadence: (w)eekly / (m)onthly / (d)aily");
  const ans = (await ask("  Choose", current[0] ?? "w")).toLowerCase();
  if (ans.startsWith("m")) return "monthly";
  if (ans.startsWith("d")) return "daily";
  return "weekly";
}

async function promptInput(cadence: Cadence, existing?: Schedule): Promise<ScheduleInput | null> {
  console.log("");
  if (cadence === "weekly") {
    console.log("  Day of week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat");
    const dowStr = await ask("  Day (0-6)", existing?.dayOfWeek !== undefined ? String(existing.dayOfWeek) : "6");
    const dayOfWeek = Number(dowStr);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      console.log(`  ✗ Invalid day: ${dowStr}`);
      return null;
    }
    const time = await ask("  Time (HH:MM, 24h)", existing?.time ?? "20:00");
    const amountStr = await ask("  Amount ₪ (blank = full drain)", existing?.amount !== undefined ? String(existing.amount) : "");
    const name = await ask("  Name (optional label)", existing?.name ?? `${DOW_SHORT[dayOfWeek]} ${time}`);
    const input: ScheduleInput = { dayOfWeek, time, name };
    if (amountStr !== "") input.amount = Number(amountStr);
    return input;
  }
  if (cadence === "monthly") {
    const domStr = await ask("  Day of month (1-31, or -1 for last day)", existing?.dayOfMonth !== undefined ? String(existing.dayOfMonth) : "28");
    const dayOfMonth = Number(domStr);
    const time = await ask("  Time (HH:MM, 24h)", existing?.time ?? "20:00");
    const amountStr = await ask("  Amount ₪ (blank = full drain)", existing?.amount !== undefined ? String(existing.amount) : "");
    const name = await ask("  Name (optional label)", existing?.name ?? `day ${dayOfMonth} ${time}`);
    const input: ScheduleInput = { dayOfMonth, time, name };
    if (amountStr !== "") input.amount = Number(amountStr);
    return input;
  }
  const time = await ask("  Time (HH:MM, 24h)", existing?.time ?? "20:00");
  const amountStr = await ask("  Amount ₪ (blank = full drain)", existing?.amount !== undefined ? String(existing.amount) : "");
  const name = await ask("  Name (optional label)", existing?.name ?? `daily ${time}`);
  const input: ScheduleInput = { time, name };
  if (amountStr !== "") input.amount = Number(amountStr);
  return input;
}

// ────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ────────────────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const state = await loadSchedulesState();
  printList(state);
  const missed = await readMissed(5);
  if (missed.length > 0) {
    console.log("");
    console.log("Recent missed periods:");
    for (const m of missed) {
      console.log(`  ${m.ts}  ${m.scheduleName ?? m.scheduleId.slice(0, 8)}  period=${m.missedPeriodKey}  ${m.reason}`);
    }
  }
}

async function cmdAdd(): Promise<void> {
  const state = await loadSchedulesState();
  const input = await promptInput(state.cadence);
  if (!input) return;
  const err = validateScheduleInput(state.cadence, input);
  if (err) {
    console.log(`  ✗ ${err}`);
    return;
  }
  const s = newSchedule(input);
  state.schedules.push(s);
  await saveSchedulesState(state);
  console.log(`  ✓ Added: ${describeSchedule(s, state.cadence)}  (id: ${s.id.slice(0, 8)})`);
}

async function cmdRemove(target: string | undefined): Promise<void> {
  if (!target) {
    console.log("Usage: cibus-wolt schedule remove <id-or-number>");
    return;
  }
  const state = await loadSchedulesState();
  const s = findSchedule(state, target);
  if (!s) {
    console.log(`  ✗ No schedule matching "${target}"`);
    return;
  }
  state.schedules = state.schedules.filter((x) => x.id !== s.id);
  await saveSchedulesState(state);
  console.log(`  ✓ Removed: ${describeSchedule(s, state.cadence)}`);
}

async function cmdEnable(target: string | undefined, enabled: boolean): Promise<void> {
  if (!target) {
    console.log(`Usage: cibus-wolt schedule ${enabled ? "enable" : "disable"} <id-or-number>`);
    return;
  }
  const state = await loadSchedulesState();
  const s = findSchedule(state, target);
  if (!s) {
    console.log(`  ✗ No schedule matching "${target}"`);
    return;
  }
  s.enabled = enabled;
  await saveSchedulesState(state);
  console.log(`  ✓ ${enabled ? "Enabled" : "Disabled"}: ${describeSchedule(s, state.cadence)}`);
}

async function cmdEdit(target: string | undefined): Promise<void> {
  if (!target) {
    console.log("Usage: cibus-wolt schedule edit <id-or-number>");
    return;
  }
  const state = await loadSchedulesState();
  const s = findSchedule(state, target);
  if (!s) {
    console.log(`  ✗ No schedule matching "${target}"`);
    return;
  }
  const input = await promptInput(state.cadence, s);
  if (!input) return;
  const err = validateScheduleInput(state.cadence, input);
  if (err) {
    console.log(`  ✗ ${err}`);
    return;
  }
  s.name = input.name;
  s.dayOfWeek = input.dayOfWeek;
  s.dayOfMonth = input.dayOfMonth;
  s.time = input.time;
  s.amount = input.amount;
  await saveSchedulesState(state);
  console.log(`  ✓ Updated: ${describeSchedule(s, state.cadence)}`);
}

async function cmdCadence(target: string | undefined): Promise<void> {
  const state = await loadSchedulesState();
  let next: Cadence;
  if (target === "weekly" || target === "monthly" || target === "daily") next = target;
  else {
    next = await promptCadence(state.cadence);
  }
  state.cadence = next;
  await saveSchedulesState(state);
  console.log(`  ✓ Cadence set to ${next}`);
  console.log("  Note: existing day-of-week / day-of-month values may need editing for the new cadence.");
}

function showHelp(): void {
  console.log(
    [
      "Usage: cibus-wolt schedule <subcommand>",
      "",
      "  list                       List all schedules with next-fire times.",
      "  add                        Add a new schedule (interactive).",
      "  edit <id|#>                Edit an existing schedule.",
      "  remove <id|#>              Delete a schedule.",
      "  enable <id|#>              Enable a schedule.",
      "  disable <id|#>             Disable a schedule.",
      "  cadence [weekly|monthly|daily]  Get or set the Cibus reset cadence.",
      "",
      "State: ~/.cibus-wolt/schedules.json",
      "Schedules only fire while the background MCP service is running (install via: npm run install-bg).",
    ].join("\n"),
  );
}

export async function runScheduleCommand(args: string[]): Promise<void> {
  await ensureStateDir();
  const sub = args[0] ?? "list";
  const target = args[1];
  switch (sub) {
    case "list":
    case "ls":
      await cmdList();
      return;
    case "add":
      await cmdAdd();
      return;
    case "remove":
    case "rm":
    case "delete":
      await cmdRemove(target);
      return;
    case "enable":
      await cmdEnable(target, true);
      return;
    case "disable":
      await cmdEnable(target, false);
      return;
    case "edit":
      await cmdEdit(target);
      return;
    case "cadence":
      await cmdCadence(target);
      return;
    case "help":
    case "-h":
    case "--help":
      showHelp();
      return;
    default:
      console.log(`Unknown subcommand: ${sub}`);
      showHelp();
      return;
  }
}

/**
 * Exposed for the setup wizard to bulk-create suggested schedules.
 * Also handles initial cadence selection.
 */
export async function runScheduleSetupStep(): Promise<void> {
  const state = await loadSchedulesState();
  console.log("");
  console.log("  How often does your Cibus balance reset?");
  console.log("    weekly (default — most Israeli companies: Pluxee resets Sunday 00:00)");
  console.log("    monthly");
  console.log("    daily");
  state.cadence = await promptCadence(state.cadence);
  await saveSchedulesState(state);
  console.log(`  ✓ Cadence: ${state.cadence}`);

  if (state.schedules.length > 0) {
    console.log("");
    console.log("  Existing schedules:");
    printList(state);
    const edit = await askYesNo("  Add another schedule?", false);
    if (!edit) return;
  }

  // Offer suggestion based on cadence
  const suggestion = suggestedSchedule(state.cadence);
  console.log("");
  console.log(`  Suggested: ${describeSchedule(suggestion, state.cadence)}`);
  const accept = await askYesNo("  Create this schedule?", true);
  if (accept) {
    state.schedules.push(suggestion);
    await saveSchedulesState(state);
    console.log(`  ✓ Added (id: ${suggestion.id.slice(0, 8)})`);
  }

  while (await askYesNo("  Add another schedule?", false)) {
    const input = await promptInput(state.cadence);
    if (!input) break;
    const err = validateScheduleInput(state.cadence, input);
    if (err) {
      console.log(`  ✗ ${err}`);
      continue;
    }
    const s = newSchedule(input);
    state.schedules.push(s);
    await saveSchedulesState(state);
    console.log(`  ✓ Added: ${describeSchedule(s, state.cadence)}`);
  }

  console.log("");
  await ensureBackgroundServicesInstalled();
}

async function ensureBackgroundServicesInstalled(): Promise<void> {
  const { bothServicesInstalled } = await import("../services.ts");
  if (bothServicesInstalled()) {
    console.log("  ✓ Background services already running — schedules will fire as configured.");
    return;
  }
  console.log("  Schedules only fire while the background MCP service is running.");
  const install = await askYesNo("  Install background services now? (auto-start on login)", true);
  if (!install) {
    console.log("  Skipped. Install later with: npm run install-bg");
    return;
  }
  try {
    const { execSync } = await import("node:child_process");
    execSync("npm run install-bg", { stdio: "inherit" });
  } catch {
    console.log("  install-bg failed. Retry later: npm run install-bg");
  }
}

function suggestedSchedule(cadence: Cadence): Schedule {
  // Weekly: Saturday 20:00 — latest safe slot before Sunday 00:00 Cibus reset.
  // Monthly: day 28 at 20:00 — safe for every month.
  // Daily: 20:00 — evening, after most meal spending.
  if (cadence === "weekly") return newSchedule({ dayOfWeek: 6, time: "20:00", name: `${DOW_SHORT[6]} 20:00 (pre-reset)` });
  if (cadence === "monthly") return newSchedule({ dayOfMonth: 28, time: "20:00", name: "day 28 20:00" });
  return newSchedule({ time: "20:00", name: "daily 20:00" });
}

export const _dowNames = DOW_NAMES;
