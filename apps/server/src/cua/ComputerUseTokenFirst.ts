/**
 * Token first (#cursor-steal): a foreground pointer call takes the person's cursor and screen,
 * so the proxy refuses it on a window whose latest tree read offered element tokens until the
 * agent has tried an element token or the keyboard there. Cua's action ladder puts the element
 * rung first and foreground last; agents that read a hint like "retry with foreground" skipped
 * straight past the background rungs (KakaoTalk, 2026-10-26).
 *
 * @module ComputerUseTokenFirst
 */
import { markUnverified } from "./ComputerUseDriverOutcome.ts";

const POINTER_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "move_cursor",
]);
const KEYBOARD_TOOLS = new Set(["type_text", "press_key", "hotkey", "set_value"]);

type Args = Record<string, unknown> | undefined;

const record = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const windowKey = (args: Args): string | undefined => {
  const target = record(args?.target) ?? args;
  const pid = target?.pid;
  const windowId = target?.window_id;
  return typeof pid === "number" && typeof windowId === "number" ? `${pid}:${windowId}` : undefined;
};

const isForeground = (args: Args) =>
  typeof args?.delivery_mode === "string" && args.delivery_mode.toLowerCase() === "foreground";

/** Element tokens in a get_window_state reply: rows printed as "[N]" or a structured list. */
const offersTokens = (result: unknown): boolean => {
  const reply = record(result);
  const structured = record(reply?.structuredContent);
  const elements = structured?.elements;
  if (Array.isArray(elements) && elements.some((element) => record(element)?.element_token))
    return true;
  const content = reply?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = record(part)?.text;
    return typeof text === "string" && /element_token|\n\s*-\s*\[\d+\]/u.test(text);
  });
};

/** Per connection: which windows' latest tree read offered tokens no background rung has used. */
export function makeTokenFirst() {
  const untried = new Set<string>();
  return {
    /**
     * A finished call's reply line, with ComputerUseDriverOutcome's unverified marking. A tree
     * read arms the window; a token or keyboard attempt disarms it.
     */
    reply: (
      request: { readonly tool?: string | undefined; readonly args?: unknown },
      message: { readonly result?: unknown },
      line: string,
    ): string => {
      note(request.tool, request.args, message.result);
      return markUnverified(request.tool, line);
    },
    /** Whether this call must try a token or the keyboard before taking the person's cursor. */
    refuses: (name: unknown, rawArgs: unknown): boolean => {
      const args = record(rawArgs);
      if (typeof name !== "string" || !POINTER_TOOLS.has(name) || !isForeground(args)) return false;
      if (args?.element_token !== undefined) return false;
      const key = windowKey(args);
      return key !== undefined && untried.has(key);
    },
  };
  function note(name: unknown, rawArgs: unknown, result: unknown) {
    const args = record(rawArgs);
    const key = windowKey(args);
    if (key === undefined) return;
    if (name === "get_window_state") {
      // A screenshot-only read keeps the tree and its tokens as they were.
      if (args?.include_accessibility_tree === false) return;
      if (offersTokens(result)) untried.add(key);
      else untried.delete(key);
      return;
    }
    if (typeof name !== "string") return;
    if (args?.element_token !== undefined || KEYBOARD_TOOLS.has(name)) untried.delete(key);
  }
}

export const TOKEN_FIRST_MESSAGE =
  "Foreground delivery takes the person's cursor and screen, and this window's last read offered element tokens you have not tried. Nothing was sent. Act with the element_token from your last get_window_state (a list row selects with a token click; press_key Return then opens it), or use the keyboard (Return, arrows, Tab), before foreground.";
