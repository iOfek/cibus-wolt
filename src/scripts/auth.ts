import { config } from "../config.ts";
import { tryLoadGmailCreds, verifyGmailCreds } from "../gmail.ts";
import { logger } from "../logger.ts";

async function main() {
  const creds = tryLoadGmailCreds(config.gmail.user, config.gmail.pass);
  if (!creds) {
    logger.error("GMAIL_USER and/or GMAIL_APP_PASSWORD not set");
    process.exit(1);
  }
  const result = await verifyGmailCreds(creds);
  if (result.ok) {
    logger.info({ email: result.email }, "Gmail IMAP login OK");
  } else {
    logger.error({ err: result.error }, "Gmail IMAP login failed");
    process.exit(1);
  }
}

main().catch((e) => {
  logger.error({ err: e.message }, "Auth smoke failed");
  process.exit(1);
});
