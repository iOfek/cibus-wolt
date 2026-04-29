/**
 * Renderer entry — runs inside the BrowserWindow, like a regular web page.
 *
 * Multi-screen layout: sidebar nav + four screens (Drain, Credentials,
 * Schedules, MCP) + a wizard screen accessed via first-run auto-launch
 * or the "re-run setup wizard" link on Credentials.
 *
 * No Node access here. Everything that touches the OS, filesystem, or
 * src/* modules goes through `window.cibus.*` (exposed by preload).
 */

import type {
  Cadence,
  McpStatus,
  RunRecord,
  Schedule,
  ScheduleInput,
  TunnelStatus,
} from "./types.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

// ─── Navigation ─────────────────────────────────────────────────────────

// Per-screen "on enter" hook — runs whenever the user navigates to that
// screen. Used to refresh data that may have changed elsewhere (e.g. a
// scheduled drain firing updates last-fired timestamps in the schedules
// list).
const SCREEN_HOOKS: Record<string, () => Promise<void> | void> = {};

function navigate(screen: string): void {
  for (const btn of document.querySelectorAll<HTMLElement>(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.screen === screen);
  }
  for (const sec of document.querySelectorAll<HTMLElement>(".screen")) {
    sec.classList.toggle("active", sec.dataset.screen === screen);
  }
  void SCREEN_HOOKS[screen]?.();
}

document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.screen;
    if (target) navigate(target);
  });
});

// ─── Drain screen ───────────────────────────────────────────────────────

const balanceValue = $("balance-value");
const balanceStatus = $("balance-status");
const refreshBtn = $<HTMLButtonElement>("refresh-btn");
const drainBtn = $<HTMLButtonElement>("drain-btn");
const drainStatus = $("drain-status");
const historyList = $<HTMLUListElement>("history");

async function refreshBalance(): Promise<void> {
  refreshBtn.disabled = true;
  balanceStatus.textContent = "Fetching… (Cibus login may open a Chrome window)";
  balanceStatus.className = "status";
  try {
    const result = await window.cibus.getBalance();
    if (result.ok) {
      balanceValue.textContent = `₪${result.balance}`;
      balanceStatus.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } else {
      balanceValue.textContent = "—";
      balanceStatus.textContent = `Error: ${result.error}`;
      balanceStatus.className = "status error";
    }
  } finally {
    refreshBtn.disabled = false;
  }
}

async function drainNow(): Promise<void> {
  drainBtn.disabled = true;
  refreshBtn.disabled = true;
  drainStatus.textContent = "Draining… this can take a couple of minutes.";
  drainStatus.className = "status";
  try {
    const result = await window.cibus.drainNow();
    if (result.ok) {
      drainStatus.textContent = "✓ Drain complete.";
      drainStatus.className = "status success";
      await refreshBalance();
    } else {
      drainStatus.textContent = `Error: ${result.error}`;
      drainStatus.className = "status error";
    }
    await refreshHistory();
  } finally {
    drainBtn.disabled = false;
    refreshBtn.disabled = false;
  }
}

async function refreshHistory(): Promise<void> {
  const runs = await window.cibus.getRunHistory();
  historyList.innerHTML = "";
  if (runs.length === 0) {
    historyList.innerHTML = '<li class="muted">No runs yet.</li>';
    return;
  }
  for (const run of runs) {
    historyList.appendChild(renderRun(run));
  }
}

function renderRun(run: RunRecord): HTMLLIElement {
  const li = document.createElement("li");
  const ts = new Date(run.ts).toLocaleString();
  li.className = `run run-${run.status}`;
  li.textContent = `${ts} — ₪${run.amount} — ${run.status}${run.reason ? ` (${run.reason})` : ""}`;
  return li;
}

refreshBtn.addEventListener("click", refreshBalance);
drainBtn.addEventListener("click", drainNow);

// ─── Credentials screen ─────────────────────────────────────────────────

const credsForm = $<HTMLFormElement>("creds-form");
const credsStatus = $("creds-status");

async function loadCreds(): Promise<void> {
  const env = await window.cibus.readEnv();
  for (const [key, value] of Object.entries(env)) {
    const input = credsForm.elements.namedItem(key);
    if (input instanceof HTMLInputElement) input.value = value;
  }
}

credsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = credsForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  credsStatus.textContent = "Saving…";
  credsStatus.className = "status";
  try {
    const data: Record<string, string> = {};
    const fd = new FormData(credsForm);
    for (const [k, v] of fd.entries()) data[k] = String(v);
    await window.cibus.writeEnv(data);
    credsStatus.textContent = `Saved ${new Date().toLocaleTimeString()}`;
    credsStatus.className = "status success";
  } catch (err) {
    credsStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    credsStatus.className = "status error";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

$("rerun-wizard").addEventListener("click", (e) => {
  e.preventDefault();
  startWizard();
});

// ─── Schedules screen ───────────────────────────────────────────────────

const cadenceSelect = $<HTMLSelectElement>("cadence-select");
const addScheduleBtn = $<HTMLButtonElement>("add-schedule-btn");
const addScheduleForm = $<HTMLFormElement>("add-schedule-form");
const addScheduleCancel = $<HTMLButtonElement>("add-schedule-cancel");
const addScheduleStatus = $("add-schedule-status");
const schedulesList = $<HTMLUListElement>("schedules-list");
const cadenceFields = $("cadence-fields");

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

let currentCadence: Cadence = "weekly";

function renderCadenceFields(): void {
  if (currentCadence === "weekly") {
    cadenceFields.innerHTML = `
      <label>
        <span>Day of week</span>
        <select name="dayOfWeek" required>
          ${DOW_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("")}
        </select>
      </label>
    `;
  } else if (currentCadence === "monthly") {
    cadenceFields.innerHTML = `
      <label>
        <span>Day of month (1–31, or -1 for last day)</span>
        <input name="dayOfMonth" type="number" min="-1" max="31" required />
      </label>
    `;
  } else {
    cadenceFields.innerHTML = "";
  }
}

async function loadSchedules(): Promise<void> {
  const state = await window.cibus.loadSchedules();
  currentCadence = state.cadence;
  cadenceSelect.value = state.cadence;
  renderCadenceFields();

  schedulesList.innerHTML = "";
  if (state.schedules.length === 0) {
    schedulesList.innerHTML = '<li class="muted">No schedules yet.</li>';
    return;
  }
  for (const s of state.schedules) {
    schedulesList.appendChild(renderScheduleItem(s, state.cadence));
  }
}

function renderScheduleItem(s: Schedule, cadence: Cadence): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `schedule-item${s.enabled ? "" : " disabled"}`;

  const desc = describeScheduleClient(s, cadence);
  const lastSuccess = s.lastSuccessAt
    ? new Date(s.lastSuccessAt).toLocaleString()
    : "—";
  const lastMissed = s.lastMissedAt
    ? new Date(s.lastMissedAt).toLocaleString()
    : null;

  li.innerHTML = `
    <div class="schedule-main">
      <div class="schedule-desc">${escapeHtml(desc)}</div>
      <div class="schedule-meta">
        Last success: ${escapeHtml(lastSuccess)}${
          lastMissed ? ` · <span class="error">Missed: ${escapeHtml(lastMissed)}</span>` : ""
        }
      </div>
    </div>
    <div class="schedule-actions">
      <label class="toggle">
        <input type="checkbox" data-action="toggle" ${s.enabled ? "checked" : ""} />
        <span>${s.enabled ? "On" : "Off"}</span>
      </label>
      <button type="button" data-action="delete" class="danger">Delete</button>
    </div>
  `;

  li.querySelector<HTMLInputElement>('[data-action="toggle"]')!.addEventListener(
    "change",
    async (e) => {
      const target = e.target as HTMLInputElement;
      await window.cibus.setScheduleEnabled(s.id, target.checked);
      await loadSchedules();
    },
  );

  li.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener(
    "click",
    async () => {
      // confirm() is fine in Electron renderer — same dialog as a webpage.
      if (!confirm(`Delete "${desc}"?`)) return;
      await window.cibus.deleteSchedule(s.id);
      await loadSchedules();
    },
  );

  return li;
}

