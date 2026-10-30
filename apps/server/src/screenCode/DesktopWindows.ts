import { tooLargeStep } from "./DesktopObserveRead.ts";
import {
  COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
  type ComputerUsePrimitiveReply,
  type ScreenHostCall,
  type ScreenRunError,
  type ScreenWindowSummary,
  type ThreadId,
} from "@goat/contracts";
import { cuaAppKey } from "@goat/shared/cuaDriverManifest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AppHolder } from "../cua/ComputerUseAppLeases.ts";
import { CELL_RESERVE_MS, driverCallCapMs } from "../cua/ComputerUseCallCaps.ts";
import { boundsOf, type Rect } from "./DesktopFrames.ts";
import type { WindowClosure } from "./DesktopWindowClosure.ts";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
// @effect-diagnostics preferSchemaOverJson:off - Window lists and return budgets are measured against driver JSON.
/**
 * Desktop window tracking for wp4: before/after window diffs on each non-batch input, cell-level
 * accumulation of newly opened windows, sheet-to-parent rebinding checks, and hidden-window waits.
 */

export interface WindowEntry {
  readonly window_id: number;
  readonly pid: number;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
  readonly bounds?: Rect;
  readonly sheetOf?: number;
  readonly is_on_screen: boolean;
  readonly on_current_space?: boolean | null;
}

export interface InputWindowsReport {
  readonly opened: ReadonlyArray<ScreenWindowSummary>;
  readonly notListed: ReadonlyArray<ScreenWindowSummary>;
  readonly bound: "present" | "offscreen" | "not_listed" | "closed" | "unverified";
  readonly truncated?: boolean;
}

