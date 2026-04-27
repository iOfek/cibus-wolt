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

function showHelp(): void {
  console.log(
    [
      "cibus-wolt — drain leftover Cibus balance into a Wolt gift card on your own account.",
      "",
      "Usage: cibus-wolt <command> [args...]",
      "",
      "Commands:",
      "  run [--dry-run] [--amount N]",
      "                     Run a drain. --amount N spends exactly N ₪ (must be ≤ available).",
      "  balance            Fetch current Cibus weekly balance.",
      "  status             Auth + session state for each phase.",
      "  reset <scope>      Delete cached state. Scope: all | gmail | cibus | wolt | webhook | logs.",
      "  logs               Print the latest log file.",
      "  webhook-url        Print the current webhook URL (tunnel + token).",
      "  rotate-token       Regenerate the webhook token.",
      "  stable-tunnel      Set up ngrok with a free static domain (stable URL).",
      "  devtunnel-setup    Set up Azure Dev Tunnels (Microsoft) — alternative when ngrok is blocked.",
      "  setup              Interactive first-time setup wizard. Re-run to edit values.",
      "  wolt-login         Open Chrome to log in to Wolt manually (session expired).",
      "  claude-code-mcp    Install cibus-wolt MCP into Claude Code (~/.claude.json). Requires `cibus-wolt setup` first.",
      "  claude-desktop-mcp Install cibus-wolt MCP into Claude Desktop (claude_desktop_config.json). Requires `cibus-wolt setup` first.",
      "  phone-setup        Set up phone access (Custom Connector via tunnel). Requires Claude Code or Desktop installed.",
      "  schedule <sub>     Manage recurring drain schedules (list|add|edit|remove|enable|disable|cadence).",
      "  help               Show this help.",
      "",
      "State lives at ~/.cibus-wolt/. Configure creds via .env in that directory or the project root.",
    ].join("\n"),
  );
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
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.message ?? String(e));
  process.exit(1);
});