function describeScheduleClient(s: Schedule, cadence: Cadence): string {
  const amt = s.amount === undefined ? "full drain" : `₪${s.amount}`;
  let when: string;
  if (cadence === "weekly") {
    when = `${DOW_NAMES[s.dayOfWeek ?? 0]} ${s.time}`;
  } else if (cadence === "monthly") {
    when = `day ${s.dayOfMonth === -1 ? "LAST" : s.dayOfMonth} at ${s.time}`;
  } else {
    when = `daily at ${s.time}`;
  }
  const name = s.name ? `"${s.name}" — ` : "";
  return `${name}${when} — ${amt}`;
}

cadenceSelect.addEventListener("change", async () => {
  const newCadence = cadenceSelect.value as Cadence;
  if (currentCadence === newCadence) return;

  // Warn on cadence switch when schedules exist — day-of-week / day-of-month
  // fields don't translate cleanly across cadences.
  const state = await window.cibus.loadSchedules();
  if (state.schedules.length > 0) {
    const ok = confirm(
      `Switching cadence may invalidate ${state.schedules.length} existing schedule(s). Continue?`,
    );
    if (!ok) {
      cadenceSelect.value = currentCadence;
      return;
    }
  }

  await window.cibus.setCadence(newCadence);
  currentCadence = newCadence;
  renderCadenceFields();
});

addScheduleBtn.addEventListener("click", () => {
  addScheduleForm.hidden = !addScheduleForm.hidden;
  if (!addScheduleForm.hidden) {
    addScheduleStatus.textContent = "";
    addScheduleStatus.className = "status";
  }
});

addScheduleCancel.addEventListener("click", () => {
  addScheduleForm.hidden = true;
  addScheduleForm.reset();
  addScheduleStatus.textContent = "";
});

addScheduleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(addScheduleForm);
  const input: ScheduleInput = { time: String(fd.get("time") ?? "").trim() };
  const name = String(fd.get("name") ?? "").trim();
  if (name) input.name = name;
  const dow = fd.get("dayOfWeek");
  if (dow !== null && dow !== "") input.dayOfWeek = Number(dow);
  const dom = fd.get("dayOfMonth");
  if (dom !== null && dom !== "") input.dayOfMonth = Number(dom);
  const amt = fd.get("amount");
  if (amt !== null && amt !== "") input.amount = Number(amt);

  const result = await window.cibus.addSchedule(input);
  if (result.ok) {
    addScheduleForm.reset();
    addScheduleForm.hidden = true;
    addScheduleStatus.textContent = "";
    await loadSchedules();
  } else {
    addScheduleStatus.textContent = `Error: ${result.error}`;
    addScheduleStatus.className = "status error";
  }
});

SCREEN_HOOKS.schedules = loadSchedules;

// ─── MCP screen ─────────────────────────────────────────────────────────

const mcpStateValue = $("mcp-state-value");
const mcpToggle = $<HTMLButtonElement>("mcp-toggle");
const mcpStatusEl = $("mcp-status");
const mcpConfig = $("mcp-config");
const mcpPortLabel = $("mcp-port");
const mcpUrlEl = $("mcp-url");
const mcpTokenEl = $("mcp-token");
const mcpCopyUrl = $<HTMLButtonElement>("mcp-copy-url");
const mcpCopyToken = $<HTMLButtonElement>("mcp-copy-token");
const mcpRotate = $<HTMLButtonElement>("mcp-rotate");
const mcpActivity = $("mcp-activity");

function applyMcpStatus(status: McpStatus): void {
  mcpStateValue.textContent = status.running ? "running" : "stopped";
  mcpStateValue.className = `value mcp-state${status.running ? " running" : ""}`;
  mcpToggle.textContent = status.running ? "Stop" : "Start";
  mcpToggle.className = status.running ? "" : "primary";
  mcpPortLabel.textContent = String(status.port);

  // The URL+token panel only makes sense when the server is up; hide it
  // otherwise so we don't display a stale URL the user might try to use.
  mcpConfig.hidden = !status.running;
  if (status.running && status.url) {
    mcpUrlEl.textContent = status.url;
    mcpTokenEl.textContent = status.token;
  }

  if (status.active) {
    mcpActivity.innerHTML = `Run <code>${escapeHtml(status.active.id.slice(0, 8))}…</code> — ${escapeHtml(status.active.state)}`;
  } else {
    mcpActivity.textContent = "No active run.";
  }
}

