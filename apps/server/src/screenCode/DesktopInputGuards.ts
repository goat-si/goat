/**
 * Pre-dispatch safety guards for desktop app input: canonical key and modifier resolution,
 * table-cell typing refusal, send-on-Enter chat policy, recognized clipboard-paste refusal,
 * visible click bounds, and standard outcome sentences.
 */
import type { ScreenRunError } from "@goat/contracts";
import { fail } from "./DesktopDriverReplies.ts";
import type { Placed, Rect } from "./DesktopFrames.ts";

export interface GuardElement {
  readonly index?: number;
  readonly role: string;
  readonly name: string;
  readonly rawLabel: string;
  readonly description: string;
  readonly placeholder: string;
  readonly identifier: string;
  readonly editable: boolean;
  readonly tableCell: boolean;
}

const SEND_ON_ENTER: Readonly<Record<string, string>> = {
  "com.kakao.kakaotalkmac": "KakaoTalk",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.apple.mobilesms": "Messages",
  "com.hnc.discord": "Discord",
  "ru.keepcoder.telegram": "Telegram",
  "jp.naver.line.mac": "LINE",
  "net.whatsapp.whatsapp": "WhatsApp",
};

const PASTE_MENU_LABELS: ReadonlySet<string> = new Set([
  "paste",
  "paste and match style",
  "paste special…",
  "paste special...",
  "paste style",
  "붙여넣기",
  "스타일 붙여넣기",
]);

const TABLE_CELL_ROLES: ReadonlySet<string> = new Set(["textfield", "statictext", "cell"]);
const TABLE_ANCESTOR_ROLES: ReadonlySet<string> = new Set(["row", "cell", "outline", "table"]);
const SEARCH_HINTS = ["search", "검색", "찾기"];
const SEND_HINTS = ["send", "보내기", "전송", "submit"];

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const bareRole = (role: string) => role.trim().toLowerCase().replace(/^ax/, "");

/**
 * Key and modifier canonicalization matching cua-driver
 * rust/crates/platform-macos/src/input/keyboard.rs:1138-1305.
 */
const canonicalModifier = (name: string): string | undefined => {
  switch (name.trim().toLowerCase()) {
    case "cmd":
    case "command":
    case "super":
    case "meta":
    case "win":
      return "cmd";
    case "shift":
      return "shift";
    case "option":
    case "alt":
      return "option";
    case "ctrl":
    case "control":
      return "ctrl";
    case "fn":
      return "fn";
    default:
      return undefined;
  }
};

const keysymCharacter = (key: string): string => {
  switch (key.trim().toLowerCase()) {
    case "exclam":
      return "!";
    case "at":
      return "@";
    case "numbersign":
      return "#";
    case "dollar":
      return "$";
    case "percent":
      return "%";
    case "asciicircum":
      return "^";
    case "ampersand":
      return "&";
    case "asterisk":
      return "*";
    case "parenleft":
      return "(";
    case "parenright":
      return ")";
    case "underscore":
      return "_";
    case "plus":
      return "+";
    case "braceleft":
      return "{";
    case "braceright":
      return "}";
    case "bar":
      return "|";
    case "colon":
      return ":";
    case "quotedbl":
      return '"';
    case "less":
      return "<";
    case "greater":
      return ">";
    case "question":
      return "?";
    case "asciitilde":
      return "~";
    case "minus":
      return "-";
    case "equal":
      return "=";
    case "bracketleft":
      return "[";
    case "bracketright":
      return "]";
    case "backslash":
      return "\\";
    case "semicolon":
      return ";";
    case "apostrophe":
      return "'";
    case "comma":
      return ",";
    case "period":
      return ".";
    case "slash":
      return "/";
    case "grave":
      return "`";
    default:
      return key;
  }
};

const shiftedSymbolBase = (symbol: string): string | undefined => {
  switch (symbol) {
    case "!":
      return "1";
    case "@":
      return "2";
    case "#":
      return "3";
    case "$":
      return "4";
    case "%":
      return "5";
    case "^":
      return "6";
    case "&":
      return "7";
    case "*":
      return "8";
    case "(":
      return "9";
    case ")":
      return "0";
    case "_":
      return "-";
    case "+":
      return "=";
    case "{":
      return "[";
    case "}":
      return "]";
    case "|":
      return "\\";
    case ":":
      return ";";
    case '"':
      return "'";
    case "<":
      return ",";
    case ">":
      return ".";
    case "?":
      return "/";
    case "~":
      return "`";
    default:
      return undefined;
  }
};

