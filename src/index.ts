import { logger } from "./logger.ts";
import { runDrainCommand } from "./commands/run.ts";

runDrainCommand().catch((e) => {
  logger.error({ err: e?.message ?? String(e) }, "Fatal");
  process.exit(1);
});
