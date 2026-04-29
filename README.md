# cibus-wolt

Drain your weekly Cibus balance into a Wolt gift card before it expires.

Cibus (Pluxee) gives Israeli tech employees a weekly meal benefit that vanishes if you don't spend it. Wolt accepts Cibus as payment, and Wolt gift cards are valid for 5 years. So this tool turns "didn't eat enough at restaurants this week" into "Wolt credit I can use whenever."

> Personal use, at your own risk. Cibus and Wolt's terms probably don't allow automation.

## Quick start

```sh
git clone <this repo>
cd cibus
npm install
npx playwright install chromium
npx cibus-wolt setup       # interactive, ~5 minutes
npx cibus-wolt run         # actually drain (Chrome opens so you can watch)
```

That's it. The wizard walks you through everything below.

## What `setup` asks you

The wizard runs once and asks, in order:

1. **Cibus + Wolt credentials** — username, password, company.
2. **OTP delivery** — how the 6-digit Cibus SMS code reaches the tool. Pick one (see next section).
3. **Wolt login** — opens Chrome once, you sign in manually. Done forever; the cookie auto-refreshes on every drain.
4. **Schedules** — optional. Add a recurring drain (e.g. every Friday morning).
5. **Smoke test** — runs `status` and an optional dry-run drain.
6. **Claude integration** — optional. Adds the tool to Claude Code, Claude Desktop, and/or Claude.ai mobile so you can drive drains from a chat.

You can skip any of 4–6. Re-run `setup` anytime — it remembers your previous answers.

## OTP delivery — pick one

When Cibus forces a re-auth (occasionally, especially the first time), it texts a 6-digit code to your phone. The tool needs that code on the laptop. Two ways to get it there:


| Option       | What you do                                                                    | Best for                                                               |
| ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Gmail**    | iOS Shortcut forwards the SMS to your Gmail; the tool polls Gmail and reads it | Unattended runs (e.g. scheduled). One-time Gmail App Password (~30s).  |
| **Webhook**  | iOS Shortcut POSTs the SMS to the tool via ngrok or devtunnel                  | Triggering drains from your phone too. One-time tunnel + ngrok signup. |


The wizard asks which one and walks you through the chosen path's setup. Both options need an iOS Shortcut — see [iOS Shortcut setup](#ios-shortcut-setup) below.

If neither is configured (or both fail), the drain falls back to a terminal prompt for the 6 digits — only useful when you're at the laptop.

## Claude integration (optional)

If you'd rather drive drains from a Claude chat ("drain my balance", "what's my cibus balance?"), the wizard installs an MCP server into your Claude clients. All three are independent — pick whichever you actually use:

