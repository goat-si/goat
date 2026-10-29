/**
 * Pre-dispatch safety guards for desktop app input: canonical key and modifier resolution,
 * table-cell typing refusal, send-on-Enter chat policy, recognized clipboard-paste refusal,
 * visible click bounds, and standard outcome sentences.
 */
import * as Exit from "effect/Exit";
import type { ScreenHostCall, ScreenRunError } from "@goat/contracts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";
import { fail } from "./DesktopDriverReplies.ts";
import type { Placed, Rect } from "./DesktopFrames.ts";

interface DragEndpointGuard {
  readonly elementToken?: string;
  readonly element?: GuardElement;
  readonly placed?: Placed;
  readonly aimed: boolean;
}

export interface GuardElement {
  readonly index?: number;
  readonly role: string;
  readonly name: string;
  readonly rawLabel: string;
  /** Label excluding any fallback to the element's current value (title/description only). */
  readonly nonValueLabel: string;
  readonly description: string;
  readonly placeholder: string;
  readonly identifier: string;
  readonly editable: boolean;
  readonly tableCell: boolean;
  readonly menuSurface: boolean;
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
const MENU_ROLES: ReadonlySet<string> = new Set([
  "menu",
  "menuitem",
  "menubar",
  "menubarextra",
  "menubaritem",
  "statusitem",
]);
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
  if (key === " ") return "space";
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
  if (rawKey === " ") return { key: "space", modifiers };
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
    let inMenu = MENU_ROLES.has(bare);
    let menuCursor: Record<string, unknown> | undefined = entry;
    for (let hop = 0; !inMenu && hop < 8 && menuCursor !== undefined; hop++) {
      const parentIdx = natural(menuCursor.parent_index);
      menuCursor = parentIdx === undefined ? undefined : byIndex.get(parentIdx);
      if (menuCursor !== undefined && MENU_ROLES.has(bareRole(string(menuCursor.role) ?? "")))
        inMenu = true;
    }
    const row = rowByToken.get(token);
    const index = row?.index ?? natural(entry.element_index);
    const rawLabel = string(entry.label) ?? "";
    const rawValue = typeof entry.value === "string" ? entry.value : undefined;
    const rawValueDesc = string(entry.value_description);
    // cua-driver's element_entry falls back label = title ?? description ?? value ?? identifier;
    // when label equals value or value_description and no separate title is given, rawLabel may
    // come from the field's value, so exclude it from search-field identity.
    const explicitTitle = string(entry.title);
    const nonValueLabel =
      explicitTitle ??
      ((rawValue !== undefined && rawLabel === rawValue) ||
      (rawValueDesc !== undefined && rawLabel === rawValueDesc)
        ? ""
        : rawLabel);
    map.set(token, {
      ...(index === undefined ? {} : { index }),
      role,
      name: row?.name ?? rawLabel,
      rawLabel,
      nonValueLabel,
      description: string(entry.description) ?? "",
      placeholder: string(entry.placeholder) ?? "",
      identifier: string(entry.identifier) ?? "",
      editable,
      tableCell: TABLE_CELL_ROLES.has(bare) && !editable && inTable,
      menuSurface: inMenu,
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
  // Never match against the element's current value or tree-text fallback, since a user or agent
  // message inside an unlabeled composer can contain the word "search".
  const combined = [
    element.nonValueLabel,
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
  readonly dragEndpoints?: ReadonlyArray<DragEndpointGuard>;
}): "allow" | "refuse_unaddressed" | "refuse_send" | "refuse_point" => {
  const { method, args, elementToken, element, aimed, dragEndpoints } = input;
  const send = args.send === true;
  if ((method === "click" || method === "right_click") && elementToken === undefined && aimed)
    return "refuse_point";
  // Drag delivers coordinate pointer gestures rather than AX element actions: if an endpoint
  // names or overlaps a Send button without send: true, report refuse_send; otherwise refuse_point.
  if (method === "drag") {
    if (!send && dragEndpoints?.some((end) => isSendButton(end.element))) return "refuse_send";
    return "refuse_point";
  }
  const resolvedKey =
    method === "press_key" || method === "hotkey" ? resolveKeyPress(args) : undefined;
  const isEnter = resolvedKey?.key === "enter";
  const isButtonActivationKey = isEnter || resolvedKey?.key === "space" || resolvedKey?.key === " ";
  if (elementToken === undefined && (method === "type_text" || isEnter))
    return "refuse_unaddressed";
  if (isSendButton(element)) {
    if (
      method === "click" ||
      method === "right_click" ||
      ((method === "press_key" || method === "hotkey") && isButtonActivationKey)
    )
      return send ? "allow" : "refuse_send";
  }
  if (method === "press_key" && elementToken !== undefined && isEnter && !isNonComposer(element))
    return send ? "allow" : "refuse_send";
  if (method === "type_text" && elementToken !== undefined && hasControlCharacter(args.text))
    return send ? "allow" : "refuse_send";
  if (method === "invoke_menu" && isSendMenuPath(args.path)) return send ? "allow" : "refuse_send";
  return "allow";
};

const hasVisibleClickBounds = (
  placed: Placed | undefined,
  windowBounds: Rect | undefined,
  element: GuardElement | undefined,
): boolean => {
  if (placed === undefined) return true;
  const { frame } = placed;
  if (frame.w <= 0 || frame.h <= 0) return false;
  // Open menus and menu-bar items are rendered in their own screen-space popups and can extend
  // outside the bound window's rectangle while remaining actionable through AX.
  if (element?.menuSurface === true) return true;
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
  readonly dragEndpoints?: ReadonlyArray<DragEndpointGuard>;
}): {
  readonly refused?: ScreenRunError;
  readonly clickedTableCell?: number | string;
  readonly clearClickedTableCell?: boolean;
} => {
  const {
    method,
    args,
    elementToken,
    element,
    placed,
    windowBounds,
    lastClickedTableCell,
    dragEndpoints,
  } = input;
  if (method === "type_text" && args.replace === true && elementToken === undefined)
    return {
      refused: fail(
        "invalid_argument",
        "replace: true requires a target element; name the field to replace.",
      ),
    };
  if (
    isPasteMenuItem(element) ||
    dragEndpoints?.some((end) => isPasteMenuItem(end.element)) === true
  )
    return { refused: fail("permission_denied", PASTE_REFUSAL) };
  if (dragEndpoints !== undefined) {
    for (const end of dragEndpoints) {
      if (
        end.elementToken !== undefined &&
        !hasVisibleClickBounds(end.placed, windowBounds, end.element)
      ) {
        const label = end.element?.index ?? end.elementToken;
        return {
          refused: fail(
            "invalid_argument",
            `Element ${label} has no visible click bounds; scroll it into view (scroll(${label})) or observe again.`,
          ),
        };
      }
    }
  }
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
    !hasVisibleClickBounds(placed, windowBounds, element)
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
      ...(dragEndpoints === undefined ? {} : { dragEndpoints }),
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
  if (
    elementToken !== undefined &&
    element?.tableCell !== true &&
    ["click", "right_click", "press_key", "type_text", "set_value"].includes(method)
  )
    return { clearClickedTableCell: true };
  return {};
};

export const BATCH_FAILED_CATEGORIES: ReadonlySet<ScreenHostDispatchResult["category"]> = new Set([
  "partial",
  "suspected_noop",
  "refused",
]);

const batchNotRun = (callId: number, haltedBy: number): ScreenRunError => ({
  ...fail(
    "not_run",
    `Call ${haltedBy} in this cell failed, so this call did not run. Observe in a new cell before acting again.`,
  ),
  callId,
});

/**
 * Preflights every member of a desktop batch before any member is sent to the driver; returns
 * per-member failure exits when any member is refused, or undefined when all members may run.
 */
export const preflightDesktopBatch = (
  calls: ReadonlyArray<ScreenHostCall>,
  inspect: (call: ScreenHostCall) =>
    | {
        readonly ok: true;
        readonly args: Record<string, unknown>;
        readonly appId: string;
        readonly bundleId?: string;
        readonly elementToken?: string;
        readonly element?: GuardElement;
        readonly placed?: Placed;
        readonly windowBounds?: Rect;
        readonly lastClickedTableCell?: number | string;
        readonly dragEndpoints?: ReadonlyArray<DragEndpointGuard>;
      }
    | { readonly ok: false; readonly error: ScreenRunError },
): ReadonlyArray<Exit.Exit<ScreenHostDispatchResult, ScreenRunError>> | undefined => {
  let simulatedTableCell: number | string | undefined;
  let initialized = false;
  const abortAt = (index: number, error: ScreenRunError) => {
    const haltedBy = calls[index]?.callId ?? 0;
    return calls.map((member, i) =>
      Exit.fail(i === index ? error : batchNotRun(member.callId, haltedBy)),
    );
  };
  for (const [index, call] of calls.entries()) {
    const checked = inspect(call);
    if (!checked.ok) return abortAt(index, checked.error);
    if (!initialized) {
      simulatedTableCell = checked.lastClickedTableCell;
      initialized = true;
    }
    const admission = admitDesktopInput({
      method: call.method,
      args: checked.args,
      appId: checked.appId,
      ...(checked.bundleId === undefined ? {} : { bundleId: checked.bundleId }),
      ...(checked.elementToken === undefined ? {} : { elementToken: checked.elementToken }),
      ...(checked.element === undefined ? {} : { element: checked.element }),
      ...(checked.placed === undefined ? {} : { placed: checked.placed }),
      ...(checked.windowBounds === undefined ? {} : { windowBounds: checked.windowBounds }),
      ...(simulatedTableCell === undefined ? {} : { lastClickedTableCell: simulatedTableCell }),
      ...(checked.dragEndpoints === undefined ? {} : { dragEndpoints: checked.dragEndpoints }),
    });
    if (admission.refused !== undefined) return abortAt(index, admission.refused);
    // Preflight runs before the driver confirms any step's focus move, so a table-cell click in a
    // batch keeps its risk for later unaddressed typing in the same batch.
    if (admission.clickedTableCell !== undefined) simulatedTableCell = admission.clickedTableCell;
  }
  return undefined;
};

/** Extracts drag endpoint guard metadata from a drag call's fromEnd and toEnd arguments. */
const resolveDragEndpointGuards = (
  args: Record<string, unknown>,
  resolveToken: (el: Record<string, unknown>) => string | undefined,
  elementsByToken: ReadonlyMap<string, GuardElement> | undefined,
  frames: ReadonlyMap<string, Placed> | undefined,
):
  | { readonly ok: true; readonly endpoints?: ReadonlyArray<DragEndpointGuard> }
  | { readonly ok: false; readonly error: ScreenRunError } => {
  if (args.fromEnd === undefined && args.toEnd === undefined) return { ok: true };
  const endpoints: DragEndpointGuard[] = [];
  for (const raw of [args.fromEnd, args.toEnd]) {
    const end = object(raw);
    if (!end) return { ok: false, error: fail("invalid_argument") };
    const elObj = object(end.elementRef);
    if (elObj !== undefined) {
      const token = resolveToken(elObj);
      if (!token) return { ok: false, error: fail("stale_reference") };
      const element = elementsByToken?.get(token);
      const placed = frames?.get(token);
      endpoints.push({
        elementToken: token,
        ...(element === undefined ? {} : { element }),
        ...(placed === undefined ? {} : { placed }),
        aimed: false,
      });
      if (placed !== undefined && frames !== undefined && elementsByToken !== undefined) {
        const cx = placed.frame.x + placed.frame.w / 2;
        const cy = placed.frame.y + placed.frame.h / 2;
        for (const [otherToken, otherPlaced] of frames) {
          if (otherToken === token) continue;
          const { frame } = otherPlaced;
          if (
            frame.w > 0 &&
            frame.h > 0 &&
            cx >= frame.x &&
            cx <= frame.x + frame.w &&
            cy >= frame.y &&
            cy <= frame.y + frame.h
          ) {
            const otherEl = elementsByToken.get(otherToken);
            if (otherEl !== undefined)
              endpoints.push({
                elementToken: otherToken,
                element: otherEl,
                placed: otherPlaced,
                aimed: false,
              });
          }
        }
      }
    } else {
      endpoints.push({ aimed: "x" in end || "y" in end });
    }
  }
  return { ok: true, endpoints };
};

/** Builds the admission input for a bound window's action call, including drag endpoints. */
export const buildGuardInput = (
  method: string,
  args: Record<string, unknown>,
  bound: {
    readonly appId: string;
    readonly bundleId?: string;
    readonly elementsByToken?: ReadonlyMap<string, GuardElement>;
    readonly frames?: ReadonlyMap<string, Placed>;
    readonly framesBasis?: Rect;
    readonly windowBounds?: Rect;
    readonly lastClickedTableCell?: number | string;
  },
  elementToken: string | undefined,
  resolveToken: (el: Record<string, unknown>) => string | undefined,
):
  | { readonly ok: true; readonly input: Parameters<typeof admitDesktopInput>[0] }
  | { readonly ok: false; readonly error: ScreenRunError } => {
  const dragRes =
    method === "drag"
      ? resolveDragEndpointGuards(args, resolveToken, bound.elementsByToken, bound.frames)
      : { ok: true as const };
  if (!dragRes.ok) return dragRes;
  const guardElement =
    elementToken === undefined ? undefined : bound.elementsByToken?.get(elementToken);
  const placed = elementToken === undefined ? undefined : bound.frames?.get(elementToken);
  const windowBounds = bound.framesBasis ?? bound.windowBounds;
  return {
    ok: true,
    input: {
      method,
      args,
      appId: bound.appId,
      ...(bound.bundleId === undefined ? {} : { bundleId: bound.bundleId }),
      ...(elementToken === undefined ? {} : { elementToken }),
      ...(guardElement === undefined ? {} : { element: guardElement }),
      ...(placed === undefined ? {} : { placed }),
      ...(windowBounds === undefined ? {} : { windowBounds }),
      ...(bound.lastClickedTableCell === undefined
        ? {}
        : { lastClickedTableCell: bound.lastClickedTableCell }),
      ...(dragRes.endpoints === undefined ? {} : { dragEndpoints: dragRes.endpoints }),
    },
  };
};