/** Host time an input took, in total and by step; a step that did not run is left out. */
export interface InputTiming {
  readonly ms: number;
  readonly phases: {
    readonly preMs?: number;
    readonly driverMs: number;
    readonly settleMs?: number;
    readonly postMs?: number;
  };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clipTitle = (value: unknown): string => (typeof value === "string" ? value.slice(0, 80) : "");

const toSummary = (entry: WindowEntry): ScreenWindowSummary => ({
  window_id: entry.window_id,
  title: entry.title,
  ...(entry.width === undefined ? {} : { width: entry.width }),
  ...(entry.height === undefined ? {} : { height: entry.height }),
  ...(entry.sheetOf === undefined ? {} : { sheetOf: entry.sheetOf }),
});

export const parseWindowList = (
  value: unknown,
  pid: number,
): ReadonlyArray<SheetWindowEntry> | undefined => {
  const raw = object(value)?.windows;
  if (!Array.isArray(raw)) return undefined;
  const entries: SheetWindowEntry[] = [];
  for (const item of raw) {
    const rec = object(item);
    const wid = natural(rec?.window_id);
    const wpid = natural(rec?.pid) ?? pid;
    if (!rec || wid === undefined || wid <= 0 || wpid !== pid) continue;
    const bounds = object(rec.bounds);
    const rect = boundsOf(bounds);
    const width = finite(bounds?.width) ?? finite(rec.width);
    const height = finite(bounds?.height) ?? finite(rec.height);
    const sheetOf = natural(rec.sheet_of_window_id) ?? natural(rec.sheetOf);
    const title = clipTitle(rec.title);
    entries.push({
      window_id: wid,
      pid: wpid,
      title,
      ...sheetKind(rec, title, width, height, sheetOf),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(rect === undefined ? {} : { bounds: rect }),
      ...(sheetOf === undefined || sheetOf <= 0 ? {} : { sheetOf }),
      is_on_screen: rec.is_on_screen !== false,
      ...(typeof rec.on_current_space === "boolean" || rec.on_current_space === null
        ? { on_current_space: rec.on_current_space }
        : {}),
    });
  }
  return entries;
};

/** A listed window with what the driver says about it being a sheet or a panel. */
export interface SheetWindowEntry extends WindowEntry {
  /** Finder's Go to Folder sheet, by its accessibility identifier or title. */
  readonly gotoSheet?: true;
  /** Another sheet: attached to a window, or with a sheet role. */
  readonly sheet?: true;
  /** A dialog, or an untitled window small enough to be a panel such as Go to Folder. */
  readonly panelCandidate?: true;
}

const bareKind = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase().replace(/^ax/, "") : "";
const GOTO_TITLE = /^(go to folder|폴더로 이동)$/i;

const sheetKind = (
  rec: Record<string, unknown>,
  title: string,
  width: number | undefined,
  height: number | undefined,
  sheetOf: number | undefined,
): Pick<SheetWindowEntry, "gotoSheet" | "sheet" | "panelCandidate"> => {
  const kinds = [bareKind(rec.role), bareKind(rec.subrole)];
  if (rec.identifier === "GoToWindow" || GOTO_TITLE.test(title.trim())) return { gotoSheet: true };
  if ((sheetOf !== undefined && sheetOf > 0) || kinds.includes("sheet")) return { sheet: true };
  const small = width !== undefined && height !== undefined && width <= 700 && height <= 500;
  return kinds.some((kind) => kind === "dialog" || kind === "systemdialog") ||
    (title === "" && small && rec.is_on_screen !== false)
    ? { panelCandidate: true }
    : {};
};

/** The hint an input's result gives for a window it opened that looks like a sheet or panel. */
const sheetHint = (w: SheetWindowEntry, onlyOpened: boolean): string | undefined =>
  w.gotoSheet
    ? `observed:sheet_window:${w.window_id} (GoToWindow sheet; bind window_id ${w.window_id} for its PathTextField)`
    : w.sheet
      ? `observed:sheet_window:${w.window_id} (sheet; bind window_id ${w.window_id} to read it)`
      : w.panelCandidate && (w.title !== "" || onlyOpened)
        ? `observed:sheet_candidate:${w.window_id} (dialog or panel; bind window_id ${w.window_id} to read it)`
        : undefined;

export const diffInputWindows = (
  before: ReadonlyArray<SheetWindowEntry> | undefined,
  after: ReadonlyArray<SheetWindowEntry> | undefined,
  boundWindowId: number,
  closure?: WindowClosure,
): { readonly report: InputWindowsReport; readonly evidence: ReadonlyArray<string> } => {
  if (!before || !after) {
    return {
      report: { opened: [], notListed: [], bound: "unverified" },
      evidence: ["observed:window_list_unverified"],
    };
  }
  const beforeById = new Map(before.map((w) => [w.window_id, w]));
  const afterById = new Map(after.map((w) => [w.window_id, w]));
  const openedAll = after.filter((w) => !beforeById.has(w.window_id)).map(toSummary);
  const notListedAll = before.filter((w) => !afterById.has(w.window_id)).map(toSummary);
  const witness = before.some((w) => w.window_id !== boundWindowId && afterById.has(w.window_id));
  const boundBefore = beforeById.get(boundWindowId);
  const boundAfter = afterById.get(boundWindowId);
  const evidence: string[] = [];
  let bound: InputWindowsReport["bound"] = "present";
  // Closure proves the window went away, not that this input closed it; the verdict stays the input's.
  if (!boundAfter && boundBefore && closure === "closed") {
    bound = "closed";
    evidence.push("observed:window_closed");
  } else if (!boundAfter) {
    if (witness) {
      bound = "not_listed";
      evidence.push("observed:window_not_listed");
    } else {
      bound = "unverified";
      evidence.push("observed:window_list_unverified");
    }
  } else if (!boundAfter.is_on_screen) {
    bound = "offscreen";
    const space =
      typeof boundAfter.on_current_space === "boolean"
        ? `:on_current_space=${boundAfter.on_current_space}`
        : "";
    evidence.push(`observed:window_offscreen${space}`);
  }
  if (boundBefore && boundAfter && boundBefore.title !== boundAfter.title) {
    evidence.push(
      `observed:window_title:${JSON.stringify(boundBefore.title.slice(0, 40))}→${JSON.stringify(boundAfter.title.slice(0, 40))}`,
    );
  }
  for (const w of openedAll.slice(0, 4)) {
    evidence.push(`observed:window_opened:${w.window_id}`);
  }
  const openedOnScreen = after.filter((w) => !beforeById.has(w.window_id) && w.is_on_screen);
  for (const w of openedOnScreen.slice(0, 2)) {
    const hint = sheetHint(w, openedOnScreen.length === 1 && boundAfter?.is_on_screen === true);
    if (hint !== undefined) evidence.push(hint);
  }
  const truncated = openedAll.length > 8 || notListedAll.length > 8;
  return {
    report: {
      opened: openedAll.slice(0, 8),
      notListed: notListedAll.slice(0, 8),
      bound,
      ...(truncated ? { truncated: true } : {}),
    },
    evidence,
  };
};

const guestDoneBytes = (
  resultValue: unknown,
  observed: ReadonlyArray<string> | undefined,
  timing: InputTiming | undefined,
  noResult: boolean,
): number => {
  const obj = object(resultValue);
  const doneShape = {
    verdict: "unverifiable",
    ...(timing === undefined ? {} : timing),
    ...(observed && observed.length > 0 ? { observed } : {}),
    ...(obj && "point" in obj ? { point: obj.point } : {}),
    ...(obj && "hit" in obj ? { hit: obj.hit } : {}),
    ...(resultValue === undefined || noResult ? {} : { result: resultValue }),
  };
  return Buffer.byteLength(JSON.stringify(doneShape) ?? "");
};

// The host value carries _observed, _timing and _noResult (the driver answered nothing); the
// guest lifts them onto Done.
const fitsInputBudget = (
  candidateResult: Record<string, unknown>,
  observed: ReadonlyArray<string> | undefined,
  returnBytes: number,
  timing: InputTiming | undefined,
  noResult = false,
): unknown | undefined => {
  const payload = {
    ...candidateResult,
    ...(observed && observed.length > 0 ? { _observed: observed } : {}),
    ...(timing === undefined ? {} : { _timing: timing }),
    ...(noResult ? { _noResult: true } : {}),
  };
  if (
    Buffer.byteLength(JSON.stringify(payload) ?? "") <= returnBytes &&
    guestDoneBytes(candidateResult, observed, timing, noResult) <= returnBytes
  )
    return payload;
  return undefined;
};

/**
 * The largest input result that fits returnBytes as the host value and as the guest's Done; timing
 * goes first, then observed rows and window detail. Otherwise the driver's value goes back as it
 * was, and the bridge refuses it as output_limit if it is over the cap.
 */
export const fitInputWindows = (
  driverVal: unknown,
  report: InputWindowsReport | undefined,
  returnBytes: number,
  observed?: ReadonlyArray<string>,
  timing?: InputTiming,
): unknown => {
  const base = object(driverVal) ?? {};
  const noResult = driverVal === undefined && report === undefined;
  const withWindows = { ...base, windows: report };
  const withFlag = { ...base, windowsTruncated: true };
  const candidates: ReadonlyArray<
    readonly [Record<string, unknown>, ReadonlyArray<string> | undefined]
  > =
    report === undefined
      ? [[base, observed]]
      : [
          [withWindows, observed],
          [withWindows, undefined],
          [withFlag, observed],
          [withFlag, undefined],
          [base, observed],
        ];
  for (const withTiming of timing === undefined ? [undefined] : [timing, undefined])
    for (const [candidate, rows] of candidates) {
      if (noResult && withTiming === undefined && !(rows && rows.length > 0)) return driverVal;
      const fitted = fitsInputBudget(candidate, rows, returnBytes, withTiming, noResult);
      if (fitted !== undefined) return fitted;
    }
  return driverVal;
};

/** A tab input's answer with its host time when that still fits returnBytes. */
export const withInputTiming = (
  value: unknown,
  timing: InputTiming,
  returnBytes: number,
): unknown => {
  if (value !== undefined && object(value) === undefined) return value;
  return (
    fitsInputBudget(object(value) ?? {}, undefined, returnBytes, timing, value === undefined) ??
    value
  );
};

export const sheetParentId = (state: Record<string, unknown>): number | undefined => {
  const reason = typeof state.degraded_reason === "string" ? state.degraded_reason : "";
  if (state.degraded !== true && !reason.includes("window_is_sheet")) return undefined;
  const parent =
    natural(state.sheet_of_window_id) ??
    natural(object(object(state.next_call)?.arguments)?.window_id);
  return parent !== undefined && parent > 0 ? parent : undefined;
};

export const hiddenWindowStatus = (
  listVal: unknown,
  pid: number,
  windowId: number,
): {
  readonly met: boolean;
  readonly status: "satisfied" | "unsatisfied";
  readonly on_current_space?: boolean;
} => {
  const list = parseWindowList(listVal, pid) ?? [];
  const found = list.find((w) => w.window_id === windowId);
  const met = found !== undefined && !found.is_on_screen;
  return {
    met,
    status: met ? "satisfied" : "unsatisfied",
    ...(typeof found?.on_current_space === "boolean"
      ? { on_current_space: found.on_current_space }
      : {}),
  };
};

/** A Go to Folder input of one binding and, once it returned, the windows before and after it. */
export interface SheetTrigger {
  readonly targetId: string;
  diff?: {
    readonly before: ReadonlyArray<SheetWindowEntry>;
    readonly after: ReadonlyArray<SheetWindowEntry>;
  };
  void?: true;
}

export interface CellWindowsOutcome {
  readonly windowsOpened?: ReadonlyArray<ScreenWindowSummary>;
  readonly windowsOpenedTruncated?: boolean;
  readonly windowsOpenedUnverified?: boolean;
}

export class CellWindowTracker {
  private readonly startByPid = new Map<number, ReadonlyArray<WindowEntry> | undefined>();
  private readonly latestByPid = new Map<number, ReadonlyArray<WindowEntry> | undefined>();
  private readonly seenOpened = new Map<number, Map<number, ScreenWindowSummary>>();
  /** Bindings that sent input to each process in this cell, and the Go to Folder input awaiting its windows. */
  private readonly inputTargets = new Map<number, Set<string>>();
  private readonly armed = new Map<number, SheetTrigger>();