mcpToggle.addEventListener("click", async () => {
  mcpToggle.disabled = true;
  mcpStatusEl.textContent = "";
  mcpStatusEl.className = "status";
  try {
    const status = await window.cibus.mcpStatus();
    if (status.running) {
      const result = await window.cibus.stopMcp();
      if (!result.ok) {
        mcpStatusEl.textContent = `Error: ${result.error}`;
        mcpStatusEl.className = "status error";
      }
    } else {
      const result = await window.cibus.startMcp();
      if (!result.ok) {
        mcpStatusEl.textContent = `Error: ${result.error}`;
        mcpStatusEl.className = "status error";
      }
    }
  } finally {
    mcpToggle.disabled = false;
    applyMcpStatus(await window.cibus.mcpStatus());
  }
});

mcpCopyUrl.addEventListener("click", () => {
  const text = mcpUrlEl.textContent ?? "";
  void navigator.clipboard.writeText(text);
});

mcpCopyToken.addEventListener("click", () => {
  const text = mcpTokenEl.textContent ?? "";
  void navigator.clipboard.writeText(text);
});

mcpRotate.addEventListener("click", async () => {
  if (!confirm("Rotating invalidates the current token; any clients using it will need the new value. Continue?")) {
    return;
  }
  const result = await window.cibus.rotateMcpToken();
  if (!result.ok) {
    mcpStatusEl.textContent = `Rotate failed: ${result.error}`;
    mcpStatusEl.className = "status error";
  }
  applyMcpStatus(await window.cibus.mcpStatus());
});

async function refreshMcp(): Promise<void> {
  applyMcpStatus(await window.cibus.mcpStatus());
}

// Subscribe to push events from main — fires immediately when the user
// starts/stops the server (window.cibus already exists at this point because
// preload runs before renderer JS).
window.cibus.onMcpStatus(applyMcpStatus);

SCREEN_HOOKS.mcp = async () => {
  await refreshMcp();
  await refreshTunnel();
};

// ─── Tunnel section (lives within MCP screen) ──────────────────────────
//
// The UI is a small state machine — only one block is shown at a time:
//   loading       initial probe
//   not-installed ngrok binary missing
//   not-auth      installed but no authtoken
//   no-domain     authenticated but no reserved domain saved
//   ready         all set; can start/stop the tunnel
//
// Stops at "ready" — the running/stopped sub-state is just a hidden block.

type TunnelUiState = "loading" | "not-installed" | "not-auth" | "no-domain" | "ready";

const tunnelStateValue = $("tunnel-state-value");
const tunnelStatusEl = $("tunnel-status");
const tunnelDomainEl = $("tunnel-domain");
const tunnelToggle = $<HTMLButtonElement>("tunnel-toggle");
const tunnelEditDomain = $<HTMLButtonElement>("tunnel-edit-domain");
const tunnelRunningBlock = $("tunnel-running-block");
const tunnelPublicUrl = $("tunnel-public-url");
const tunnelCopyUrl = $<HTMLButtonElement>("tunnel-copy-url");
const tunnelAuthForm = $<HTMLFormElement>("tunnel-auth-form");
const tunnelDomainForm = $<HTMLFormElement>("tunnel-domain-form");
const tunnelRecheck = $<HTMLButtonElement>("tunnel-recheck");

function showTunnelBlock(state: TunnelUiState): void {
  const blocks = ["loading", "not-installed", "not-auth", "no-domain", "ready"] as const;
  for (const b of blocks) {
    const el = document.getElementById(`tunnel-block-${b}`);
    if (el) el.hidden = b !== state;
  }
}

async function refreshTunnel(): Promise<void> {
  showTunnelBlock("loading");
  tunnelStatusEl.textContent = "";
  tunnelStatusEl.className = "status";

  const detect = await window.cibus.ngrokDetect();
  if (!detect.installed) {
    showTunnelBlock("not-installed");
    return;
  }
  if (!detect.authenticated) {
    showTunnelBlock("not-auth");
    return;
  }

  const config = await window.cibus.loadTunnelConfig();
  if (!config.hostname) {
    showTunnelBlock("no-domain");
    return;
  }

  // Ready state — show domain + start/stop button reflecting current run state.
  tunnelDomainEl.textContent = config.hostname;
  showTunnelBlock("ready");
  applyTunnelStatus(await window.cibus.tunnelStatus());
}

