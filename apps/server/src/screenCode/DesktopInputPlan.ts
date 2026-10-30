import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { admitDesktopInput, buildGuardInput, resolveKeyPress } from "./DesktopInputGuards.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
/**
 * Desktop input argument planning, named AX action validation, waitFor expectation building, and
 * following the Go to Folder sheet a key or menu input opens as a window of its own.
 */
import type {
  ComputerUsePrimitiveReply,
  ScreenObservation,
  ScreenRunError,
  ScreenHostCall,
  ScreenTargetRef,
} from "@goat/contracts";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import { spansLines } from "./DesktopTreeText.ts";
import type { Rect } from "./DesktopFrames.ts";
import {
  checkWindowReplyState,
  parseWindowList,
  sheetParentId,
  type CellWindowTracker,
  type SheetTrigger,
  type SheetWindowEntry,
} from "./DesktopWindows.ts";
import type { DesktopRow } from "./DesktopObserveRead.ts";
import { applyDesktopPointerArgs, pointerStateFor } from "./DesktopTargetPoints.ts";

const ACTION_TO_AX: Readonly<Record<string, string>> = {
  press: "AXPress",
  show_menu: "AXShowMenu",
  pick: "AXPick",
  confirm: "AXConfirm",
  cancel: "AXCancel",
  open: "AXOpen",
  show_alternate_ui: "AXShowAlternateUI",
  show_default_ui: "AXShowDefaultUI",
};
const AX_TO_ACTION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ACTION_TO_AX).map(([k, v]) => [v.toLowerCase(), k]),
);

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const GOTO_FOLDER = /^(go to folder|폴더로 이동)$/i;
/** Finder's and the Open panel's Go to Folder: cmd+shift+g with no target, or the Go menu item. */
const opensGotoSheet = (method: string, args: Record<string, unknown>): boolean => {
  if (method === "invoke_menu") {
    const last = Array.isArray(args.path) ? args.path.at(-1) : undefined;
    return typeof last === "string" && GOTO_FOLDER.test(last.trim().replace(/(…|\.\.\.)$/, ""));
  }
  if (method !== "press_key" && method !== "hotkey") return false;
  if (["elementRef", "x", "y", "point"].some((key) => key in args)) return false;
  const { key, modifiers } = resolveKeyPress(args);
  return key === "g" && modifiers.size === 2 && modifiers.has("cmd") && modifiers.has("shift");
};

/** Records an admitted input: a Go to Folder input arms a trigger, any other input drops it. */
const noteAdmittedInput = (
  bound: BoundWindow,
  method: string,
  args: Record<string, unknown>,
  tracker: CellWindowTracker | undefined,
) => {
  if (!tracker) return;
  tracker.noteInput(bound.pid, bound.ref.id);
  if (!opensGotoSheet(method, args)) {
    delete bound.sheetTrigger;
    return;
  }
  const trigger: SheetTrigger = { targetId: bound.ref.id };
  bound.sheetTrigger = trigger;
  tracker.armSheetTrigger(bound.pid, trigger);
};

const validateNamedAction = (
  requested: unknown,
  row: DesktopRow | undefined,
): { readonly action?: string; readonly error?: ScreenRunError } => {
  if (requested === undefined) return {};
  const name = typeof requested === "string" ? requested.trim() : "";
  const ax = ACTION_TO_AX[name];
  const offered = (row?.rawActions ?? row?.actions ?? []).flatMap((a) => {
    const mapped = AX_TO_ACTION[a.toLowerCase()] ?? (ACTION_TO_AX[a] ? a : undefined);
    return mapped === undefined ? [] : [mapped];
  });
  if (!ax || !offered.includes(name)) {
    const list = offered.length > 0 ? offered.join(", ") : "none";
    return {
      error: fail(
        "invalid_argument",
        `Action ${JSON.stringify(requested)} is not offered by this element (mapped actions: ${list}).`,
      ),
    };
  }
  return { action: name };
};

export const INPUT_METHODS: ReadonlySet<string> = new Set([
  "click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "launch_app",
]);

// Inputs the macOS driver can return from without its 120 ms watch for a new window, menu or
// dialog: the next observe owns settling, and the driver reports a later change on its next result.
const NO_WINDOW_WATCH: ReadonlySet<string> = new Set([
  "click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
]);