  /** Records that a binding's input was admitted for a process. */
  noteInput(pid: number, targetId: string): void {
    const targets = this.inputTargets.get(pid) ?? new Set();
    targets.add(targetId);
    this.inputTargets.set(pid, targets);
  }

  /** Waits for the windows around a Go to Folder input; the next completed input of the process gives them. */
  armSheetTrigger(pid: number, trigger: SheetTrigger): void {
    this.armed.set(pid, trigger);
  }

  hasPid(pid: number): boolean {
    return this.startByPid.has(pid);
  }

  pids(): ReadonlyArray<number> {
    return [...this.startByPid.keys()];
  }

  recordBefore(pid: number, list: ReadonlyArray<WindowEntry> | undefined): void {
    if (!this.startByPid.has(pid)) {
      this.startByPid.set(pid, list && list.length > 0 ? list : undefined);
    }
  }

  recordAfter(
    pid: number,
    before: ReadonlyArray<SheetWindowEntry> | undefined,
    after: ReadonlyArray<SheetWindowEntry> | undefined,
  ): void {
    if (after && after.length > 0) this.latestByPid.set(pid, after);
    const trigger = this.armed.get(pid);
    this.armed.delete(pid);
    if (!before || !after) {
      if (trigger) trigger.void = true;
      return;
    }
    const beforeIds = new Set(before.map((w) => w.window_id));
    const afterIds = new Set(after.map((w) => w.window_id));
    if (trigger) {
      // Another binding's input on this process in the cell could have opened or closed windows.
      const targets = this.inputTargets.get(pid);
      const alone = targets?.size === 1 && targets.has(trigger.targetId);
      if (alone && before.some((w) => afterIds.has(w.window_id))) trigger.diff = { before, after };
      else trigger.void = true;
    }
    let map = this.seenOpened.get(pid);
    if (!map) {
      map = new Map();
      this.seenOpened.set(pid, map);
    }
    for (const w of after) {
      if (!beforeIds.has(w.window_id)) map.set(w.window_id, toSummary(w));
    }
    for (const wid of map.keys()) {
      if (!afterIds.has(wid)) map.delete(wid);
    }
  }