const canonicalKeyName = (key: string): string => {
  if (key === "\r" || key === "\n") return "enter";
  const lower = key.trim().toLowerCase();
  if ([...lower].length < 2) return lower;
  const compact = lower.replaceAll(/[ _-]/g, "");
  switch (compact) {
    case "pgdn":
    case "pgdown":
    case "next":
      return "pagedown";
    case "pgup":
    case "prior":
      return "pageup";
    case "arrowleft":
    case "leftarrow":
      return "left";
    case "arrowright":
    case "rightarrow":
      return "right";
    case "arrowup":
    case "uparrow":
      return "up";
    case "arrowdown":
    case "downarrow":
      return "down";
    case "forwarddelete":
    case "fwddelete":
    case "deleteforward":
      return "forward_delete";
    case "bksp":
      return "backspace";
    case "escape":
    case "esc":
      return "escape";
    case "return":
    case "enter":
    case "kpenter":
    case "numpadenter":
    case "keypadenter":
      return "enter";
    default:
      return compact;
  }
};

const resolveKeyPress = (
  args: Record<string, unknown>,
): { readonly key: string; readonly modifiers: ReadonlySet<string> } => {
  const modifiers = new Set<string>();
  const rawList = Array.isArray(args.modifiers)
    ? args.modifiers
    : Array.isArray(args.modifier)
      ? args.modifier
      : [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const mod = canonicalModifier(item);
    if (mod !== undefined) modifiers.add(mod);
  }
  const rawKey = typeof args.key === "string" ? args.key : "";
  if (rawKey === "\r" || rawKey === "\n") return { key: "enter", modifiers };
  const trimmed = rawKey.trim();
  let name = trimmed;
  if ([...trimmed].length > 1 && trimmed.includes("+") && !trimmed.endsWith("+")) {
    const parts = trimmed.split("+");
    const prefix = parts.slice(0, -1);
    const last = parts.at(-1) ?? trimmed;
    if (prefix.every((part) => canonicalModifier(part) !== undefined)) {
      for (const part of prefix) {
        const mod = canonicalModifier(part);
        if (mod !== undefined) modifiers.add(mod);
      }
      name = last;
    }
  }
  const character = keysymCharacter(name);
  const shifted = shiftedSymbolBase(character);
  if (shifted !== undefined) {
    modifiers.add("shift");
    return { key: canonicalKeyName(shifted), modifiers };
  }
  return { key: canonicalKeyName(character), modifiers };
};

/** Agent-facing outcome sentence for pre-dispatch refusals, unknown outcomes and human pauses. */
export const outcomeSentence = (
  kind: "refused" | "unknown_outcome" | "paused_unsent" | "paused_dispatched",
  app?: string,
): string => {
  const target = app && app.trim().length > 0 ? app.trim() : "the app";
  switch (kind) {
    case "refused":
      return "Nothing was sent.";
    case "unknown_outcome":
      return "It may have taken effect; get the state before retrying, and do not resend.";
    case "paused_unsent":
      return `The person worked in ${target} and GOAT paused, so nothing was sent.`;
    case "paused_dispatched":
      return `The person worked in ${target} and GOAT paused. It may have taken effect; get the state before retrying, and do not resend.`;
  }
};