/** The input's driver arguments with post_action_wait "none", unless the call asked to verify. */
export const withoutWindowWatch = (
  method: string,
  forwarded: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> =>
  NO_WINDOW_WATCH.has(method) && args.verify !== true
    ? { ...forwarded, post_action_wait: "none" }
    : forwarded;

const buildForwardedInput = (
  method: string,
  args: Record<string, unknown>,
  bound: { readonly pid: number; readonly windowId: number; readonly appId: string },
  elementToken: string | undefined,
  action: string | undefined,
): Record<string, unknown> => {
  const target = { kind: "window", pid: bound.pid, window_id: bound.windowId };
  const forwarded: Record<string, unknown> = { ...args, target, delivery_mode: "background" };
  delete forwarded.elementRef;
  delete forwarded.send;
  delete forwarded.verify;
  delete forwarded.replace;
  delete forwarded.targetRef;
  delete forwarded.element_token;
  delete forwarded.pid;
  delete forwarded.window_id;
  if (action !== undefined) forwarded.action = action;
  if (elementToken) forwarded.element_token = elementToken;
  if (method === "bring_to_front") {
    delete forwarded.delivery_mode;
    forwarded.pid = bound.pid;
    forwarded.window_id = bound.windowId;
  }
  if (method === "launch_app") {
    delete forwarded.delivery_mode;
    delete forwarded.target;
    forwarded.bundle_id = bound.appId;
  }
  if (method === "set_value" || method === "right_click") {
    delete forwarded.target;
    if (method === "set_value") delete forwarded.delivery_mode;
    forwarded.pid = bound.pid;
    if (elementToken === undefined) forwarded.window_id = bound.windowId;
  }
  return forwarded;
};

export const buildWaitExpectation = (
  args: Record<string, unknown>,
): { readonly expectation?: Record<string, unknown>; readonly error?: ScreenRunError } => {
  const window = args.window === "exists" || args.window === "gone" ? args.window : undefined;
  const role = string(args.role);
  const name = string(args.name);
  const value = typeof args.value === "string" ? args.value : undefined;
  const hasValue = value !== undefined && value.trim().length > 0;
  const enabled = typeof args.enabled === "boolean" ? args.enabled : undefined;
  const selected = typeof args.selected === "boolean" ? args.selected : undefined;
  if (
    window === undefined &&
    role === undefined &&
    name === undefined &&
    !hasValue &&
    enabled === undefined &&
    selected === undefined
  )
    return {
      error: fail(
        "invalid_argument",
        "Wait for {role?, name?, value?, enabled?, selected?} or {window}.",
      ),
    };
  return {
    expectation:
      window === undefined
        ? {
            element: {
              selector: {
                ...(role === undefined ? {} : { role }),
                ...(name === undefined ? {} : { label_contains: name }),
              },
              exists: true,
              ...(value === undefined ? {} : { value_equals: value }),
              ...(enabled === undefined ? {} : { enabled }),
              ...(selected === undefined ? {} : { selected }),
            },
          }
        : { window: { exists: window === "exists" } },
  };
};

export const validateMenuInput = (
  menuArgs: Record<string, unknown>,
  bound: BoundWindow,
  tracker?: CellWindowTracker,
): { readonly path?: ReadonlyArray<string>; readonly error?: ScreenRunError } => {
  const raw = Array.isArray(menuArgs.path) ? menuArgs.path : [];
  if (
    raw.length === 0 ||
    raw.length > 16 ||
    !raw.every((label): label is string => typeof label === "string" && label.trim().length > 0)
  )
    return {
      error: fail("invalid_argument", "Name the menu path, such as ['File', 'Open…']."),
    };
  const admission = admitDesktopInput({
    method: "invoke_menu",
    args: menuArgs,
    appId: bound.appId,
    ...(bound.bundleId === undefined ? {} : { bundleId: bound.bundleId }),
  });
  if (admission.refused !== undefined) return { error: admission.refused };
  noteAdmittedInput(bound, "invoke_menu", menuArgs, tracker);
  return { path: raw };
};

export const prepareDesktopInput = (
  method: string,
  args: Record<string, unknown>,
  bound: BoundWindow,
  resolveToken: (el: Record<string, unknown>, bound: BoundWindow) => string | undefined,
  tracker?: CellWindowTracker,
): {
  readonly forwarded?: Record<string, unknown>;
  readonly elementToken?: string | undefined;
  readonly actedRow?: DesktopRow | undefined;
  readonly admission?: ReturnType<typeof admitDesktopInput>;
  readonly error?: ScreenRunError;
} => {
  if (!INPUT_METHODS.has(method)) return { error: fail("unsupported") };
  const element =
    typeof args.elementRef === "object" &&
    args.elementRef !== null &&
    !Array.isArray(args.elementRef)
      ? (args.elementRef as Record<string, unknown>)
      : undefined;
  if (method === "set_value" && !element) return { error: fail("invalid_argument") };
  let elementToken: string | undefined;
  if (element) {
    elementToken = resolveToken(element, bound);
    if (!elementToken) return { error: fail("stale_reference") };
  }
  const actedRow =
    elementToken === undefined
      ? undefined
      : bound.rows?.find((r) => r.driverToken === elementToken);
  const checkedAction =
    method === "click" || method === "right_click"
      ? validateNamedAction(args.action, actedRow)
      : {};
  if (checkedAction.error) return { error: checkedAction.error };
  const guardInput = buildGuardInput(method, args, bound, elementToken, (el) =>
    resolveToken(el, bound),
  );
  if (!guardInput.ok) return { error: guardInput.error };
  const admission = admitDesktopInput(guardInput.input);
  if (admission.refused !== undefined) return { error: admission.refused };
  noteAdmittedInput(bound, method, args, tracker);
  return {
    forwarded: buildForwardedInput(method, args, bound, elementToken, checkedAction.action),
    elementToken,
    actedRow,
    admission,
  };
};

export const availabilityFromControlState = (state: {
  readonly _tag: string;
  readonly idle?: boolean;
  readonly reason?: string;
}) => {
  if (state._tag === "active" && state.idle !== true)
    return [{ kind: "app" as const, available: true }];
  const reason =
    state._tag === "paused"
      ? state.reason === "private"
        ? ("private" as const)
        : ("paused" as const)
      : ("no_lease" as const);
  return [{ kind: "app" as const, available: false, reason }];
};

export const inspectBatchMember = (
  method: ScreenHostCall["method"],
  args: Record<string, unknown>,
  bound: BoundWindow | undefined,
  platform: NodeJS.Platform | undefined,
  resolveToken: (el: Record<string, unknown>, b: BoundWindow) => string | undefined,
) => {
  if (!bound) return { ok: false as const, error: fail("stale_reference") };
  const element =
    typeof args.elementRef === "object" &&
    args.elementRef !== null &&
    !Array.isArray(args.elementRef)
      ? (args.elementRef as Record<string, unknown>)
      : undefined;
  const elementToken = element ? resolveToken(element, bound) : undefined;
  if (element && !elementToken) return { ok: false as const, error: fail("stale_reference") };
  const guardInput = buildGuardInput(method, args, bound, elementToken, (el) =>
    resolveToken(el, bound),
  );
  if (!guardInput.ok) return guardInput;
  const pointerResolved = applyDesktopPointerArgs(
    method,
    args,
    elementToken === undefined ? {} : { element_token: elementToken },
    pointerStateFor(bound, platform, (el) => resolveToken(el, bound)),
  );
  if (!pointerResolved.ok) return pointerResolved;
  return { ok: true as const, ...guardInput.input };
};

const SHEET_IDS: ReadonlySet<unknown> = new Set(["PathTextField", "GoToWindow"]);
const LINE_HEAD = /^\s*(?:- )?\[(\d+)\] (\w+)/;

/**
 * Every numbered tree line by element index, read only when a line mentions a Go to Folder id or an
 * element carries one (goat.10 writes the id only in the tree text, 400 audit item 409). All lines
 * of a number count, so text that writes a second line for it makes that number ambiguous.
 */
const sheetLines = (markdown: string) => {
  const found = new Map<
    number,
    Array<{ readonly line: number; readonly rest: string; readonly role: string }>
  >();
  const lines = markdown.split("\n");
  lines.forEach((text, line) => {
    const head = LINE_HEAD.exec(text);
    if (!head?.[1] || !head[2]) return;
    const index = Number(head[1]);
    found.set(index, [
      ...(found.get(index) ?? []),
      { line, rest: text.slice(head[0].length), role: head[2] },
    ]);
  });
  return { lines, found };
};

/**
 * The id written right after what the element list says the line shows, and that prefix's length.
 * The driver writes text unescaped, so an id inside a label or value never counts, and a second
 * line for the same index (text posing as one) makes the answer unknown.
 */
const treeIdOf = (
  candidates: ReadonlyArray<{ readonly rest: string; readonly role: string }> | undefined,
  entry: Record<string, unknown>,
) => {
  const only = candidates?.length === 1 ? candidates[0] : undefined;
  if (only === undefined || only.role !== string(entry.role)) return undefined;
  const { rest } = only;
  const label = typeof entry.label === "string" ? entry.label : undefined;
  const value = typeof entry.value === "string" ? entry.value : undefined;
  const shown = [
    ...(label === undefined || value === undefined ? [] : [` "${label}" = "${value}"`]),
    ...(label === undefined ? [] : [` "${label}"`, ` (${label})`]),
    ...(value === undefined ? [] : [` = "${value}"`]),
    "",
  ];
  for (const words of shown) {
    if (!rest.startsWith(words)) continue;
    const after = rest.slice(words.length);
    if (after !== "" && !after.startsWith(" ")) continue;
    const id = /^\s\[id=(PathTextField|GoToWindow)[\s\]]/.exec(after)?.[1];
    return { ...(id === undefined ? {} : { id }), shownLength: words.length };
  }
  return undefined;
};

/**
 * Names Go to Folder's path field and sheet by their ids when the driver labels them with their own
 * value or nothing, in the element list and on their tree line, before rows, queries and the
 * interactive filter read them. Only labels change; the guards never read them.
 */
export const normalizeSheetState = (
  state: Record<string, unknown>,
  /** A driver-filtered read can drop an element's own line and keep one text wrote. */
  filtered = false,
): Record<string, unknown> => {
  if (!Array.isArray(state.elements)) return state;
  const markdown = typeof state.tree_markdown === "string" ? state.tree_markdown : "";
  const structured = new Set<number>();
  for (const item of state.elements) {
    const entry = object(item);
    const index = natural(entry?.element_index);
    if (index !== undefined && SHEET_IDS.has(entry?.identifier)) structured.add(index);
  }
  if (
    structured.size === 0 &&
    !markdown.includes("[id=PathTextField") &&
    !markdown.includes("[id=GoToWindow")
  )
    return state;
  // Text that spans lines can pose as any tree line, so then only structured ids count.
  const listed = state.elements.flatMap((item) => {
    const entry = object(item);
    const index = natural(entry?.element_index);
    return entry && index !== undefined
      ? [
          {
            index,
            role: string(entry.role) ?? "",
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.value === "string" ? { value: entry.value } : {}),
          },
        ]
      : [];
  });
  const trustLines = !filtered && !spansLines(markdown, listed);
  const { lines, found } = sheetLines(markdown);
  let changed = false;
  const elements = state.elements.map((item) => {
    const entry = object(item);
    const index = natural(entry?.element_index);
    if (!entry || index === undefined) return item;
    const candidates = found.get(index);
    const onLine = trustLines ? treeIdOf(candidates, entry) : undefined;
    const name = SHEET_IDS.has(entry.identifier) ? String(entry.identifier) : onLine?.id;
    if (name === undefined) return item;
    const label = typeof entry.label === "string" ? entry.label : "";
    const value = typeof entry.value === "string" ? entry.value : undefined;
    if (label !== "" && label !== value) return item;
    changed = true;
    // A structured id renames its sole line even when lines are not trusted for ids, so the shown
    // tree keeps that line's number; a filtered read may hold only a line text wrote.
    const fallback =
      onLine === undefined && !filtered && SHEET_IDS.has(entry.identifier)
        ? treeIdOf(candidates, entry)
        : undefined;
    // A value the line cannot show whole (one with a newline) leaves the line as written.
    const shape =
      onLine ?? (fallback?.shownLength === 0 && value !== undefined ? undefined : fallback);
    // Rewrite the line only where the shown text is known, so the metadata after it stays whole.
    const at = candidates?.length === 1 ? candidates[0] : undefined;
    if (at !== undefined && shape !== undefined) {
      const text = lines[at.line] ?? "";
      const head = text.slice(0, text.length - at.rest.length);
      const shown = value === undefined ? "" : ` = ${JSON.stringify(value)}`;
      lines[at.line] = `${head} ${JSON.stringify(name)}${shown}${at.rest.slice(shape.shownLength)}`;
    }
    return { ...entry, label: name };
  });
  return changed ? { ...state, elements, tree_markdown: lines.join("\n") } : state;
};