  finish(
    endByPid?: ReadonlyMap<number, ReadonlyArray<WindowEntry> | undefined>,
  ): CellWindowsOutcome {
    if (this.startByPid.size === 0) return {};
    const opened: ScreenWindowSummary[] = [];
    let unverified = false;
    for (const [pid, start] of this.startByPid) {
      const end = endByPid?.get(pid);
      const startIds = start ? new Set(start.map((w) => w.window_id)) : undefined;
      const witness =
        startIds !== undefined &&
        startIds.size > 0 &&
        end !== undefined &&
        end.some((w) => startIds.has(w.window_id));
      if (witness && end && startIds) {
        for (const w of end) {
          if (!startIds.has(w.window_id)) opened.push(toSummary(w));
        }
      } else {
        unverified = true;
        const fallback = this.seenOpened.get(pid);
        if (fallback) opened.push(...fallback.values());
      }
    }
    const truncated = opened.length > 16;
    return {
      ...(opened.length > 0 ? { windowsOpened: opened.slice(0, 16) } : {}),
      ...(truncated ? { windowsOpenedTruncated: true } : {}),
      ...(unverified ? { windowsOpenedUnverified: true } : {}),
    };
  }
}

/**
 * The window a bind names by its id, and the app row it belongs to. A bundle id or name only has
 * to agree with that window: its process is a row list_apps lists under it, or (on Linux, where
 * a script's window carries its WM_CLASS while its row is the interpreter's process) the window's
 * own app_name, as screen.discover() shows it. Without either, the window id alone names it.
 */
export const matchBindWindow = (input: {
  readonly listedApps: unknown;
  readonly listedWindows: unknown;
  readonly bundleId: string | undefined;
  readonly name: string | undefined;
  readonly requestedWindow: number;
  /** The windows came from macOS's list_windows `app` filter, which compares bundle ids. */
  readonly bundleFiltered?: boolean;
}): {
  readonly pid?: number;
  readonly app?: Record<string, unknown> | undefined;
  readonly window?: Record<string, unknown>;
  readonly error?: ScreenRunError;
} => {
  const { listedApps, listedWindows, bundleId, name, requestedWindow, bundleFiltered } = input;
  if (!Array.isArray(listedWindows)) return { error: fail("downstream_failure") };
  const rows = Array.isArray(listedApps)
    ? listedApps.map(object).filter((app): app is Record<string, unknown> => app !== undefined)
    : undefined;
  const asked = (app: Record<string, unknown>) =>
    bundleId !== undefined ? app.bundle_id === bundleId : app.name === name;
  const askedPids = new Set(rows?.filter(asked).map((app) => natural(app.pid)));
  const found = listedWindows
    .map(object)
    .filter((window): window is Record<string, unknown> => window !== undefined)
    .filter((window) => window.window_id === requestedWindow);
  if (found.length === 0)
    return {
      error: {
        ...fail("target_missing", "That window is closed; pick one from screen.discover()."),
        detail: "window_gone",
      },
    };
  const describe = (window: Record<string, unknown>) =>
    (typeof window.app_name === "string" && window.app_name.length > 0
      ? window.app_name + " "
      : "") +
    "(pid " +
    String(window.pid ?? "unknown") +
    ")";
  // Window ids are unique on a display; one listed twice cannot be told apart, whatever the name.
  if (found.length > 1)
    return {
      error: fail(
        "target_ambiguous",
        "The driver lists window " +
          requestedWindow +
          " " +
          found.length +
          " times (" +
          found.map(describe).join(", ") +
          "); call screen.discover() and bind again.",
      ),
    };
  const [first] = found;
  if (!first) return { error: fail("target_missing") };
  const pid = natural(first.pid);
  const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : undefined);
  const agrees =
    (bundleId === undefined && name === undefined) ||
    (rows !== undefined
      ? (pid !== undefined && pid > 0 && askedPids.has(pid)) ||
        (bundleId === undefined && first.app_name === name)
      : // A cut app list: only macOS's filter compared the bundle id; elsewhere only the
        // window's own bundle id or app_name proves which app it is.
        bundleId !== undefined
        ? bundleFiltered === true ||
          first.bundle_id === bundleId ||
          lower(first.app_name) === bundleId.toLowerCase()
        : first.app_name === name);
  if (!agrees)
    return {
      error: fail(
        "target_missing",
        "Window " +
          requestedWindow +
          " belongs to " +
          describe(first) +
          ", not " +
          (bundleId ?? name) +
          (rows === undefined
            ? " as far as the window itself says; the app list came back incomplete"
            : "") +
          ". Pass window_id alone, or with the name screen.discover() lists for it.",
      ),
    };
  if (!pid)
    return {
      error: fail(
        "target_missing",
        "Window " + requestedWindow + " has no process the driver can name, so it cannot be bound.",
      ),
    };
  const ofPid = rows?.filter((app) => natural(app.pid) === pid) ?? [];
  const holds = (app: Record<string, unknown>) =>
    Array.isArray(app.windows) &&
    app.windows.some((window) => object(window)?.window_id === requestedWindow);
  const app =
    ofPid.find((each) => (bundleId !== undefined || name !== undefined) && asked(each)) ??
    ofPid.find(holds) ??
    ofPid[0];
  return { pid, app, window: first };
};

