/**
 * Inputs whose usual effect is to open or close a window: their window read waits briefly for
 * that effect, and a close is confirmed by the bound window leaving its process's id snapshot.
 */
import type { DesktopRow } from "./DesktopObserveRead.ts";

export type WindowIntent = "open" | "close";

const COMMAND = new Set(["command", "cmd", "meta"]);
const OPEN_KEYS = new Set(["n", "t", "o", ","]);
const CLOSE_KEYS = new Set(["w", "q"]);
const CLOSE_BUTTON = /^(close button|닫기 버튼)$/i;
const OPEN_MENU = /^(new|open|새로운|새 |열기)/i;
const CLOSE_MENU = /^(close|quit|닫기|종료)/i;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((s) => s.toLowerCase())
    : [];

/** The key and modifiers of a press, also when the key names them as "cmd+w". */
const chord = (forwarded: Record<string, unknown>) => {
  const raw = typeof forwarded.key === "string" ? forwarded.key.toLowerCase() : "";
  const parts = raw.length > 1 && raw.includes("+") ? raw.split("+").filter(Boolean) : [raw];
  return {
    key: parts.at(-1) ?? "",
    modifiers: [...parts.slice(0, -1), ...strings(forwarded.modifiers)],
  };
};

export const windowIntentOf = (
  tool: string,
  forwarded: Record<string, unknown>,
  acted: DesktopRow | undefined,
): WindowIntent | undefined => {
  if (tool === "press_key") {
    const { key, modifiers } = chord(forwarded);
    if (!modifiers.some((modifier) => COMMAND.has(modifier))) return undefined;
    return CLOSE_KEYS.has(key) ? "close" : OPEN_KEYS.has(key) ? "open" : undefined;
  }
  if (tool === "invoke_menu") {
    const label = (strings(forwarded.path).at(-1) ?? "").trim();
    return CLOSE_MENU.test(label) ? "close" : OPEN_MENU.test(label) ? "open" : undefined;
  }
  return tool === "click" && acted !== undefined && CLOSE_BUTTON.test(acted.name.trim())
    ? "close"
    : undefined;
};

/** A pointer click the driver says landed on a window's close button, as its result's hit names it. */
export const hitCloseButton = (tool: string, value: unknown): boolean => {
  if (tool !== "click" || typeof value !== "object" || value === null) return false;
  const hit = (value as { hit?: unknown }).hit;
  const name =
    typeof hit === "object" && hit !== null ? (hit as { name?: unknown }).name : undefined;
  return typeof name === "string" && CLOSE_BUTTON.test(name.trim());
};
