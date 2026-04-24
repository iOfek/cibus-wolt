import fs from "node:fs/promises";
import { paths } from "./paths.ts";

export interface RunRecord {
  ts: string;
  amount: number;
  status: "success" | "dry-run" | "skipped" | "failed";
  reason?: string;
  url?: string;
}

export async function appendRun(record: RunRecord): Promise<void> {
  await fs.appendFile(paths.runs, JSON.stringify(record) + "\n");
}
