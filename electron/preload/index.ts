/**
 * Preload script — runs in the renderer's process before any page JS.
 *
 * Bridges the UI to the main process via IPC. The renderer can't import
 * Node modules; it can only call the small surface we expose here.
 *
 * `contextBridge.exposeInMainWorld("cibus", api)` makes the api object
 * available as `window.cibus.*` to renderer code.
 *
 * `ipcRenderer.invoke(channel, ...args)` is the request/response pattern:
 * sends a message to the matching `ipcMain.handle(channel, ...)` handler
 * in main and resolves with whatever it returns.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cibus", {
  getBalance: () => ipcRenderer.invoke("cibus:getBalance"),
  drainNow: () => ipcRenderer.invoke("cibus:drainNow"),
  getRunHistory: () => ipcRenderer.invoke("cibus:getRunHistory"),
  readEnv: () => ipcRenderer.invoke("cibus:readEnv"),
  writeEnv: (partial: Record<string, string>) =>
    ipcRenderer.invoke("cibus:writeEnv", partial),
  isConfigured: () => ipcRenderer.invoke("cibus:isConfigured"),
  checkChrome: () => ipcRenderer.invoke("cibus:checkChrome"),
  verifyGmail: (creds: { user: string; pass: string }) =>
    ipcRenderer.invoke("cibus:verifyGmail", creds),
  woltLogin: () => ipcRenderer.invoke("cibus:woltLogin"),
  dryRunDrain: () => ipcRenderer.invoke("cibus:dryRunDrain"),
  loadSchedules: () => ipcRenderer.invoke("cibus:loadSchedules"),
  setCadence: (cadence: "weekly" | "monthly" | "daily") =>
    ipcRenderer.invoke("cibus:setCadence", cadence),
  addSchedule: (input: {
    name?: string;
    dayOfWeek?: number;
    dayOfMonth?: number;
    time: string;
    amount?: number;
  }) => ipcRenderer.invoke("cibus:addSchedule", input),
  deleteSchedule: (id: string) => ipcRenderer.invoke("cibus:deleteSchedule", id),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("cibus:setScheduleEnabled", id, enabled),
  mcpStatus: () => ipcRenderer.invoke("cibus:mcpStatus"),
  startMcp: () => ipcRenderer.invoke("cibus:startMcp"),
  stopMcp: () => ipcRenderer.invoke("cibus:stopMcp"),
  rotateMcpToken: () => ipcRenderer.invoke("cibus:rotateMcpToken"),
  // Push notifications: main broadcasts on state change; renderer subscribes
  // and gets a teardown function back so we can detach if the screen unmounts.
  onMcpStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("mcp:status", handler);
    return () => ipcRenderer.removeListener("mcp:status", handler);
  },
  ngrokDetect: () => ipcRenderer.invoke("cibus:ngrokDetect"),
  setNgrokAuthToken: (token: string) =>
    ipcRenderer.invoke("cibus:setNgrokAuthToken", token),
  loadTunnelConfig: () => ipcRenderer.invoke("cibus:loadTunnelConfig"),
  saveTunnelConfig: (hostname: string, kind: "ngrok" | "devtunnel" = "ngrok") =>
    ipcRenderer.invoke("cibus:saveTunnelConfig", hostname, kind),
  startTunnel: () => ipcRenderer.invoke("cibus:startTunnel"),
  stopTunnel: () => ipcRenderer.invoke("cibus:stopTunnel"),
  tunnelStatus: () => ipcRenderer.invoke("cibus:tunnelStatus"),
  onTunnelStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("tunnel:status", handler);
    return () => ipcRenderer.removeListener("tunnel:status", handler);
  },
  openExternal: (url: string) => ipcRenderer.invoke("cibus:openExternal", url),
});
