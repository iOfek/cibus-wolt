import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../paths.ts";

export async function runLogsCommand(): Promise<void> {
  try {
    const entries = await fs.readdir(paths.logsDir);
    const logs = entries.filter((e) => e.endsWith(".log")).sort().reverse();
    if (logs.length === 0) {
      // eslint-disable-next-line no-console
      console.log("(no logs yet)");
      return;
    }
    const latest = path.join(paths.logsDir, logs[0]!);
    // eslint-disable-next-line no-console
    console.log(`--- ${latest} ---`);
    const text = await fs.readFile(latest, "utf8");
    // eslint-disable-next-line no-console
    console.log(text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
