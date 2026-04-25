# cibus-wolt

Drain leftover weekly Cibus balance into a Wolt gift card on your own account before it expires.

Cibus (Pluxee) gives Israeli tech employees a weekly meal benefit that **evaporates if unused**. Wolt already accepts Cibus as payment, and gift cards there are valid 5 years. So the idea is simple: spend down your remaining balance by buying yourself a Wolt gift card every Friday, automatically.

This repo is a personal tool. Cibus and Wolt terms probably prohibit automation — use at your own risk. MIT-licensed, no employer affiliation.

## TL;DR

```sh
git clone <this repo>
cd cibus
npm install
npx playwright install chromium
npx cibus-wolt setup        # interactive wizard
npx cibus-wolt run          # actually drain (opens Chrome so you can watch)
```

The wizard asks what kind of setup you want: just CLI, CLI + phone trigger, or CLI + Claude. Pick one based on the table below, then keep reading the matching section if you want detail.

| You want to…                               | Pick                  | Phone access | Needs Gmail? |
|--------------------------------------------|-----------------------|--------------|--------------|
| Run it from my laptop, that's it           | **CLI-only**          | No           | No           |
| Trigger it from my phone (web/cellular)    | **CLI + webhook**     | Yes          | No           |
| Trigger from Claude app (desktop or web)   | **CLI + Claude**      | Yes          | No (Claude's Gmail integration covers it) |

All three paths compose. You can have all of them on at once.

## How it works

Under the hood, one `cibus-wolt run`:

1. Fetches your weekly Cibus balance via a headful Google Chrome session at `consumers.pluxee.co.il` (dedicated profile at `~/.cibus-wolt/chrome-profile`, session persists across runs).
2. Navigates to `wolt.com/en/gift-card-shop/isr`, picks "Other" with your exact leftover amount, clicks Continue.
3. Pays with Cibus via the in-Wolt Cibus popup (permanent-password mode by default; OTP mode available).
4. Clicks Redeem — credit lands on your Wolt account.

## Why the extra setup options?

The only thing the automation can't get on its own is the **Cibus SMS OTP** — a 6-digit code SMS'd to your phone when Cibus forces re-auth. Arrives on the phone, we need it on the laptop.

(Wolt login is one-time manual: `cibus-wolt wolt-login` opens Chrome to the Wolt login page, you sign in once, the session cookie is saved to the dedicated profile, and every subsequent drain silently refreshes its expiry. No magic-link plumbing — Wolt's bot detection rejected it on fresh profiles anyway.)

Four sources can deliver the Cibus OTP. First to respond wins; multiple can be active at once.

| Source | How it gets the signal | What you need |
|---|---|---|
| **(a) Terminal prompt** | You type the 6 digits when prompted | Nothing. Only works if you're at the laptop during the drain. |
| **(b) Gmail OAuth** | Tool polls your Gmail for a forwarded SMS (subject `cibus-otp`) | Gmail account + one-time GCP project (OAuth client ID) + iOS Shortcut that emails the SMS to your own Gmail. |
| **(c) Phone webhook (ngrok)** | iOS Shortcut extracts the 6 digits and POSTs to our server | ngrok free signup + static domain + iOS Shortcut (2-min one-time each). Works from cellular. |
| **(d) Claude MCP** | You type the 6 digits in chat (Claude calls `submit_otp`), OR an iOS Shortcut forwards SMS to your Gmail and Claude's Gmail integration reads it | Claude. iOS Shortcut only if you want OTPs fully automatic. For claude.ai web, ngrok too. |

**Why this needs forwarding at all**: Cibus OTPs come by SMS. Neither Claude nor our Gmail poller can read SMS directly. Either you type the 6 digits manually when asked, or you set up one iOS Shortcut that forwards the SMS to a place an integration can read (Gmail or our webhook).

**Remote control** (trigger a drain from your phone / away from the laptop) requires **(c)** or **(d)** — both give you a public URL. Local-only is **(a)** or **(b)**.

### Which should you pick?

| Your situation | Recommended |
|---|---|
| Use Claude, OK typing OTP in chat | **(d)**. ~10s in chat when Cibus needs MFA. |
| Use Claude + Gmail, want OTP automated too | **(d)** + iOS Shortcut that forwards Cibus SMS to Gmail (subject `cibus-otp`). |
| Use Claude but no Gmail (privacy / don't use Gmail) | **(c) + (d)**. Claude orchestrates; iOS Shortcut forwards SMS to the ngrok webhook. |
| Have iPhone, don't use Claude, want remote trigger | **(c)**. iOS Shortcut for OTP SMS → webhook. |
| Have Gmail, don't use Claude, OK being at laptop | **(b)** + iOS Shortcut that forwards Cibus SMS to Gmail. |
| Just run drains manually at the laptop | **(a)**. No signups. Type OTP when prompted. |

`npx cibus-wolt setup` asks these questions up front, detects what's already configured, and recommends a path. You can pick a different combination or run the wizard again to add another path later.

State lives at `~/.cibus-wolt/`:

| Path                    | What                                   |
|-------------------------|----------------------------------------|
| `.env`                  | Credentials (0600)                     |
| `chrome-profile/`       | Wolt session cookies                   |
| `chrome-profile-cibus/` | Cibus portal session cookies           |
| `webhook-token`         | Random secret for the webhook URL path |
| `tunnel-hostname`       | Your stable public hostname (ngrok or devtunnel) |
| `tunnel-kind`           | `ngrok` (default) or `devtunnel`       |
| `devtunnel-id`          | Local Azure Dev Tunnel name (devtunnel only) |
| `runs.jsonl`            | Append-only run log                    |
| `logs/`, `screenshots/` | Debug output                           |

## Install walkthroughs

Pick one and follow top-to-bottom. You can always add another path later by running `npx cibus-wolt setup` or `claude-setup` again — prompts show current values so it's safe to re-run.

### I. CLI-only (simplest)

You run drains from your laptop's terminal. Nothing else.

```sh
npx cibus-wolt setup
# → answer Cibus/Wolt creds + Wolt email
# → say NO to webhook, NO to Claude MCP, NO to Gmail
npx cibus-wolt run
```

When Cibus asks for an SMS OTP (first login / rarely after that if "זכור" was ticked), you type the 6-digit code in the terminal. When Wolt's session expires (every few weeks), run `npx cibus-wolt wolt-login` and sign in manually — the new session is reused on every subsequent drain.

**That's the whole install.** No services, no tunnel, no signups.

### II. CLI + phone webhook (ngrok)

You want to trigger drains from your phone and have your iPhone Shortcut deliver the Cibus OTP automatically.

**Setup:**

```sh
npx cibus-wolt setup
# → answer Cibus/Wolt creds + Wolt email
# → YES to phone webhook
# → wizard walks through ngrok install + free static domain (see below)
```

The ngrok step:
1. Installs ngrok if needed — `brew install ngrok` on macOS, `winget install --id Ngrok.Ngrok -e` on Windows.
2. Sign up free at https://dashboard.ngrok.com/signup (no credit card)
3. Paste your authtoken — wizard runs `ngrok config add-authtoken`
4. Reserve one free static domain at https://dashboard.ngrok.com/domains (pick any `<name>.ngrok-free.app`)
5. Wizard writes it to `~/.cibus-wolt/tunnel-hostname` and installs background services (launchd on macOS, Task Scheduler on Windows)

**Blocked by your corp network?** ngrok is blocked on many Microsoft corporate networks. Use Azure Dev Tunnels instead — Microsoft's first-party tunnel, signed in with your personal MS account:

```sh
npx cibus-wolt devtunnel-setup
# → installs `devtunnel` (winget on Windows, brew --cask on macOS)
# → opens browser for Microsoft account sign-in (use a *personal* MS account —
#   work tenants often block --allow-anonymous)
# → creates a persistent tunnel `cibus-wolt` with --allow-anonymous
# → writes the resulting `<name>-3737.<cluster>.devtunnels.ms` hostname and
#   installs background services
```

Stable URL across reboots, same `/webhook/<token>/...` and `/mcp/<token>` endpoints — only the hostname differs. If `--allow-anonymous` is rejected by your tenant policy, sign in with a personal MS account (not work) and re-run.

After that, `npx cibus-wolt webhook-url` prints your three stable URLs:

```
POST https://<name>.ngrok-free.app/webhook/<token>/drain  body: {"dry_run"?: boolean, "amount"?: number}
POST https://<name>.ngrok-free.app/webhook/<token>/otp    body: {"code": "123456"}
```

By default the drain spends your full available balance. Pass `"amount": 50` to spend exactly 50 ₪ (must be ≤ available).

**iOS Shortcut — Cibus OTP forwarder to webhook (~2 min):**

1. iPhone Shortcuts app → **Automation** tab → **+** → **Message**.
2. Filter: **Sender** is your Cibus SMS sender (e.g. Pluxee) **and** **Message** contains `קוד האימות`. That alone scopes it to OTP SMS — no regex needed.
3. Action: **Get Contents of URL** — method POST, URL `https://<name>.ngrok-free.app/webhook/<token>/otp`, headers `Content-Type: application/json`, Request Body (JSON): `{"code": <Message>}`. The server extracts the 6-digit code from the raw SMS text.
4. Turn off "Run After Confirmation" so it fires silently.

**Trigger a drain from your phone:** use Shortcuts → **+** → "Get Contents of URL" with POST to `.../webhook/<token>/drain`, body `{"dry_run": false}`. Put it on your home screen.

Android: Tasker's HTTP Request task does the same thing — same URLs, same JSON bodies.

### III. CLI + Claude

Claude orchestrates the drain. Wolt is already logged in (one-time `cibus-wolt wolt-login`); Claude doesn't need to touch it. The only thing Claude needs help with is the **Cibus SMS OTP**, which it can't read directly. OTP delivery is either:

- **Manual** — Claude asks, you read the SMS off your phone and type the 6 digits in the chat.
- **iOS Shortcut → Gmail** — Shortcut forwards the Cibus SMS to your Gmail with subject `cibus-otp`; Claude's Gmail integration reads it and submits automatically. See the [Cibus SMS → Gmail Shortcut](#ios-shortcut--forward-cibus-sms-to-gmail) below.
- **iOS Shortcut → webhook** — if you'd rather not give Claude Gmail access, set up the phone webhook too (path II) alongside Claude. Shortcut POSTs the SMS to ngrok; the tool's input bus feeds it back to Claude.

Whichever fires first wins. You can compose them.

**Claude Desktop (simplest):**

```sh
npx cibus-wolt claude-setup
# → pick "desktop"
# → wizard offers to auto-merge cibus-wolt into claude_desktop_config.json
```

Restart Claude Desktop. In a chat, toggle on Cibus-Wolt under the Tools menu. Ask: "call status". Then: "start a dry drain" — Claude drives the flow and waits for the Cibus OTP (asks you, or picks it up from Gmail/webhook).

**Claude.ai web + mobile:**

```sh
npx cibus-wolt claude-setup
# → pick "web"
# → wizard also runs ngrok setup if not already done (stable URL required)
# → prints the full Custom Connector URL
```

Register the printed URL at `claude.ai → Settings → Connectors → Add custom connector`. Name it `Cibus-Wolt`, leave OAuth fields blank.

In a chat, toggle on the connector, ask "start a dry drain." Claude:
1. Calls `start_drain({dry_run: true})` → pauses if Cibus needs OTP
2. For Cibus OTP (SMS): Claude *cannot* read SMS. Either you type the 6 digits in chat (Claude calls `submit_otp` with what you provided), OR — if you set up the SMS → Gmail Shortcut — Claude reads the `cibus-otp` email and submits automatically
3. Polls `drain_status` until completed

**SMS is the unskippable bit.** Cibus OTPs come by SMS, which no integration can read directly. Either you live with a short chat interruption when an OTP is needed, or you set up one iOS Shortcut (SMS → Gmail) once — see the section below.

## Gmail (optional)

Used by paths (b) and (d) — our Gmail poller or Claude's Gmail integration reads the **Cibus OTP forwarded as email** (subject `cibus-otp`, sent by your iOS Shortcut). Skip if you're only using the webhook (c) or terminal (a) paths.

```sh
# Set up a GCP project one-time (desktop OAuth client, gmail.readonly scope)
# Append to ~/.cibus-wolt/.env:
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

First run opens a browser for OAuth consent. Refresh token → `~/.cibus-wolt/token.json`.

### iOS Shortcut — forward Cibus SMS to Gmail

Needed for paths **(b)** and **(d)** if you want OTPs fully automatic. Cibus OTPs arrive as SMS, but the tool / Claude reads Gmail — so this Shortcut bridges them.

1. Shortcuts → **Automation** → **+** → **Message**.
2. Filter: **Sender** is your Cibus SMS sender (e.g. Pluxee) **and** **Message** contains `קוד האימות`.
3. Action: **Send Email** — to your own Gmail, subject `cibus-otp`, body `<Message>`. The server extracts the 6-digit code from the raw SMS text.
4. Turn off "Run After Confirmation".

Without this, OTP delivery is manual: Claude will ask you for the 6 digits in chat, or the terminal will prompt you.

## CLI reference

```
cibus-wolt setup            Interactive first-time setup / edit existing values
cibus-wolt wolt-login       Open Chrome to log in to Wolt manually (when session expired)
cibus-wolt claude-setup     Claude MCP only (skip webhook prompts)
cibus-wolt stable-tunnel    Set up ngrok static domain
cibus-wolt devtunnel-setup  Set up Azure Dev Tunnels (alternative when ngrok is blocked)
cibus-wolt run [--dry-run] [--amount N]
                            Run a drain. --amount N spends exactly N ₪ (≤ available).
cibus-wolt balance          Just fetch the Cibus balance
cibus-wolt status           Show auth + session state for each phase
cibus-wolt webhook-url      Print current webhook URLs
cibus-wolt rotate-token     Regenerate the webhook token
cibus-wolt reset <scope>    Wipe cached state (all|gmail|cibus|wolt|webhook|logs)
cibus-wolt logs             Print latest log
```

## How long does the Wolt session last?

After a manual `cibus-wolt wolt-login`, Wolt sets two cookies on `.wolt.com`:

| Cookie | Purpose | Expiry |
|---|---|---|
| `__wtoken` | Access token | ~1 year from issuance |
| `__wrtoken` | Refresh token | ~1 year from issuance |

Each `cibus-wolt run` does a quick authenticated `/me` hit before the drain. That triggers Wolt's sliding-window refresh, which re-issues both cookies with a fresh ~1-year expiry. So:

- **Drain weekly or monthly** — the drain itself is the keep-alive. The session never realistically expires.
- **Skip the tool for 12+ months, or Wolt forces a security rotation** — you'll see "no Wolt session cookie" on the next run. Run `npx cibus-wolt wolt-login` to re-authenticate.

There's no separate keep-alive command on purpose — the drain already does the right thing.

## Safety

- Secrets only live in `~/.cibus-wolt/.env` (0600). Not logged, not shipped.
- Webhook endpoints authenticate via a 256-bit token in the URL path. HTTPS via ngrok. Anyone with the full URL can trigger drains, but funds always go to *your own* Wolt account — no attacker-usable payout. Rotate anytime: `npx cibus-wolt rotate-token`.
- `MIN_AMOUNT` (default 10 ₪) and `MAX_SPEND` (default 1200 ₪) bound what a single run can spend.
- `--dry-run` runs the entire flow up to (but not including) the final Cibus payment confirm.

## Troubleshooting

- **Cibus asks for MFA every time** — the "זכור" (remember) checkbox wasn't ticked. Latest version ticks it automatically; if it's still happening, check the screenshots in `~/.cibus-wolt/screenshots/<latest>/` and file an issue.
- **Wolt session expired / "no Wolt session cookie"** — run `npx cibus-wolt wolt-login`. Opens Chrome to Wolt's login page; sign in manually, press Enter, done. The session cookie is reused on every subsequent drain and silently refreshed (see "How long does the Wolt session last?" below).
- **ngrok URL 404** — token rotated or domain changed. Run `npx cibus-wolt webhook-url` for current values; update your iOS Shortcut.
- **Selectors broken** — Wolt/Cibus redesigned their UI. Check `~/.cibus-wolt/screenshots/<latest>/` to see where, update the selector in `src/wolt.ts` or `src/cibus.ts`.

## What's next / known gaps

- Built-in scheduling exists (`cibus-wolt schedule add`) but only fires while the background MCP service is running. Install via `npm run install-bg`.
- Not on npm. Clone + `npm install` for now.
- Supported OSes: macOS (launchd) and Windows 10+ / Windows 11 (Task Scheduler) for both the CLI and the auto-start background services. PowerShell is the default shell on Windows. Linux works for the CLI but the auto-start path isn't wired up yet — run `npm run mcp` under your own systemd unit if you need it.

## License

MIT. Personal use. At your own risk with respect to Pluxee / Wolt terms of service.
