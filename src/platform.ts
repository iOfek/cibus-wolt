/* eslint-disable no-console */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-platform helpers for the bits that differ between macOS, Windows, and
 * Linux: opening URLs in the user's browser, finding executables on PATH,
 * locating Google Chrome, and choosing the right service-manager (launchd vs
 * Task Scheduler vs systemd-user). Everything else in the codebase is plain
 * Node and works unchanged.
 */

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** Open a URL in the user's default browser. Best-effort; never throws. */
export function openUrl(url: string): void {
  try {
    if (IS_MAC) {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (IS_WIN) {
      // Start-Process is the PowerShell-native way and avoids cmd.exe quoting issues.
      spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve an executable name to an absolute path by walking PATH. Avoids
 * shelling out to `which` / `where`, so it's identical on all OSes. On Windows
 * tries each PATHEXT extension when the bare name has none.
 */
export function findOnPath(bin: string): string | null {
  const PATH = process.env.PATH ?? "";
  const sep = IS_WIN ? ";" : ":";
  const dirs = PATH.split(sep).filter(Boolean);
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""];
  const hasExt = IS_WIN && /\.[a-z0-9]+$/i.test(bin);
  for (const dir of dirs) {
    if (hasExt || !IS_WIN) {
      const p = path.join(dir, bin);
      if (existsSync(p)) return p;
    } else {
      for (const ext of exts) {
        const p = path.join(dir, bin + ext);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** True iff the given executable is on PATH. */
export function binaryExists(bin: string): boolean {
  return findOnPath(bin) !== null;
}

/** Locate Google Chrome on disk. Returns null if not installed. */
export function findChrome(): string | null {
  const candidates: string[] = [];
  if (IS_MAC) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    );
  } else if (IS_WIN) {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome Beta", "Application", "chrome.exe"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Where Claude Desktop reads its MCP config from. */
export function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (IS_MAC) return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (IS_WIN) {
    const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Human-friendly install hint for ngrok on the current OS. */
export function ngrokInstallHint(): string {
  if (IS_MAC) return "brew install ngrok";
  if (IS_WIN) return "winget install --id Ngrok.Ngrok -e";
  return "see https://ngrok.com/download";
}

/** Try to install ngrok via the platform's package manager. Returns true on success. */
export function tryInstallNgrok(): boolean {
  try {
    if (IS_MAC) {
      execSync("brew install ngrok", { stdio: "inherit" });
      return true;
    }
    if (IS_WIN) {
      execSync("winget install --id Ngrok.Ngrok -e --silent --accept-source-agreements --accept-package-agreements", {
        stdio: "inherit",
        shell: "powershell.exe",
      } as { stdio: "inherit"; shell: string });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
