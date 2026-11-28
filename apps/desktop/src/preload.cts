// Hands the renderer what it needs to reach the host directly (owner contract 2026-11-28):
// window.goat2Host = { wsUrl, token }. wsUrl is null until the host has printed its start line (the
// window reloads once it has); both are null for a page main does not trust.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const info = ipcRenderer.sendSync("goat2:host-info") as { wsUrl: string | null; token: string | null };
contextBridge.exposeInMainWorld("goat2Host", Object.freeze({ wsUrl: info.wsUrl, token: info.token }));