function applyTunnelStatus(status: TunnelStatus): void {
  tunnelStateValue.textContent = status.running ? "running" : "stopped";
  tunnelStateValue.className = `value mcp-state${status.running ? " running" : ""}`;
  tunnelToggle.textContent = status.running ? "Stop tunnel" : "Start tunnel";
  tunnelToggle.className = status.running ? "" : "primary";
  tunnelRunningBlock.hidden = !status.running;
  if (status.running && status.publicUrl) {
    tunnelPublicUrl.textContent = status.publicUrl;
  }
}

window.cibus.onTunnelStatus(applyTunnelStatus);

// External-link buttons go through main's allowlisted shell.openExternal —
// clicking opens the user's default browser, not the renderer.
function wireExternalLink(id: string, url: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.preventDefault();
    void window.cibus.openExternal(url);
  });
}
wireExternalLink("open-ngrok-download", "https://ngrok.com/download");
wireExternalLink("open-ngrok-signup", "https://dashboard.ngrok.com/");
wireExternalLink(
  "open-ngrok-authtoken",
  "https://dashboard.ngrok.com/get-started/your-authtoken",
);
wireExternalLink("open-ngrok-domains", "https://dashboard.ngrok.com/domains");
wireExternalLink("open-ngrok-domains-ready", "https://dashboard.ngrok.com/domains");
wireExternalLink("tunnel-open-claude", "https://claude.ai/customize/connectors");

tunnelRecheck.addEventListener("click", () => void refreshTunnel());

tunnelAuthForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = tunnelAuthForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const fd = new FormData(tunnelAuthForm);
  const token = String(fd.get("authtoken") ?? "").trim();
  if (!token) return;
  if (submit) submit.disabled = true;
  tunnelStatusEl.textContent = "Saving authtoken…";
  tunnelStatusEl.className = "status";
  try {
    const result = await window.cibus.setNgrokAuthToken(token);
    if (result.ok) {
      tunnelStatusEl.textContent = "✓ Authtoken saved.";
      tunnelStatusEl.className = "status success";
      tunnelAuthForm.reset();
      await refreshTunnel();
    } else {
      tunnelStatusEl.textContent = `Error: ${result.error}`;
      tunnelStatusEl.className = "status error";
    }
  } finally {
    if (submit) submit.disabled = false;
  }
});

tunnelDomainForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(tunnelDomainForm);
  const domain = String(fd.get("domain") ?? "").trim();
  if (!domain) return;
  const result = await window.cibus.saveTunnelConfig(domain, "ngrok");
  if (result.ok) {
    tunnelDomainForm.reset();
    await refreshTunnel();
  } else {
    tunnelStatusEl.textContent = `Error: ${result.error}`;
    tunnelStatusEl.className = "status error";
  }
});

tunnelEditDomain.addEventListener("click", () => {
  showTunnelBlock("no-domain");
});

tunnelToggle.addEventListener("click", async () => {
  tunnelToggle.disabled = true;
  tunnelStatusEl.textContent = "";
  tunnelStatusEl.className = "status";
  try {
    const status = await window.cibus.tunnelStatus();
    if (status.running) {
      const result = await window.cibus.stopTunnel();
      if (!result.ok) {
        tunnelStatusEl.textContent = `Error: ${result.error}`;
        tunnelStatusEl.className = "status error";
      }
    } else {
      const result = await window.cibus.startTunnel();
      if (!result.ok) {
        tunnelStatusEl.textContent = `Error: ${result.error}`;
        tunnelStatusEl.className = "status error";
      }
    }
  } finally {
    tunnelToggle.disabled = false;
    applyTunnelStatus(await window.cibus.tunnelStatus());
  }
});

tunnelCopyUrl.addEventListener("click", () => {
  const text = tunnelPublicUrl.textContent ?? "";
  void navigator.clipboard.writeText(text);
});

