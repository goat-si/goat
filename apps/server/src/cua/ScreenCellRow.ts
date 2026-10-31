/**
 * The one-line title and outcome of a screen cell's timeline row, from facts the server saw while
 * the cell ran. Only a fixed verb vocabulary, shortcut labels, app names and registrable domains
 * reach it: never typed text, values, window or element names, URL paths, or the cell's source.
 *
 * @module ScreenCellRow
 */
import type { ScreenEffectReceipt, ScreenMethod } from "@goat/contracts";

export type ScreenCellEnd = "completed" | "failed" | "stopped" | "deadline" | "limit" | "unknown";

const TITLE_MAX = 160;
export const INPUT_TITLE_MAX = 80;
const APP_NAME_MAX = 40;

const NAMED_KEYS = new Map(
  [
    "Enter",
    "Return",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "Space",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  ].map((name) => [name.toLowerCase(), name]),
);
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "Escape",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  " ": "Space",
};
// Tabs name modifiers as DOM keys, apps as the driver's words (ScreenTargetPrelude __keys).
const MODIFIERS: Readonly<Record<string, string>> = {
  meta: "cmd",
  command: "cmd",
  cmd: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};
const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"];

/**
 * How a key press is named on its row, or undefined when it could be text: a named key with any
 * modifiers, or one character only with cmd or ctrl and no alt (shift+a and option+e type text).
 */
export function shortcutLabel(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const { key, modifiers } = arg as { readonly key?: unknown; readonly modifiers?: unknown };
  if (typeof key !== "string" || key.length === 0 || key.length > 16) return undefined;
  const mods = new Set<string>();
  for (const raw of Array.isArray(modifiers) ? modifiers : []) {
    const mod = typeof raw === "string" ? MODIFIERS[raw.toLowerCase()] : undefined;
    if (mod === undefined) return undefined;
    mods.add(mod);
  }
  const prefix = MODIFIER_ORDER.filter((mod) => mods.has(mod));
  const named = KEY_ALIASES[key.toLowerCase()] ?? NAMED_KEYS.get(key.toLowerCase());
  if (named !== undefined) return [...prefix, named].join("+");
  const shortcut =
    /^[\x21-\x7e]$/u.test(key) && (mods.has("cmd") || mods.has("ctrl")) && !mods.has("alt");
  return shortcut ? [...prefix, key.toLowerCase()].join("+") : undefined;
}

// TLDs whose names are registered at the second level, so their last two labels are a
// registrable domain (or a public suffix) and never a subdomain someone made up.
const SECOND_LEVEL_TLDS = new Set(
  "com org net io dev app ai co me xyz info edu gov de fr nl ch se no fi dk it es pl cz ca us eu".split(
    " ",
  ),
);

/** The page a tab showed, as its registrable domain; anything not provably one is a "web page". */
export function siteSubject(pageUrl: string): string {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  } catch {
    return "web page";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return "localhost";
  if (/^127(?:\.\d{1,3}){3}$/u.test(host)) return "localhost";
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return "web page";
  const labels = host.split(".").filter((label) => label.length > 0);
  const tld = labels.at(-1);
  return labels.length >= 2 && tld !== undefined && SECOND_LEVEL_TLDS.has(tld)
    ? labels.slice(-2).join(".")
    : "web page";
}

/** An app as its row names it: its display name on one line, or "app". */
export function appSubject(label: {
  readonly bundleId?: string | undefined;
  readonly name?: string | undefined;
}): string {
  const name = (label.name ?? label.bundleId ?? "").replace(/\s+/gu, " ").trim();
  if (name.length === 0 || /[\u0000-\u001f\u007f-\u009f\\/]/u.test(name)) return "app";
  return name.length > APP_NAME_MAX ? `${name.slice(0, APP_NAME_MAX - 1)}…` : name;
}

/**
 * A one-line agent title with something to show: no line or paragraph separator of any kind.
 * Plain ECMA syntax, since providers check the advertised JSON Schema pattern themselves.
 */
export const INPUT_TITLE =
  /^[^\n\v\f\r\u0085\u2028\u2029]*[^\s\u0085][^\n\v\f\r\u0085\u2028\u2029]*$/u;

/** The title an agent gave a cell: one line, at most 80 characters, not only spaces. */
export function inputTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= INPUT_TITLE_MAX && INPUT_TITLE.test(value)
    ? value.trim()
    : undefined;
}

