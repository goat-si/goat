// Hands the renderer what it needs to reach the host directly (owner contract 2026-11-28):
// window.goat2Host = { wsUrl, token, build }. wsUrl is null until the host has printed its start line
// (the window reloads once it has); all are null for a page main does not trust. build =
// { commit, branch, builtAt, dirty } of this app, shown in the Dev top bar (owner 2026-11-28).
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

interface Goat2Build {
  readonly commit: string;
  readonly branch: string;
  /** ISO time of the packaged build; null when running unpackaged. */
  readonly builtAt: string | null;
  readonly dirty: boolean;
}
const info = ipcRenderer.sendSync("goat2:host-info") as {
  wsUrl: string | null;
  token: string | null;
  build: Goat2Build | null;
};
contextBridge.exposeInMainWorld(
  "goat2Host",
  Object.freeze({ wsUrl: info.wsUrl, token: info.token, build: info.build === null ? null : Object.freeze({ ...info.build }) }),
);