// ─── Wizard ─────────────────────────────────────────────────────────────
//
// Each step is an object with:
//   title       — shown in the wizard header
//   render(body) — fills the body element with step content
//   onNext()    — optional; runs when user clicks Next.
//                  Return false to cancel advancing (e.g. validation failed).
//   skippable   — show the Skip button on this step
//
// `wizardStep` is the current index into `wizardSteps`.
// `nextBtn.disabled` toggling lets steps gate progress async (e.g. Chrome
// not found until install + retry).

interface WizardStep {
  title: string;
  render(body: HTMLElement): void | Promise<void>;
  onNext?(): boolean | Promise<boolean>;
  skippable?: boolean;
}

const wizardBody = $("wizard-body");
const wizardTitle = $("wizard-title");
const wizardStepNum = $("wizard-step-num");
const wizardStepTotal = $("wizard-step-total");
const wizardBack = $<HTMLButtonElement>("wizard-back");
const wizardSkip = $<HTMLButtonElement>("wizard-skip");
const wizardNext = $<HTMLButtonElement>("wizard-next");

let wizardStep = 0;

const wizardSteps: WizardStep[] = [
  // 0 — Welcome
  {
    title: "Welcome",
    render(body) {
      body.innerHTML = `
        <p>This wizard sets up everything needed to drain your weekly
        Cibus balance into a Wolt gift card.</p>
        <p>You'll need:</p>
        <ul>
          <li>Cibus login (username / password / company)</li>
          <li>Google Chrome installed</li>
          <li>Optional: a Gmail account for unattended SMS-OTP relay</li>
        </ul>
        <p class="muted">You can skip optional steps and re-run this wizard
        any time from the Credentials tab.</p>
      `;
    },
  },

  // 1 — Cibus credentials
  {
    title: "Cibus credentials",
    async render(body) {
      body.innerHTML = `
        <form class="form" id="wiz-creds-form" autocomplete="off">
          <fieldset>
            <legend>Cibus</legend>
            <label><span>Username, email, or phone</span>
              <input name="CIBUS_USER" required />
            </label>
            <label><span>Permanent password</span>
              <input name="CIBUS_PASS" type="password" required />
            </label>
            <label><span>Company (as shown in Cibus)</span>
              <input name="CIBUS_COMPANY" placeholder="microsoft" required />
            </label>
          </fieldset>
        </form>
      `;
      const form = body.querySelector<HTMLFormElement>("#wiz-creds-form")!;
      const env = await window.cibus.readEnv();
      for (const k of ["CIBUS_USER", "CIBUS_PASS", "CIBUS_COMPANY"]) {
        const input = form.elements.namedItem(k);
        if (input instanceof HTMLInputElement && env[k]) input.value = env[k];
      }
    },
    async onNext() {
      const form = document.querySelector<HTMLFormElement>("#wiz-creds-form");
      if (!form) return true;
      if (!form.reportValidity()) return false;
      const data: Record<string, string> = { CIBUS_AUTH_MODE: "password" };
      const fd = new FormData(form);
      for (const [k, v] of fd.entries()) data[k] = String(v);
      await window.cibus.writeEnv(data);
      return true;
    },
  },

  // 2 — Chrome check
  {
    title: "Google Chrome",
    async render(body) {
      body.innerHTML = `<p class="muted">Checking for Chrome…</p>`;
      wizardNext.disabled = true;
      const result = await window.cibus.checkChrome();
      if (result.found) {
        body.innerHTML = `
          <p>✓ Found Chrome at <code>${escapeHtml(result.path ?? "")}</code></p>
          <p class="muted">Drains use Chrome with a dedicated profile under
          <code>~/.cibus-wolt</code>. The first Wolt sign-in is manual; after
          that the saved cookie auto-refreshes on every drain.</p>
        `;
        wizardNext.disabled = false;
      } else {
        body.innerHTML = `
          <p class="status error">Chrome not found.</p>
          <p>Install Google Chrome from
          <a href="#" id="wiz-chrome-link" class="link">chrome.com</a>,
          then click <strong>Re-check</strong>.</p>
          <button id="wiz-chrome-recheck">Re-check</button>
        `;
        body.querySelector("#wiz-chrome-link")?.addEventListener("click", (e) => {
          e.preventDefault();
          // openExternal would need an IPC; for now just show the URL.
          alert("Open https://www.google.com/chrome/ in your browser.");
        });
        body.querySelector("#wiz-chrome-recheck")?.addEventListener("click", async () => {
          await renderWizard();
        });
      }
    },
  },

  // 3 — Gmail (optional)
  {
    title: "Gmail (optional, for unattended OTP)",
    skippable: true,
    async render(body) {
      body.innerHTML = `
        <p>For unattended drains, Cibus SMS OTPs need to reach the laptop.
        The recommended path is an iOS Shortcut that forwards the SMS to
        Gmail; the app polls IMAP for the code.</p>
        <p class="muted">Skip this and you'll be prompted to enter the OTP
        manually each time MFA fires.</p>
        <form class="form" id="wiz-gmail-form" autocomplete="off">
          <fieldset>
            <legend>Gmail credentials</legend>
            <label><span>Gmail address</span>
              <input name="GMAIL_USER" type="email" placeholder="you@gmail.com" />
            </label>
            <label><span>Gmail App Password (16 chars)</span>
              <input name="GMAIL_APP_PASSWORD" type="password" />
            </label>
          </fieldset>
        </form>
        <div class="form-actions">
          <button id="wiz-gmail-verify">Verify IMAP login</button>
          <span class="status" id="wiz-gmail-status"></span>
        </div>
      `;
      const form = body.querySelector<HTMLFormElement>("#wiz-gmail-form")!;
      const env = await window.cibus.readEnv();
      for (const k of ["GMAIL_USER", "GMAIL_APP_PASSWORD"]) {
        const input = form.elements.namedItem(k);
        if (input instanceof HTMLInputElement && env[k]) input.value = env[k];
      }

      const verifyBtn = body.querySelector<HTMLButtonElement>("#wiz-gmail-verify")!;
      const status = body.querySelector<HTMLElement>("#wiz-gmail-status")!;
      verifyBtn.addEventListener("click", async () => {
        const user = (form.elements.namedItem("GMAIL_USER") as HTMLInputElement).value.trim();
        const pass = (form.elements.namedItem("GMAIL_APP_PASSWORD") as HTMLInputElement).value.replace(/\s+/g, "");
        if (!user || !pass) {
          status.textContent = "Fill both fields first.";
          status.className = "status error";
          return;
        }
        verifyBtn.disabled = true;
        status.textContent = "Connecting to imap.gmail.com:993…";
        status.className = "status";
        try {
          const result = await window.cibus.verifyGmail({ user, pass });
          if (result.ok) {
            status.textContent = `✓ Authorized as ${result.email}`;
            status.className = "status success";
            await window.cibus.writeEnv({ GMAIL_USER: user, GMAIL_APP_PASSWORD: pass });
          } else {
            status.textContent = `Failed: ${result.error}`;
            status.className = "status error";
          }
        } finally {
          verifyBtn.disabled = false;
        }
      });
    },
    async onNext() {
      // Save whatever's in the form even if the user didn't click verify —
      // they'll just find out at first drain whether the creds work.
      const form = document.querySelector<HTMLFormElement>("#wiz-gmail-form");
      if (!form) return true;
      const user = (form.elements.namedItem("GMAIL_USER") as HTMLInputElement).value.trim();
      const pass = (form.elements.namedItem("GMAIL_APP_PASSWORD") as HTMLInputElement).value.replace(/\s+/g, "");
      if (user || pass) {
        await window.cibus.writeEnv({ GMAIL_USER: user, GMAIL_APP_PASSWORD: pass });
      }
      return true;
    },
  },

  // 4 — Wolt login
  {
    title: "Wolt login",
    skippable: true,
    render(body) {
      body.innerHTML = `
        <p>Wolt's bot detection rejects automated email submission, so the
        first sign-in is manual.</p>
        <p class="muted">Click the button — Chrome opens with the Wolt login
        page. Sign in (email + the link Wolt sends). When the page reaches
        the home view, the cookie is saved and this step succeeds.</p>
        <div class="form-actions">
          <button id="wiz-wolt-btn">Open Wolt login</button>
          <span class="status" id="wiz-wolt-status"></span>
        </div>
      `;
      const btn = body.querySelector<HTMLButtonElement>("#wiz-wolt-btn")!;
      const status = body.querySelector<HTMLElement>("#wiz-wolt-status")!;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        status.textContent = "Chrome opening — sign in to Wolt, then return here.";
        status.className = "status";
        try {
          const result = await window.cibus.woltLogin();
          if (result.ok) {
            status.textContent = "✓ Wolt session saved.";
            status.className = "status success";
          } else {
            status.textContent = `Error: ${result.error}`;
            status.className = "status error";
          }
        } finally {
          btn.disabled = false;
        }
      });
    },
  },

  // 5 — Smoke test
  {
    title: "Smoke test (dry-run)",
    skippable: true,
    render(body) {
      body.innerHTML = `
        <p>Run a dry-run drain to verify the pipeline. Goes through every
        step except the final payment confirmation.</p>
        <p class="muted">Takes ~2 minutes. Opens Chrome.</p>
        <div class="form-actions">
          <button id="wiz-smoke-btn">Run dry-run</button>
          <span class="status" id="wiz-smoke-status"></span>
        </div>
      `;
      const btn = body.querySelector<HTMLButtonElement>("#wiz-smoke-btn")!;
      const status = body.querySelector<HTMLElement>("#wiz-smoke-status")!;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        status.textContent = "Running… this takes a couple of minutes.";
        status.className = "status";
        try {
          const result = await window.cibus.dryRunDrain();
          if (result.ok) {
            status.textContent = "✓ Dry-run complete. Pipeline works end-to-end.";
            status.className = "status success";
          } else {
            status.textContent = `Error: ${result.error}`;
            status.className = "status error";
          }
        } finally {
          btn.disabled = false;
        }
      });
    },
  },

  // 6 — Done
  {
    title: "All set",
    render(body) {
      body.innerHTML = `
        <p>You're ready to go.</p>
        <ul>
          <li>The <strong>Drain</strong> tab shows your balance and lets
              you trigger drains manually.</li>
          <li>The <strong>Credentials</strong> tab lets you edit settings
              later, or re-run this wizard.</li>
          <li>Schedules + MCP screens come in the next phase.</li>
        </ul>
      `;
    },
  },
];