- **Claude Code** (CLI) — registered via `claude mcp add`. Available in any Claude Code session.
- **Claude Desktop** — added to `claude_desktop_config.json`. After Desktop restarts, Claude can call the tool.
- **Claude.ai mobile / web** ("phone access") — needs a tunnel (ngrok or devtunnel). The wizard prints a paste-ready URL for [claude.ai/customize/connectors](https://claude.ai/customize/connectors). Custom Connectors registered there also sync to Claude Desktop via your account.

If you set up the Gmail App Password in the OTP delivery step, the tool's Gmail poller handles OTPs in the background and Claude doesn't need its own Gmail integration. Otherwise Claude will ask you to type the OTP in chat each time Cibus re-auths (or you can enable Claude Desktop's built-in Gmail connector for unattended reads).

## Daily use

```sh
cibus-wolt run                # full drain
cibus-wolt run --dry-run      # everything except the final payment confirm
cibus-wolt run --amount 50    # spend exactly 50 ₪ (must be ≤ available)
cibus-wolt balance            # just print the current Cibus balance
cibus-wolt status             # auth + last-run state
cibus-wolt schedule add       # add a recurring drain
```

When Wolt's session eventually expires (12+ months without a drain, or a Wolt-side rotation), run `cibus-wolt wolt-login` to re-sign in.

## iOS Shortcut setup

Both **Gmail** and **Webhook** OTP options need a Shortcut that forwards Cibus SMS messages. Same trigger, different action.

**Trigger** (both flavors):

1. iOS Shortcuts app → **Automation** tab → **+** → **Message**
2. Filter: **Sender** is your Cibus SMS sender (+972 1-700-701-130), **Message** contains `קוד האימות`
3. Turn off "Run After Confirmation" so it fires silently

**Action — Gmail option:**

- **Send Email** to your own Gmail. Subject: `cibus-otp`. Body: `<Message>` (the magic variable for the SMS text).

https://github.com/user-attachments/assets/2101f9d0-8767-42cb-a30d-7169dcec7544

**Action — Webhook option:**

- **Get Contents of URL**, method POST. URL: from `cibus-wolt webhook-url`. Headers: `Content-Type: application/json`. Body: `{"code": <Message>}`.

The tool extracts the 6-digit code from the raw SMS text — you don't need to parse it yourself.

Android: Tasker's HTTP Request task does the same thing for the webhook option.

## Troubleshooting

- **Cibus asks for OTP every time** — the "זכור" (remember) checkbox wasn't ticked. The tool ticks it automatically; if it's still happening, check `~/.cibus-wolt/screenshots/<latest>/` and file an issue.
- **Wolt says "no Wolt session cookie"** — run `cibus-wolt wolt-login` and sign in again.
- **OTP doesn't arrive** — check your iOS Shortcut is enabled and "Run After Confirmation" is off. Verify the Shortcut sends to the right Gmail address / webhook URL (`cibus-wolt webhook-url` prints the current one).
- **Selectors broken** — Wolt or Cibus redesigned their UI. Check `~/.cibus-wolt/screenshots/<latest>/` to see where, then update the selector in `src/wolt.ts` or `src/cibus.ts`.

## Safety

- Credentials live in `~/.cibus-wolt/.env` (mode 0600). Not logged, not shipped.
- Webhook endpoints are protected by a 256-bit token in the URL path. Anyone with the full URL can trigger drains, but funds always go to **your own** Wolt account — no attacker-usable payout. Rotate anytime with `cibus-wolt rotate-token`.
- `MIN_AMOUNT` (default 10 ₪) and `MAX_SPEND` (default 1200 ₪) bound what a single run can spend.
- `--dry-run` runs the full flow except the final Cibus payment confirm.

---

## Appendix

### State directory layout

Everything lives under `~/.cibus-wolt/`:


| Path                    | What                                        |
| ----------------------- | ------------------------------------------- |
| `.env`                  | Credentials (0600)                          |
| `chrome-profile/`       | Wolt session cookies                        |
| `chrome-profile-cibus/` | Cibus portal session cookies                |
| `webhook-token`         | Random secret for the webhook URL path      |
| `tunnel-hostname`       | Stable public hostname (ngrok or devtunnel) |
| `tunnel-kind`           | `ngrok` or `devtunnel`                      |
| `runs.jsonl`            | Append-only run log                         |
| `logs/`, `screenshots/` | Debug output                                |


### Full CLI reference

```
cibus-wolt setup                  Main wizard. Re-runnable; remembers values.
cibus-wolt run [--dry-run] [--amount N]
                                  Drain. --amount N spends exactly N ₪ (≤ available).
cibus-wolt balance                Print the current Cibus balance
cibus-wolt status                 Auth + last-run state
cibus-wolt logs                   Print the latest log
cibus-wolt webhook-url            Print current webhook + MCP URLs
cibus-wolt rotate-token           Rotate the webhook token
cibus-wolt wolt-login             Re-sign in to Wolt manually
cibus-wolt reset <scope>          Wipe state. Scope: all|gmail|cibus|wolt|webhook|logs
cibus-wolt schedule <sub>         Manage schedules: list|add|edit|remove|enable|disable|cadence

# Re-add a single piece without re-walking the whole wizard:
cibus-wolt claude-code-mcp        Install MCP into Claude Code only
cibus-wolt claude-desktop-mcp     Install MCP into Claude Desktop only
cibus-wolt phone-setup            Set up phone access (tunnel + Custom Connector)
cibus-wolt stable-tunnel          Set up ngrok static domain only
cibus-wolt devtunnel-setup        Set up Azure Dev Tunnels only

cibus-wolt help                   Show all commands
```

### How the Wolt session stays alive

After `cibus-wolt wolt-login`, Wolt sets two cookies (`__wtoken`, `__wrtoken`) valid ~1 year. Each drain does a quick authenticated `/me` hit before doing anything, which triggers Wolt's sliding-window refresh — both cookies get re-issued with a fresh ~1-year expiry.

So if you drain weekly or monthly, the session never realistically expires. Skip the tool for 12+ months (or Wolt forces a rotation) and you'll see "no Wolt session cookie" — run `cibus-wolt wolt-login` to re-authenticate.

### How OTP delivery composes

The tool has a single internal "input bus" for OTPs. Multiple delivery options can be active simultaneously — first to respond wins. Examples:

- Gmail App Password + terminal prompt: tool polls Gmail via IMAP; if you happen to be at the laptop, you can also just type the code.
- Webhook + Claude Desktop's Gmail connector: phone-side Shortcut posts to webhook; Claude reads Gmail. Whichever lands first.

You don't pick "instead of" — the wizard's question is just about which paths to actually configure.

### ngrok vs devtunnel

ngrok is the default. Free static domain on `*.ngrok-free.app`, no credit card.

Use `cibus-wolt devtunnel-setup` (Microsoft Azure Dev Tunnels) if ngrok is blocked on your network — common on Microsoft corporate Wi-Fi. Sign in with a **personal** MS account; work tenants often block `--allow-anonymous`.

Stable URL across reboots, same `/webhook/<token>/...` and `/mcp/<token>` endpoints — only the hostname differs.

### Known gaps

- Scheduled drains only fire while background services are running. Install via `npm run install-bg`.
- Not on npm — clone + `npm install` for now.
- Supported OSes: macOS (launchd) and Windows 10+/11 (Task Scheduler) for both the CLI and the auto-start background services. Linux works for the CLI but auto-start isn't wired up — run `npm run mcp` under your own systemd unit if you need it.

### License

MIT. Personal use. At your own risk with respect to Pluxee / Wolt terms of service.