type Verb = string | "observe" | null;
const VERBS: Readonly<Record<ScreenMethod, Verb>> = {
  list_apps: "observe",
  list_windows: "observe",
  list_menu_bar_extras: "observe",
  bind_app: null,
  get_window_state: "observe",
  get_accessibility_tree: "observe",
  verify_state: "observe",
  screenshot: "observe",
  click: "click",
  right_click: "right-click",
  hover: "hover",
  drag: "drag",
  scroll: "scroll",
  type_text: "type",
  press_key: "press key",
  set_value: "set value",
  bring_to_front: "focus",
  launch_app: "launch",
  end_foreground: null,
  list_tabs: "observe",
  select_tab: null,
  open_tab: "open",
  claim_tab: null,
  keep_tab: null,
  navigate_tab: "open",
  reload_tab: "reload",
  back_tab: "back",
  forward_tab: "forward",
  close_tab: "close tab",
  observe: "observe",
  tab_status: "observe",
  read_page: "observe",
  select: "select",
  select_text: "select text",
  wait_for: "observe",
  invoke_menu: "menu",
  fetch_tab: "fetch",
  tab_dialog: "dialog",
  tab_upload: "upload",
  tab_evaluate: "evaluate",
  tab_fill_secret: "fill secret",
  tab_logs: "observe",
};

const CATEGORIES: ReadonlyArray<readonly [ScreenEffectReceipt["category"], string]> = [
  ["confirmed", "confirmed"],
  ["partial", "partial"],
  ["unverifiable", "unverifiable"],
  ["suspected_noop", "no-op"],
  ["refused", "refused"],
  ["unknown_outcome", "unknown"],
];

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;
const duration = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : seconds(ms));

export interface ScreenCellFacts {
  readonly receipts: ReadonlyArray<
    Pick<ScreenEffectReceipt, "callId" | "method" | "category" | "observedEffect">
  >;
  /** Shortcut labels of the cell's key presses, by call id. */
  readonly keys: ReadonlyMap<number, string>;
  /** Safe subjects in first-use order, and how many distinct ones the cell touched. */
  readonly subjects: readonly string[];
  readonly subjectCount: number;
  readonly end: ScreenCellEnd;
  readonly wallMs: number;
  readonly durationMs: number;
}

const endTag = (facts: ScreenCellFacts) => {
  switch (facts.end) {
    case "completed":
      return undefined;
    case "deadline":
      return `deadline ${seconds(facts.wallMs)}`;
    case "unknown":
      return "unknown outcome";
    default:
      return facts.end;
  }
};

/** A cell's row title, `<subjects> · <actions>[ · <tags>]`, or none when it named nothing. */
export function screenCellTitle(facts: ScreenCellFacts): string | undefined {
  const counts = new Map<string, number>();
  let observed = false;
  for (const receipt of facts.receipts) {
    const verb =
      receipt.method === "press_key"
        ? (() => {
            const label = facts.keys.get(receipt.callId);
            return label === undefined ? "press key" : `press ${label}`;
          })()
        : VERBS[receipt.method];
    if (verb === "observe") observed = true;
    else if (verb !== null) counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const verbs = [...counts].slice(0, 3).map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb));
  const actions = verbs.length > 0 ? verbs.join(", ") : observed ? "observe" : undefined;
  const refused = facts.receipts.filter((receipt) => receipt.category === "refused").length;
  const tags = [endTag(facts), refused > 0 ? `${refused} refused` : undefined].filter(
    (tag) => tag !== undefined,
  );
  const compose = (subjects: string | undefined) =>
    [subjects, actions, ...tags].filter((part) => part !== undefined).join(" · ");
  if (facts.subjects.length === 0 && actions === undefined) return undefined;
  const more = (shown: number) =>
    facts.subjectCount > shown ? ` +${facts.subjectCount - shown}` : "";
  const full = compose(
    facts.subjects.length === 0
      ? undefined
      : `${facts.subjects.slice(0, 2).join(" + ")}${more(Math.min(2, facts.subjects.length))}`,
  );
  if (full.length <= TITLE_MAX) return full;
  const short = compose(
    facts.subjects[0] === undefined ? undefined : `${facts.subjects[0]}${more(1)}`,
  );
  return short.length <= TITLE_MAX ? short : `${short.slice(0, TITLE_MAX - 1)}…`;
}

/** Every receipt by outcome, zeros left out, then how long the cell took. */
export function screenCellSummary(facts: ScreenCellFacts): string {
  const parts = CATEGORIES.flatMap(([category, label]) => {
    const n = facts.receipts.filter((receipt) => receipt.category === category).length;
    return n > 0 ? [`${n} ${label}`] : [];
  });
  for (const [state, label] of [
    ["change_seen", "window change seen"],
    ["no_change_seen", "no window change seen"],
  ] as const) {
    const n = facts.receipts.filter((receipt) => receipt.observedEffect?.state === state).length;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return [...parts, duration(facts.durationMs)].join(" · ");
}
