#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * cibus-wolt CLI entry point.
 *
 * Commands:
 *   cibus-wolt run [--dry-run]           Run a drain
 *   cibus-wolt balance                   Print the current Cibus balance
 *   cibus-wolt status                    Show auth/session state
 *   cibus-wolt reset <scope>             Delete cached state (all|gmail|cibus|wolt|webhook|logs)
 *   cibus-wolt logs                      Print the latest log file
 *   cibus-wolt setup                     Interactive first-time setup wizard (coming soon)
 *   cibus-wolt help                      Show this help
 */

function parseAmountFlag(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--amount" && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n)) throw new Error(`--amount requires a number, got: ${args[i + 1]}`);
      return n;
    }
    if (a.startsWith("--amount=")) {
      const n = Number(a.slice("--amount=".length));
      if (!Number.isFinite(n)) throw new Error(`--amount requires a number, got: ${a}`);
      return n;
    }
  }
  return undefined;
}

async function showHelp(): Promise<void> {
  const { bold, cyan, dim, blank, note, val } = await import("../ui.ts");
  const row = (label: string, desc: string): string =>
    `  ${bold(label.padEnd(22, " "))} ${dim(desc)}`;
  const heading = (s: string): string => bold(cyan(s));

  console.log(`${bold(cyan("cibus-wolt"))} ${dim("— drain leftover Cibus balance into a Wolt gift card on your own account.")}`);
  blank();
  console.log(`${bold("Usage:")} cibus-wolt ${dim("<command> [args...]")}`);
  blank();
  console.log(heading("First-time setup"));
  console.log(row("setup", "Interactive setup wizard. Re-run to edit values."));
  console.log(row("wolt-login", "Open Chrome to log in to Wolt manually (session expired)."));
  blank();
  console.log(heading("Run drains"));
  console.log(row("run [--dry-run] [--amount N]", "Drain. --amount N spends exactly N ₪ (≤ available)."));
  console.log(row("balance", "Fetch current Cibus weekly balance."));
  console.log(row("status", "Auth + session state for each phase."));
  console.log(row("logs", "Print the latest log file."));
  console.log(row("reset <scope>", "Delete cached state. Scope: all | gmail | cibus | wolt | webhook | logs."));
  blank();
  console.log(heading("Schedules"));
  console.log(row("schedule <sub>", "list | add | edit | remove | enable | disable | cadence"));
  blank();
  console.log(heading("Tunnel + phone"));
  console.log(row("stable-tunnel", "Set up ngrok with a free static domain (stable URL)."));
  console.log(row("devtunnel-setup", "Set up Azure Dev Tunnels — alternative when ngrok is blocked."));
  console.log(row("webhook-url", "Print the current webhook URL (tunnel + token)."));
  console.log(row("rotate-token", "Regenerate the webhook token."));
  console.log(row("phone-setup", "Custom Connector via tunnel for Claude.ai (mobile/web)."));
  blank();
  console.log(heading("Claude clients"));
  console.log(row("claude-code-mcp", "Install MCP into Claude Code (~/.claude.json)."));
  console.log(row("claude-desktop-mcp", "Install MCP into Claude Desktop."));
  blank();
  console.log(row("help", "Show this help."));
  blank();
  note(`State lives at ${val("~/.cibus-wolt/")}. Configure creds via .env in that directory or the project root.`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const args = process.argv.slice(3);

  switch (cmd) {
    case "run": {
      const { runDrainCommand } = await import("../commands/run.ts");
      const dryRun = args.includes("--dry-run");
      const amount = parseAmountFlag(args);
      await runDrainCommand({ dryRun, amount });
      break;
    }
    case "balance": {
      const { runBalanceCommand } = await import("../commands/balance.ts");
      await runBalanceCommand();
      break;
    }
    case "status": {
      const { runStatusCommand } = await import("../commands/status.ts");
      await runStatusCommand();
      break;
    }
    case "reset": {
      const { runResetCommand } = await import("../commands/reset.ts");
      await runResetCommand(args);
      break;
    }
    case "logs": {
      const { runLogsCommand } = await import("../commands/logs.ts");
      await runLogsCommand();
      break;
    }
    case "webhook-url": {
      const { runWebhookUrlCommand } = await import("../commands/webhook-url.ts");
      await runWebhookUrlCommand();
      break;
    }
    case "rotate-token": {
      const { runRotateTokenCommand } = await import("../commands/rotate-token.ts");
      await runRotateTokenCommand();
      break;
    }
    case "stable-tunnel": {
      const { runNgrokSetupCommand } = await import("../commands/ngrok-setup.ts");
      await runNgrokSetupCommand();
      break;
    }
    case "devtunnel-setup": {
      const { runDevtunnelSetupCommand } = await import("../commands/devtunnel-setup.ts");
      await runDevtunnelSetupCommand();
      break;
    }
    case "setup": {
      const { runSetupCommand } = await import("../commands/setup.ts");
      await runSetupCommand();
      break;
    }
    case "wolt-login": {
      const { runWoltLoginCommand } = await import("../commands/wolt-login.ts");
      await runWoltLoginCommand();
      break;
    }
    case "claude-code-mcp": {
      const { runClaudeCodeMcpCommand } = await import("../commands/setup.ts");
      await runClaudeCodeMcpCommand();
      break;
    }
    case "claude-desktop-mcp": {
      const { runClaudeDesktopMcpCommand } = await import("../commands/setup.ts");
      await runClaudeDesktopMcpCommand();
      break;
    }
    case "phone-setup": {
      const { runPhoneSetupCommand } = await import("../commands/setup.ts");
      await runPhoneSetupCommand();
      break;
    }
    case "schedule": {
      const { runScheduleCommand } = await import("../commands/schedule.ts");
      await runScheduleCommand(args);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      await showHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      await showHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.message ?? String(e));
  process.exit(1);
});
