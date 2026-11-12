import { ipcRenderer } from "electron";
import { MAC_PERMISSION_HELPER_CHANNEL } from "./ipc/channels.ts";

// The panel says whether it waits for the switch or the app is not answering; both lines are
// in the page, which runs no script of its own.
ipcRenderer.on(MAC_PERMISSION_HELPER_CHANNEL, (_event, state: unknown) => {
  const status = document.getElementById("status");
  const line = typeof state === "string" ? status?.dataset[state] : undefined;
  if (status && line) status.textContent = line;
});

window.addEventListener("DOMContentLoaded", () => {
  const send = (action: "drag" | "finder" | "close") =>
    ipcRenderer.send(MAC_PERMISSION_HELPER_CHANNEL, action);
  document.getElementById("app")?.addEventListener("dragstart", (event) => {
    event.preventDefault();
    send("drag");
  });
  document.getElementById("app")?.addEventListener("click", () => send("finder"));
  document.getElementById("close")?.addEventListener("click", () => send("close"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("close");
  });
});
