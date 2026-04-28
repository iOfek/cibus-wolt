/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../paths.ts";
import { bold, cyan, note } from "../ui.ts";

export async function runLogsCommand(): Promise<void> {
  try {
    const entries = await fs.readdir(paths.logsDir);
    const logs = entries.filter((e) => e.endsWith(".log")).sort().reverse();
    if (logs.length === 0) {
      note("(no logs yet)");
      return;
    }
    const latest = path.join(paths.logsDir, logs[0]!);
    console.log(`${cyan("───")} ${bold(latest)} ${cyan("───")}`);
    const text = await fs.readFile(latest, "utf8");
    console.log(text);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
