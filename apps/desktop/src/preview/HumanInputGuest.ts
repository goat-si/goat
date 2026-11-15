import { ipcRenderer } from "electron";
import { HUMAN_INPUT_CHANNEL, POINTER_DOWN_HOST_CHANNEL } from "./GuestProtocol.ts";

const reportHumanPointerInput = (event: PointerEvent): void => {
  if (!event.isTrusted) return;
  // The guest does not always take focus on a click, so the host's webview
  // `focus` event can't be relied on to dismiss open menus and popovers.
  ipcRenderer.sendToHost(POINTER_DOWN_HOST_CHANNEL);
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "pointer",
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  });
};

const reportHumanKeyInput = (event: KeyboardEvent): void => {
  if (!event.isTrusted) return;
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "key",
    key: event.key,
    code: event.code,
  });
};

window.addEventListener("pointerdown", reportHumanPointerInput, true);
window.addEventListener("keydown", reportHumanKeyInput, true);