type WindowRead = Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
const listedWindows = (list: WindowRead, pid: number) =>
  list.pipe(
    Effect.map((reply) => parseWindowList(driverValue(reply), pid)),
    Effect.catchIf(
      (error) => error.code !== "user_interacting" && error.code !== "screen_locked",
      () => Effect.void,
    ),
  );

/**
 * The window a followed sheet came from, when a fresh window list shows the sheet gone and that
 * window on screen; it is read in place of the sheet, whose own read would fail first.
 */
const sheetReturnTarget = Effect.fn("DesktopInputPlan.sheetReturnTarget")(function* (
  bound: BoundWindow,
  list: WindowRead,
  deadlineMillis: number,
) {
  const origin = bound.sheetOriginWindowId;
  if (origin === undefined || origin === bound.windowId) return undefined;
  if ((yield* Clock.currentTimeMillis) >= deadlineMillis) return undefined;
  const windows = yield* listedWindows(list, bound.pid);
  const current = windows?.find((w) => w.window_id === bound.windowId);
  return windows?.some((w) => w.window_id === origin && w.is_on_screen) && !current?.is_on_screen
    ? origin
    : undefined;
});

/**
 * What a tree read starts from: it takes the binding's Go to Folder trigger, so each is used at
 * most once, and reads the window a closed sheet came from instead of the sheet.
 */