export const checkWindowReplyState = (
  state: Record<string, unknown> | undefined,
  expectedPid: number,
  expectedWindowId: number,
  capture: boolean,
  query: boolean,
):
  | { readonly ok: true; readonly state: Record<string, unknown> }
  | { readonly ok: false; readonly evictTarget?: boolean; readonly error: ScreenRunError } => {
  if (state?.code === COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE)
    return { ok: false, error: fail("tree_limit", tooLargeStep(capture, query)) };
  const pid = natural(state?.pid);
  const wid = natural(state?.window_id);
  if (!state || pid === undefined || pid <= 0 || wid === undefined || wid <= 0)
    return {
      ok: false,
      error: fail(
        "downstream_failure",
        "The driver's answer did not describe the window. Observe again.",
      ),
    };
  if (pid !== expectedPid || wid !== expectedWindowId)
    return { ok: false, evictTarget: true, error: fail("stale_reference") };
  return { ok: true, state };
};

type HolderLookup = {
  readonly appHolders?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<AppHolder>>;
};
type DriverRequest = (
  tool: string,
  args: Record<string, unknown>,
  call: ScreenHostCall,
  context: ScreenHostContext,
) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;

const sameApp = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && cuaAppKey(a) === cuaAppKey(b);

/**
 * Marks rows another thread uses: its processes, and every row of an app id it names. A row whose
 * app id is unknown while a holder names one might be that app, so the answer is partial.
 */
