/**
 * press_key and hotkey keys resolved before dispatch: the pinned macOS driver failed `*`,
 * `super+c` or `KP_0` only after targeting, as delivery_failed that reads as "may have acted".
 * @module ComputerUseKeyNames
 */
// Provider lines are JSON-RPC; only press_key and hotkey arguments are rewritten.
// @effect-diagnostics preferSchemaOverJson:off
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";

const MODIFIERS: ReadonlyMap<string, string> = new Map([
  ["cmd", "cmd"],
  ["command", "cmd"],
  ["super", "cmd"],
  ["meta", "cmd"],
  ["win", "cmd"],
  ["shift", "shift"],
  ["option", "option"],
  ["alt", "option"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["fn", "fn"],
]);

/** xdotool keysym names for printable symbols. */
const KEYSYMS: ReadonlyMap<string, string> = new Map([
  ["exclam", "!"],
  ["at", "@"],
  ["numbersign", "#"],
  ["dollar", "$"],
  ["percent", "%"],
  ["asciicircum", "^"],
  ["ampersand", "&"],
  ["asterisk", "*"],
  ["parenleft", "("],
  ["parenright", ")"],
  ["underscore", "_"],
  ["plus", "+"],
  ["braceleft", "{"],
  ["braceright", "}"],
  ["bar", "|"],
  ["colon", ":"],
  ["quotedbl", '"'],
  ["less", "<"],
  ["greater", ">"],
  ["question", "?"],
  ["asciitilde", "~"],
  ["minus", "-"],
  ["equal", "="],
  ["bracketleft", "["],
  ["bracketright", "]"],
  ["backslash", "\\"],
  ["semicolon", ";"],
  ["apostrophe", "'"],
  ["comma", ","],
  ["period", "."],
  ["slash", "/"],
  ["grave", "`"],
]);

/** Symbols typed with Shift, as the US-layout key the driver's key codes follow. */
const SHIFTED: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
  ["~", "`"],
]);

/**
 * Keypad keys as the main-row key with the same character; the pinned driver has no keypad key
 * codes, and apps that read the character take either.
 */
const KEYPAD: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 10 }, (_, digit) => [`kp${digit}`, String(digit)] as const),
  ["kpadd", "+"],
  ["kpsubtract", "-"],
  ["kpmultiply", "*"],
  ["kpdivide", "/"],
  ["kpdecimal", "."],
  ["kpequal", "="],
]);

/** Multi-character names the driver accepts, after its own folding (canonical below). */
const NAMED: ReadonlySet<string> = new Set([
  "return",
  "enter",
  "tab",
  "space",
  "delete",
  "backspace",
  "escape",
  "esc",
  "capslock",
  "home",
  "pageup",
  "del",
  "forward_delete",
  "end",
  "pagedown",
  "left",
  "right",
  "down",
  "up",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  ...MODIFIERS.keys(),
]);

const ALIASES: ReadonlyMap<string, string> = new Map([
  ["pgdn", "pagedown"],
  ["pgdown", "pagedown"],
  ["next", "pagedown"],
  ["pgup", "pageup"],
  ["prior", "pageup"],
  ["arrowleft", "left"],
  ["leftarrow", "left"],
  ["arrowright", "right"],
  ["rightarrow", "right"],
  ["arrowup", "up"],
  ["uparrow", "up"],
  ["arrowdown", "down"],
  ["downarrow", "down"],
  ["forwarddelete", "forward_delete"],
  ["fwddelete", "forward_delete"],
  ["deleteforward", "forward_delete"],
  ["bksp", "backspace"],
  ["kpenter", "enter"],
  ["numpadenter", "enter"],
]);

/** A multi-character name folded as the driver folds it: lower case, no spaces, _ or -. */
const canonical = (name: string) => {
  const compact = name.toLowerCase().replace(/[ _-]/gu, "");
  return ALIASES.get(compact) ?? compact;
};