export const beginObservedSheet = Effect.fn("DesktopInputPlan.beginObservedSheet")(function* (
  bound: BoundWindow,
  capture: boolean,
  list: WindowRead,
  deadlineMillis: number,
) {
  if (capture) return { readWindowId: bound.windowId, trigger: undefined };
  const trigger = bound.sheetTrigger;
  delete bound.sheetTrigger;
  const back = yield* sheetReturnTarget(bound, list, deadlineMillis);
  return { readWindowId: back ?? bound.windowId, trigger };
});

const hasSheet = (state: Record<string, unknown>) =>
  (Array.isArray(state.elements) ? state.elements : []).some((item) => {
    const entry = object(item);
    return entry?.role === "AXSheet" || SHEET_IDS.has(entry?.identifier);
  });

const budgetNote = (detail: string) => ({ kind: "budget" as const, detail });

/** The window a Go to Folder input opened, when its own windows before and after name one. */
const pickOpenedSheet = (diff: NonNullable<SheetTrigger["diff"]>, from: number) => {
  const before = new Set(diff.before.map((w) => w.window_id));
  const opened = diff.after.filter(
    (w) => !before.has(w.window_id) && w.is_on_screen && w.window_id !== from,
  );
  const goto = opened.filter((w) => w.gotoSheet);
  const sheets = opened.filter((w) => w.sheet && (w.sheetOf === undefined || w.sheetOf === from));
  const only = opened.length === 1 ? opened[0] : undefined;
  const pick: SheetWindowEntry | undefined =
    goto.length === 1
      ? goto[0]
      : goto.length === 0 && sheets.length === 1
        ? sheets[0]
        : goto.length === 0 && sheets.length === 0 && only?.panelCandidate && only.title === ""
          ? only
          : undefined;
  return { opened, pick };
};

