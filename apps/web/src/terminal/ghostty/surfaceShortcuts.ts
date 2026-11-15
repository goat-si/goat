import { resolveEventKeys } from "@goat/shared/keybindings";
import { isMacPlatform } from "../../lib/utils";

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const keys = resolveEventKeys(event);
  if (keys.has("insert") && !isMacPlatform(platform)) {
    return event.ctrlKey && !event.shiftKey && !event.metaKey;
  }
  if (!keys.has("c")) return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const keys = resolveEventKeys(event);
  if (keys.has("insert") && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (!keys.has("v")) return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}