/** Indexes each observed element's role, labels and 4-hop table/outline ancestry by driver token. */
export const inspectTreeElements = (
  entries: readonly Record<string, unknown>[],
  rows: ReadonlyArray<{
    readonly index?: number;
    readonly name: string;
    readonly driverToken?: string;
  }>,
): ReadonlyMap<string, GuardElement> => {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const entry of entries) {
    const index = natural(entry.element_index);
    if (index !== undefined) byIndex.set(index, entry);
  }
  const rowByToken = new Map<string, { readonly index?: number; readonly name: string }>();
  for (const row of rows) {
    if (row.driverToken !== undefined) rowByToken.set(row.driverToken, row);
  }
  const map = new Map<string, GuardElement>();
  for (const entry of entries) {
    const token = string(entry.element_token);
    if (!token) continue;
    const role = string(entry.role) ?? "unknown";
    const bare = bareRole(role);
    const editable = entry.editable === true || entry.settable === true;
    let inTable = bare === "cell";
    let cursor: Record<string, unknown> | undefined = entry;
    for (let hop = 0; !inTable && hop < 4 && cursor !== undefined; hop++) {
      const parentIdx = natural(cursor.parent_index);
      cursor = parentIdx === undefined ? undefined : byIndex.get(parentIdx);
      if (cursor !== undefined && TABLE_ANCESTOR_ROLES.has(bareRole(string(cursor.role) ?? "")))
        inTable = true;
    }
    const row = rowByToken.get(token);
    const index = row?.index ?? natural(entry.element_index);
    const rawLabel = string(entry.label) ?? "";
    map.set(token, {
      ...(index === undefined ? {} : { index }),
      role,
      name: row?.name ?? rawLabel,
      rawLabel,
      description: string(entry.description) ?? string(entry.value_description) ?? "",
      placeholder: string(entry.placeholder) ?? "",
      identifier: string(entry.identifier) ?? "",
      editable,
      tableCell: TABLE_CELL_ROLES.has(bare) && !editable && inTable,
    });
  }
  return map;
};

const chatAppName = (appId: string, bundleId?: string): string | undefined => {
  const byBundle = bundleId ? SEND_ON_ENTER[bundleId.toLowerCase()] : undefined;
  if (byBundle !== undefined) return byBundle;
  const byId = SEND_ON_ENTER[appId.toLowerCase()];
  if (byId !== undefined) return byId;
  for (const label of Object.values(SEND_ON_ENTER))
    if (label.toLowerCase() === appId.trim().toLowerCase()) return label;
  return undefined;
};

const isPasteLabel = (label: string) => PASTE_MENU_LABELS.has(label.trim().toLowerCase());

const isPasteMenuItem = (element: GuardElement | undefined) =>
  element !== undefined &&
  bareRole(element.role) === "menuitem" &&
  (isPasteLabel(element.name) || isPasteLabel(element.rawLabel));

const isNonComposer = (element: GuardElement | undefined): boolean => {
  if (element === undefined) return false;
  const bare = bareRole(element.role);
  if (bare === "searchfield") return true;
  if (bare !== "textfield" && bare !== "textarea") return false;
  const combined = [
    element.name,
    element.rawLabel,
    element.description,
    element.placeholder,
    element.identifier,
  ]
    .join(" ")
    .toLowerCase();
  return SEARCH_HINTS.some((hint) => combined.includes(hint));
};

const isSendButton = (element: GuardElement | undefined): boolean => {
  if (element === undefined || bareRole(element.role) !== "button") return false;
  const labels = [element.name, element.rawLabel, element.description]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (labels.length === 0) return true;
  const combined = [...labels, element.identifier].join(" ").toLowerCase();
  return SEND_HINTS.some((hint) => combined.includes(hint));
};

const isSendMenuPath = (path: unknown): boolean => {
  if (!Array.isArray(path) || path.length === 0) return false;
  const last = typeof path.at(-1) === "string" ? String(path.at(-1)).trim().toLowerCase() : "";
  return SEND_HINTS.some((hint) => last.includes(hint));
};

const hasControlCharacter = (text: unknown): boolean =>
  typeof text === "string" && /[\u0000-\u001f\u007f]/.test(text);

const sendPolicy = (input: {
  readonly chatApp: string;
  readonly method: string;
  readonly args: Record<string, unknown>;
  readonly elementToken?: string;
  readonly element?: GuardElement;
  readonly aimed: boolean;
}): "allow" | "refuse_unaddressed" | "refuse_send" | "refuse_point" => {
  const { method, args, elementToken, element, aimed } = input;
  const send = args.send === true;
  if ((method === "click" || method === "right_click") && elementToken === undefined && aimed)
    return "refuse_point";
  const resolvedKey =
    method === "press_key" || method === "hotkey" ? resolveKeyPress(args) : undefined;
  const isEnter = resolvedKey?.key === "enter";
  if (elementToken === undefined && (method === "type_text" || isEnter))
    return "refuse_unaddressed";
  if (method === "press_key" && elementToken !== undefined && isEnter && !isNonComposer(element))
    return send ? "allow" : "refuse_send";
  if (method === "type_text" && elementToken !== undefined && hasControlCharacter(args.text))
    return send ? "allow" : "refuse_send";
  if ((method === "click" || method === "right_click") && isSendButton(element))
    return send ? "allow" : "refuse_send";
  if (method === "invoke_menu" && isSendMenuPath(args.path)) return send ? "allow" : "refuse_send";
  return "allow";
};