/**
 * The read observe() renders: a window this read returned to, the parent a sheet names, the window
 * a Go to Folder input opened, or the bound window. An unreadable opened window leaves the bound
 * window, read again so its numbers stay valid, and a note about the opened one.
 */
export const resolveObservedSheet = Effect.fn("DesktopInputPlan.resolveObservedSheet")(
  function* (input: {
    readonly bound: BoundWindow;
    readonly capture: boolean;
    readonly reply: ComputerUsePrimitiveReply;
    /** The window the first read asked for: the bound window, or the one returned to. */
    readonly readWindowId: number;
    readonly trigger: SheetTrigger | undefined;
    readonly filtered: boolean;
    readonly deadlineMillis: number;
    readonly read: (windowId: number) => WindowRead;
    readonly verify: (
      raw: Record<string, unknown> | undefined,
      windowId: number,
    ) => Effect.Effect<Record<string, unknown>, ScreenRunError>;
    readonly retire: () => void;
    readonly list: WindowRead;
  }) {
    const { bound, capture, read, verify, retire } = input;
    const from = bound.windowId;
    const stay = (reply: ComputerUsePrimitiveReply, state: Record<string, unknown>) => ({
      reply,
      state: capture ? state : normalizeSheetState(state, input.filtered),
      parentId: undefined as number | undefined,
      followedSheet: false,
      expectedWindowId: from,
      origin: bound.sheetOriginWindowId,
      extraOmitted: [] as NonNullable<ScreenObservation["omitted"]>,
    });
    const moveTo = (
      reply: ComputerUsePrimitiveReply,
      state: Record<string, unknown>,
      windowId: number,
      origin: number | undefined,
    ) => ({
      ...stay(reply, state),
      parentId: windowId,
      followedSheet: true,
      expectedWindowId: windowId,
      origin,
    });
    if (input.readWindowId !== from) {
      const state = yield* verify(object(driverValue(input.reply)), input.readWindowId);
      return moveTo(input.reply, state, input.readWindowId, undefined);
    }
    const state = yield* verify(object(driverValue(input.reply)), from);
    if (capture) return stay(input.reply, state);
    const parent = sheetParentId(state);
    if (parent !== undefined && parent !== from) {
      if ((yield* Clock.currentTimeMillis) >= input.deadlineMillis) return stay(input.reply, state);
      retire();
      const reply = yield* read(parent);
      const origin = bound.sheetOriginWindowId === parent ? undefined : bound.sheetOriginWindowId;
      return moveTo(reply, yield* verify(object(driverValue(reply)), parent), parent, origin);
    }
    const diff = input.trigger?.diff;
    if (diff === undefined || hasSheet(state)) return stay(input.reply, state);
    const { opened, pick } = pickOpenedSheet(diff, from);
    if (pick === undefined)
      return {
        ...stay(input.reply, state),
        extraOmitted: [
          budgetNote(
            opened.length === 0
              ? "The Go to Folder input finished and no new on-screen window opened in this app's process; an Open or Save panel's Go to Folder field may belong to a separate panel process this binding cannot read."
              : `The Go to Folder input opened window ${opened.map((w) => w.window_id).join(", ")} that could not be identified as its sheet; bind one by window_id to read it.`,
          ),
        ],
      };
    // Input after the Go to Folder one may have closed or replaced what it opened.
    if ((yield* Clock.currentTimeMillis) >= input.deadlineMillis) return stay(input.reply, state);
    const now = yield* listedWindows(input.list, bound.pid);
    const present =
      now?.some((w) => w.window_id === pick.window_id && w.is_on_screen) &&
      now.some((w) => w.window_id === from);
    if (!present) return stay(input.reply, state);
    retire();
    const probe = (windowId: number) =>
      read(windowId).pipe(
        Effect.map((reply) => {
          const checked = checkWindowReplyState(
            object(driverValue(reply)),
            bound.pid,
            windowId,
            false,
            false,
          );
          return checked.ok ? { reply, state: checked.state, windowId } : undefined;
        }),
        Effect.catchIf(
          (error) => error.code !== "user_interacting" && error.code !== "screen_locked",
          () => Effect.void,
        ),
      );
    let found = yield* probe(pick.window_id);
    const named = found && sheetParentId(found.state);
    if (found && named !== undefined && named !== from && named !== pick.window_id)
      found = yield* probe(named);
    if (found && Array.isArray(found.state.elements) && found.state.elements.length > 0)
      return moveTo(found.reply, found.state, found.windowId, bound.sheetOriginWindowId ?? from);
    const again = yield* read(from);
    return {
      ...stay(again, yield* verify(object(driverValue(again)), from)),
      extraOmitted: [
        budgetNote(
          `Window ${pick.window_id} opened after Go to Folder, but ${found ? "its accessibility tree returned no elements" : "reading its accessibility tree failed"}; bind window_id ${pick.window_id} to read it, or use its PathTextField there.`,
        ),
      ],
    };
  },
);

/**
 * Moves a binding onto the window observe() rendered, after the render succeeded: the window,
 * its generation and bounds, and the window a followed sheet came from.
 */
export const commitObservedSheet = (
  bound: BoundWindow,
  sheet: { readonly parentId: number | undefined; readonly origin: number | undefined },
  nextRef: ScreenTargetRef,
  nextBounds: Rect | undefined,
) => {
  if (sheet.parentId !== undefined) {
    Object.assign(bound, {
      windowId: sheet.parentId,
      epoch: nextRef.generation,
      ref: nextRef,
      pointsStale: "restart" as const,
    });
    if (nextBounds === undefined) delete bound.windowBounds;
    else bound.windowBounds = nextBounds;
    bound.screenshots?.clear();
    delete bound.latestScreenshot;
  }
  if (sheet.origin === undefined || sheet.origin === bound.windowId)
    delete bound.sheetOriginWindowId;
  else bound.sheetOriginWindowId = sheet.origin;
};