const markHeldRows = (
  rows: ReadonlyArray<unknown>,
  holders: ReadonlyArray<AppHolder>,
  appOf: (row: Record<string, unknown>) => string | undefined,
): { readonly rows: ReadonlyArray<unknown>; readonly unknown: boolean } => {
  const named = holders.some((holder) => holder.app !== undefined);
  let unknown = false;
  const marked = rows.map((row) => {
    const rec = object(row);
    if (!rec) return row;
    const pid = natural(rec.pid);
    const app = appOf(rec);
    const holder =
      holders.find((each) => pid !== undefined && each.pids.includes(pid)) ??
      holders.find((each) => sameApp(each.app, app));
    if (holder) return { ...rec, inUse: true, holderThreadId: holder.holderThreadId };
    if (named && app === undefined) unknown = true;
    return row;
  });
  return { rows: marked, unknown };
};

const fitsReturn = (value: unknown, returnBytes: number) =>
  Buffer.byteLength(JSON.stringify(value) ?? "") <= returnBytes;

/**
 * discover's rows with other threads' use marked. Windows map to apps by one list_apps only when a
 * holder names an app and the cell can afford it; a lookup that cannot answer, a row it cannot
 * place, or marks over the return budget give holdersUnknown, never a silent "free".
 */
export const withHolders = Effect.fn("DesktopWindows.withHolders")(function* (
  reply: ComputerUsePrimitiveReply,
  call: ScreenHostCall,
  context: ScreenHostContext,
  leases: HolderLookup,
  request: DriverRequest,
) {
  const value = driverValue(reply);
  const key = call.method === "list_apps" ? "apps" : "windows";
  const listed = object(value);
  const rows = listed?.[key];
  if (!listed || !Array.isArray(rows)) return { value, category: "unverifiable" as const };
  // The driver answered with its list: a completed read, whether or not holders are known.
  const answer = (next: unknown) => ({
    value: next,
    category: "confirmed" as const,
    evidence: [`The driver listed ${rows.length} ${key}`],
  });
  const unknown = { ...listed, holdersUnknown: true };
  const holders = leases.appHolders
    ? yield* leases.appHolders(context.invocation.thread.threadId)
    : undefined;
  if (holders === undefined)
    return answer(fitsReturn(unknown, context.limits.returnBytes) ? unknown : value);
  if (holders.length === 0) return answer(value);
  let appOf = (row: Record<string, unknown>): string | undefined =>
    typeof row.bundle_id === "string" && row.bundle_id.length > 0 ? row.bundle_id : undefined;
  if (key === "windows") {
    const byPid = new Map<number, string | undefined>();
    const now = yield* Clock.currentTimeMillis;
    const affordable =
      call.deadlineMillis - now - CELL_RESERVE_MS >= driverCallCapMs("list_apps", {});
    if (holders.some((holder) => holder.app !== undefined) && affordable) {
      const apps = yield* request("list_apps", {}, call, context).pipe(Effect.option);
      const appRows = Option.isSome(apps) ? object(driverValue(apps.value))?.apps : undefined;
      if (Array.isArray(appRows))
        for (const row of appRows) {
          const rec = object(row);
          const pid = natural(rec?.pid);
          if (rec && pid !== undefined) byPid.set(pid, appOf(rec));
        }
    }
    appOf = (row) => {
      const pid = natural(row.pid);
      return pid === undefined ? undefined : byPid.get(pid);
    };
  }
  const marked = markHeldRows(rows, holders, appOf);
  const next = {
    ...listed,
    [key]: marked.rows,
    ...(marked.unknown ? { holdersUnknown: true } : {}),
  };
  if (fitsReturn(next, context.limits.returnBytes)) return answer(next);
  return answer(fitsReturn(unknown, context.limits.returnBytes) ? unknown : value);
});