const hasVisibleClickBounds = (
  placed: Placed | undefined,
  windowBounds: Rect | undefined,
): boolean => {
  if (placed === undefined) return true;
  const { frame } = placed;
  if (frame.w <= 0 || frame.h <= 0) return false;
  const win = placed.window ?? windowBounds;
  if (win === undefined || win.w <= 0 || win.h <= 0) return true;
  return (
    frame.x + frame.w > win.x &&
    frame.x < win.x + win.w &&
    frame.y + frame.h > win.y &&
    frame.y < win.y + win.h
  );
};

const PASTE_REFUSAL =
  "Paste would insert the person's clipboard. Insert text with type(text, N); it restores the clipboard.";

/** Checks one desktop input call before dispatch and returns its refusal or table-cell click state. */
export const admitDesktopInput = (input: {
  readonly method: string;
  readonly args: Record<string, unknown>;
  readonly appId: string;
  readonly bundleId?: string;
  readonly elementToken?: string;
  readonly element?: GuardElement;
  readonly placed?: Placed;
  readonly windowBounds?: Rect;
  readonly lastClickedTableCell?: number | string;
}): {
  readonly refused?: ScreenRunError;
  readonly clickedTableCell?: number | string;
  readonly clearClickedTableCell?: boolean;
} => {
  const { method, args, elementToken, element, placed, windowBounds, lastClickedTableCell } = input;
  if (isPasteMenuItem(element)) return { refused: fail("permission_denied", PASTE_REFUSAL) };
  if (method === "press_key" || method === "hotkey") {
    const resolved = resolveKeyPress(args);
    if (resolved.key === "v" && resolved.modifiers.has("cmd"))
      return { refused: fail("permission_denied", PASTE_REFUSAL) };
  }
  if (method === "invoke_menu" && Array.isArray(args.path) && args.path.length > 0) {
    const last = typeof args.path.at(-1) === "string" ? String(args.path.at(-1)) : "";
    if (isPasteLabel(last)) return { refused: fail("permission_denied", PASTE_REFUSAL) };
  }
  if (
    (method === "click" || method === "right_click") &&
    elementToken !== undefined &&
    !hasVisibleClickBounds(placed, windowBounds)
  ) {
    const label = element?.index ?? elementToken;
    return {
      refused: fail(
        "invalid_argument",
        `Element ${label} has no visible click bounds; scroll it into view (scroll(${label})) or observe again.`,
      ),
    };
  }
  if (method === "type_text") {
    const cellLabel =
      element?.tableCell === true
        ? (element.index ?? elementToken)
        : elementToken === undefined
          ? lastClickedTableCell
          : undefined;
    if (cellLabel !== undefined)
      return {
        refused: fail(
          "invalid_argument",
          `Element ${cellLabel} is a cell in a list or table; typing would send keys to the list. Use setValue(${cellLabel}, value) to change it (it renames a Finder item).`,
        ),
      };
  }
  const chatApp = chatAppName(input.appId, input.bundleId);
  if (chatApp !== undefined) {
    const aimed = ["x", "y", "from_x", "from_y", "to_x", "to_y"].some(
      (key) => key in args || key in (object(args.point) ?? {}),
    );
    const decision = sendPolicy({
      chatApp,
      method,
      args,
      ...(elementToken === undefined ? {} : { elementToken }),
      ...(element === undefined ? {} : { element }),
      aimed,
    });
    if (decision === "refuse_point")
      return {
        refused: fail(
          "invalid_argument",
          `Use element numbers in ${chatApp}; a point cannot be checked for a send button.`,
        ),
      };
    if (decision === "refuse_unaddressed")
      return {
        refused: fail(
          "invalid_argument",
          `In ${chatApp}, keys without a target go to whatever has focus, often the message field. Name the field.`,
        ),
      };
    if (decision === "refuse_send")
      return {
        refused: fail(
          "permission_denied",
          `This can send a message in ${chatApp}. If the person asked you to send it, call it again with { send: true }; otherwise leave the text in the field and tell them it is ready.`,
        ),
      };
  }
  if ((method === "click" || method === "right_click") && element?.tableCell === true)
    return { clickedTableCell: element.index ?? elementToken ?? 0 };
  return { clearClickedTableCell: true };
};
