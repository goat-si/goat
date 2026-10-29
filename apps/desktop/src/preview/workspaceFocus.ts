import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";

export function forwardPreviewCommand(host: Electron.WebContents, command: string) {
  if (command === "workspace.focusNext" || command === "workspace.focusPrevious") host.focus();
  host.send(MENU_ACTION_CHANNEL, command);
}
