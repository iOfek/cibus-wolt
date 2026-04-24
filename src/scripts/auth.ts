import { google } from "googleapis";
import { config } from "../config.ts";
import { getAuthClient } from "../gmail.ts";
import { logger } from "../logger.ts";

async function main() {
  const auth = await getAuthClient(config.google.clientId, config.google.clientSecret);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  logger.info({ email: profile.data.emailAddress, messagesTotal: profile.data.messagesTotal }, "Gmail OAuth OK");
}

main().catch((e) => {
  logger.error({ err: e.message }, "Auth smoke failed");
  process.exit(1);
});