async function renderWizard(): Promise<void> {
  const step = wizardSteps[wizardStep];
  if (!step) return;

  wizardStepNum.textContent = String(wizardStep + 1);
  wizardStepTotal.textContent = String(wizardSteps.length);
  wizardTitle.textContent = step.title;

  wizardBack.hidden = wizardStep === 0;
  wizardSkip.hidden = !step.skippable;
  wizardNext.textContent = wizardStep === wizardSteps.length - 1 ? "Finish" : "Next";
  wizardNext.disabled = false;

  wizardBody.innerHTML = "";
  await step.render(wizardBody);
}

async function advanceWizard(): Promise<void> {
  const step = wizardSteps[wizardStep];
  if (step?.onNext) {
    const ok = await step.onNext();
    if (!ok) return;
  }
  wizardStep++;
  if (wizardStep >= wizardSteps.length) {
    finishWizard();
    return;
  }
  await renderWizard();
}

async function skipWizardStep(): Promise<void> {
  wizardStep++;
  if (wizardStep >= wizardSteps.length) {
    finishWizard();
    return;
  }
  await renderWizard();
}

async function backWizard(): Promise<void> {
  if (wizardStep > 0) {
    wizardStep--;
    await renderWizard();
  }
}

async function startWizard(): Promise<void> {
  wizardStep = 0;
  navigate("wizard");
  await renderWizard();
}

function finishWizard(): void {
  navigate("drain");
  // Refresh credentials form + history in case wizard wrote new values.
  void loadCreds();
  void refreshHistory();
}

wizardBack.addEventListener("click", () => void backWizard());
wizardSkip.addEventListener("click", () => void skipWizardStep());
wizardNext.addEventListener("click", () => void advanceWizard());

// ─── Helpers ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Init ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // First-run: if creds aren't set, launch the wizard. Otherwise drain tab.
  const configured = await window.cibus.isConfigured();
  if (configured) {
    navigate("drain");
  } else {
    await startWizard();
  }
  await loadCreds();
  await refreshHistory();
}

init();