/** Single characters the driver presses: letters, digits and unshifted US symbols. */
const SINGLE = /^[a-z0-9=\-\][';\\,./`]$/u;

export type ResolvedKey =
  | { readonly key: string; readonly modifiers: ReadonlyArray<string> }
  | { readonly error: string };

/** One key press resolved to a key the driver can press and its modifiers. */
export function resolveKey(key: string, modifiers: ReadonlyArray<string>): ResolvedKey {
  const resolved: Array<string> = [];
  const add = (modifier: string) => {
    if (!resolved.includes(modifier)) resolved.push(modifier);
  };
  for (const modifier of modifiers) {
    const name = MODIFIERS.get(modifier.trim().toLowerCase());
    if (name === undefined)
      return {
        error: `Unknown modifier: ${modifier}. Use cmd (super), shift, option (alt), ctrl or fn.`,
      };
    add(name);
  }
  let name = key.trim();
  if (name.length > 1 && name.includes("+") && !name.endsWith("+")) {
    const parts = name.split("+");
    const prefix = parts.slice(0, -1).map((part) => MODIFIERS.get(part.trim().toLowerCase()));
    if (prefix.every((part) => part !== undefined)) {
      for (const part of prefix) add(part);
      name = parts.at(-1) ?? name;
    }
  }
  const folded = name.length > 1 ? canonical(name) : name;
  // xdotool's Prior and Next are spelled as the driver knows them; other names pass as written.
  const spelled = folded === "pageup" || folded === "pagedown" ? folded : name;
  const character = KEYSYMS.get(folded) ?? KEYPAD.get(folded) ?? spelled;
  const base = SHIFTED.get(character);
  if (base !== undefined) add("shift");
  const pressed = base ?? character;
  const known =
    pressed.length === 1 ? SINGLE.test(pressed.toLowerCase()) : NAMED.has(canonical(pressed));
  if (!known)
    return {
      error: `Unknown key name: ${key}. Use a key name such as return, tab, escape, space, delete, left, right, up, down, pageup, pagedown, home, end, f1..f12, KP_0..KP_9, a letter, digit or US-keyboard symbol (* is shift+8), or an xdotool keysym such as asterisk; to enter other text use type_text.`,
    };
  return { key: pressed, modifiers: resolved };
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** The refusal for a key that cannot be pressed, shaped as the driver's own refusals. */
const keyRefusal = (id: JsonRpcId, message: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      structuredContent: {
        code: "invalid_arguments",
        effect: "refused",
        dispatched: false,
        message,
      },
      isError: true,
    },
  });

/**
 * A provider line with the keys of a press_key or hotkey call resolved, or the answer refusing
 * it. Other lines, and calls whose keys are already what the driver presses, pass unchanged.
 */
export function resolveKeyCall(
  line: string,
): { readonly line: string } | { readonly answer: string } {
  let message: Record<string, unknown> | undefined;
  try {
    message = record(JSON.parse(line));
  } catch {
    return { line };
  }
  const params = record(message?.params);
  const args = record(params?.arguments);
  const id = message?.id;
  if (
    message?.method !== "tools/call" ||
    args === undefined ||
    (typeof id !== "string" && typeof id !== "number")
  )
    return { line };
  const rewrite = (next: Record<string, unknown>) =>
    JSON.stringify({ ...message, params: { ...params, arguments: next } });
  if (params?.name === "press_key" && typeof args.key === "string") {
    const given = strings(args.modifiers ?? []);
    if (given === undefined) return { line };
    const resolved = resolveKey(args.key, given);
    if ("error" in resolved) return { answer: keyRefusal(id, resolved.error) };
    if (resolved.key === args.key && resolved.modifiers.join() === given.join()) return { line };
    const { modifiers: _, ...rest } = args;
    return {
      line: rewrite({
        ...rest,
        key: resolved.key,
        ...(resolved.modifiers.length > 0 ? { modifiers: resolved.modifiers } : {}),
      }),
    };
  }
  if (params?.name === "hotkey") {
    const keys = strings(args.keys);
    if (keys === undefined || keys.length === 0) return { line };
    const isModifier = (key: string) => MODIFIERS.has(key.trim().toLowerCase());
    const last = keys.findLast((key) => !isModifier(key));
    if (last === undefined) return { line };
    const resolved = resolveKey(last, keys.filter(isModifier));
    if ("error" in resolved) return { answer: keyRefusal(id, resolved.error) };
    const next = [...resolved.modifiers, resolved.key];
    if (next.join("\u0000") === keys.join("\u0000")) return { line };
    return { line: rewrite({ ...args, keys: next }) };
  }
  return { line };
}
