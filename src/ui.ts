/* eslint-disable no-console */
/**
 * Tiny terminal-styling helpers for the interactive wizards.
 *
 * No dependency on chalk/kleur — we only need a handful of SGR codes and the
 * extra weight isn't worth it. TTY-aware (auto-disables colors when piped) and
 * honors NO_COLOR (https://no-color.org).
 *
 * Vocabulary (used consistently across all wizards):
 *   ✓ green   — done / success
 *   ✗ red     — failed / can't continue
 *   ⚠ yellow  — warning / heads-up
 *   → cyan    — info / pointer
 *   • cyan    — bullet inside a list
 *   bold      — values, defaults, important nouns
 *   dim       — hints / commentary / "(empty)" placeholders
 */
import { stdout } from "node:process";

const isTTY = stdout.isTTY === true;
const noColor = typeof process.env.NO_COLOR === "string" && process.env.NO_COLOR !== "";
export const colorEnabled = isTTY && !noColor;

function sgr(open: string, close: string): (s: string) => string {
  return (s: string) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const underline = sgr("4", "24");
export const cyan = sgr("36", "39");
export const green = sgr("32", "39");
export const red = sgr("31", "39");
export const yellow = sgr("33", "39");
export const magenta = sgr("35", "39");
export const gray = sgr("90", "39");

const RULE_WIDTH = 70;
const CHAR_LIGHT = "─";
const CHAR_HEAVY = "━";

export function rule(width = RULE_WIDTH, heavy = false): string {
  return (heavy ? CHAR_HEAVY : CHAR_LIGHT).repeat(width);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string after stripping SGR escapes (counts code points). */
export function visibleLength(s: string): number {
  return [...s.replace(ANSI_RE, "")].length;
}

/**
 * Right-pad `s` so its *visible* width is `n`. Use this for column layouts
 * where cells contain colored text: plain `.padEnd(n)` would over-count
 * because each ANSI escape counts as ~5–10 characters with zero visible width.
 */
export function padVisible(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visibleLength(s)));
}

export interface SectionOpts {
  step?: { n: number; total: number };
  subtitle?: string;
}

/**
 * Top-level wizard banner. Used for numbered wizard steps.
 *
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *     STEP 3/9 · Cibus OTP delivery
 *     Cibus forces a re-auth occasionally — a 6-digit code SMS'd to your phone.
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */
export function section(title: string, opts: SectionOpts = {}): void {
  console.log("");
  console.log(cyan(rule(RULE_WIDTH, true)));
  const stepLabel = opts.step ? `${bold(cyan(`STEP ${opts.step.n}/${opts.step.total}`))} ${dim("·")} ` : "";
  console.log(`  ${stepLabel}${bold(title)}`);
  if (opts.subtitle) console.log(`  ${dim(opts.subtitle)}`);
  console.log(cyan(rule(RULE_WIDTH, true)));
}

/**
 * Sub-section header — used inside a wizard step (e.g. "Gmail OAuth" inside
 * the "Cibus OTP delivery" step). No heavy frame; just a labelled hr.
 */
export function subsection(title: string, subtitle?: string): void {
  console.log("");
  console.log(`  ${bold(cyan("──"))} ${bold(title)} ${cyan(rule(Math.max(2, RULE_WIDTH - 6 - title.length), false))}`);
  if (subtitle) console.log(`  ${dim(subtitle)}`);
}

export function blank(): void {
  console.log("");
}

export function success(msg: string): void {
  console.log(`  ${green("✓")} ${msg}`);
}

export function failure(msg: string): void {
  console.log(`  ${red("✗")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow("⚠")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${cyan("→")} ${msg}`);
}

/** Hints / commentary / asides — visually backgrounded so the eye skips them. */
export function note(msg: string): void {
  console.log(`  ${dim(msg)}`);
}

/** Plain body text — same indent as success/warn/note. */
export function plain(msg: string): void {
  console.log(`  ${msg}`);
}

/** Bulleted item, deeper indent than plain/note. */
export function bullet(msg: string): void {
  console.log(`    ${cyan("•")} ${msg}`);
}

/** Numbered step inside a list (sub-steps in a how-to). */
export function numbered(n: number, msg: string): void {
  console.log(`    ${bold(cyan(`${n}.`))} ${msg}`);
}

/** "label: value" pair where the value is what the eye should land on. */
export function kv(label: string, value: string): void {
  console.log(`    ${dim(label.padEnd(12, " "))} ${bold(value)}`);
}

/** Highlight a command the user should run — bold + cyan. */
export function cmd(s: string): string {
  return bold(cyan(s));
}

/** Highlight an important noun/path — bold. */
export function val(s: string): string {
  return bold(s);
}

/** Highlight a critical heads-up — bold yellow. */
export function emphasis(s: string): string {
  return bold(yellow(s));
}

/**
 * OSC 8 hyperlink — clickable in modern terminals (iTerm2, Terminal.app, VS Code,
 * Windows Terminal). In terminals without support, the visible text falls back
 * gracefully (the escape sequences are stripped or ignored). Default visible
 * text is the URL itself, so users without OSC 8 still see something selectable.
 */
export function link(url: string, text: string = url): string {
  if (!colorEnabled) return text;
  return `\x1b]8;;${url}\x07${cyan(underline(text))}\x1b]8;;\x07`;
}

/**
 * Suffix for `ask()` prompts: shows the default value bolded so a user blindly
 * pressing Enter sees exactly what they're agreeing to. `undefined` → no suffix
 * (the prompt has no default); empty string → "(empty)" hint.
 */
export function defaultSuffix(value: string | undefined): string {
  if (value === undefined) return "";
  const display = value === "" ? dim("(empty)") : bold(value);
  return ` [${display}]`;
}

/**
 * Suffix for `askYesNo()`: capital letter is bold + green so the default jumps
 * out — the "press Enter without looking" win.
 */
export function yesNoSuffix(defaultYes: boolean): string {
  return defaultYes
    ? ` (${bold(green("Y"))}${dim("/n")})`
    : ` (${dim("y/")}${bold(green("N"))})`;
}

/**
 * Suffix for `askChoice()`: the default option is wrapped in [brackets] and
 * bold/cyan; non-defaults are dim. Mirrors yesNoSuffix() — same blind-Enter
 * principle.
 */
export function choiceSuffix(options: string[], defaultOption: string): string {
  const parts = options.map((o) => (o === defaultOption ? bold(cyan(`[${o}]`)) : dim(o)));
  return ` (${parts.join(dim(" / "))})`;
}

/** Styled inner-prompt for soft terminal pauses; pair with askRaw(). */
export function pressEnter(msg: string): string {
  return `${dim("›")} ${msg}`;
}

/** Final celebratory marker — bigger, bolder ✓. */
export function done(msg: string): void {
  console.log(`  ${bold(green("✓"))} ${bold(msg)}`);
}
