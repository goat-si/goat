import { CELL_RESERVE_MS, driverCallCapMs, MIN_CALL_MS } from "../cua/ComputerUseCallCaps.ts";
// @effect-diagnostics preferSchemaOverJson:off - verify_state observed_json payloads are bounded by the driver.
/**
 * Observation-only evidence around a non-batch desktop input: watched element state before and
 * after via verify_state(timeout_ms: 0), paired with DesktopWindows list diffs.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ComputerUsePrimitiveReply, ScreenHostCall, ScreenRunError } from "@goat/contracts";
import { driverError, driverValue } from "./DesktopDriverReplies.ts";
import type { ScreenHostContext, ScreenHostDispatchResult } from "./ScreenHostBridge.ts";
import {
  type CellWindowTracker,
  type CellWindowsOutcome,
  diffInputWindows,
  fitInputWindows,
  hiddenWindowStatus,
  parseWindowList,
  type WindowEntry,
} from "./DesktopWindows.ts";
import type { DesktopRow } from "./DesktopObserveRead.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";

export const settleCaptureIfNeeded = Effect.fn("DesktopEvidence.settleCaptureIfNeeded")(function* (
  capture: boolean,
  bound: BoundWindow,
  callDeadlineMillis: number,
) {
  if (!capture || bound.needsSettleBeforeCapture !== true) return;
  const now = yield* Clock.currentTimeMillis;
  if (callDeadlineMillis - now - CELL_RESERVE_MS >= 7_060) {
    yield* Effect.sleep("60 millis");
    delete bound.needsSettleBeforeCapture;
  }
});

export interface WatchedElement {
  readonly kind: "acted" | "window";
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly selected?: boolean;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const clip = (val: string): string => JSON.stringify(val.slice(0, 40));
const normRole = (role: string): string => role.toLowerCase().replace(/^ax/, "");

const isUniqueNativeLabel = (row: DesktopRow, allRows: ReadonlyArray<DesktopRow>): boolean => {
  if (row.lifted === true || row.name.trim() === "") return false;
  const r = normRole(row.role);
  const needle = row.name.toLowerCase();
  let matches = 0;
  for (const other of allRows) {
    if (other.lifted === true) continue;
    if (normRole(other.role) !== r) continue;
    const matchesSelector =
      other.name.toLowerCase().includes(needle) ||
      (other.text?.toLowerCase().includes(needle) ?? false) ||
      (other.id?.toLowerCase().includes(needle) ?? false);
    if (matchesSelector) matches++;
  }
  return matches === 1;
};

const buildWatchedElements = (
  acted: DesktopRow | undefined,
  allRows: ReadonlyArray<DesktopRow>,
): ReadonlyArray<WatchedElement> => {
  const list: WatchedElement[] = [];
  if (
    acted &&
    (acted.text !== undefined || acted.selected !== undefined) &&
    isUniqueNativeLabel(acted, allRows)
  ) {
    list.push({
      kind: "acted",
      role: acted.role,
      label: acted.name,
      ...(acted.text === undefined ? {} : { value: acted.text }),
      ...(acted.selected === undefined ? {} : { selected: acted.selected }),
    });
  }
  for (const row of allRows) {
    if (list.length >= 7) break;
    if (acted && row.driverToken === acted.driverToken) continue;
    if (row.text === undefined && row.selected === undefined) continue;
    if (!isUniqueNativeLabel(row, allRows)) continue;
    list.push({
      kind: "window",
      role: row.role,
      label: row.name,
      ...(row.text === undefined ? {} : { value: row.text }),
      ...(row.selected === undefined ? {} : { selected: row.selected }),
    });
  }
  return list;
};

const toVerifyExpectations = (watched: ReadonlyArray<WatchedElement>) =>
  watched.map((w) => ({
    element: {
      selector: { role: w.role, label_contains: w.label },
      exists: true,
      ...(w.value !== undefined
        ? { value_equals: w.value }
        : w.selected !== undefined
          ? { selected: w.selected }
          : { enabled: true }),
    },
  }));

interface ObservedProj {
  readonly label?: string;
  readonly elementIndex?: number;
  readonly value?: string;
  readonly selected?: boolean;
}

const parseVerifyObservations = (
  replyVal: unknown,
  count: number,
): ReadonlyArray<ObservedProj | undefined> => {
  const preds = object(replyVal)?.predicates;
  if (!Array.isArray(preds)) return Array.from({ length: count }, () => undefined);
  return Array.from({ length: count }, (_, idx) => {
    const item = object(preds[idx]);
    const rawJson = typeof item?.observed_json === "string" ? item.observed_json : undefined;
    if (!rawJson) return undefined;
    try {
      const parsed = object(JSON.parse(rawJson));
      if (!parsed || typeof parsed.matches === "number" || typeof parsed.error === "string")
        return undefined;
      return {
        ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
        ...(typeof parsed.element_index === "number" ? { elementIndex: parsed.element_index } : {}),
        ...(typeof parsed.value === "string" ? { value: parsed.value } : {}),
        ...(typeof parsed.selected === "boolean" ? { selected: parsed.selected } : {}),
      };
    } catch {
      return undefined;
    }
  });
};

const diffWatchedEvidence = (
  watched: ReadonlyArray<WatchedElement>,
  before: ReadonlyArray<ObservedProj | undefined>,
  after: ReadonlyArray<ObservedProj | undefined>,
): ReadonlyArray<string> => {
  const out: string[] = [];
  watched.forEach((w, idx) => {
    const pre = before[idx];
    const post = after[idx];
    if (!pre || !post) return;
    if (pre.label !== w.label || post.label !== w.label) return;
    if (
      pre.elementIndex !== undefined &&
      post.elementIndex !== undefined &&
      pre.elementIndex !== post.elementIndex
    )
      return;
    const prefix =
      w.kind === "acted"
        ? "observed:element_state:"
        : `observed:window_change:${w.label.slice(0, 32)} `;
    if (pre.value !== undefined && post.value !== undefined && pre.value !== post.value) {
      out.push(
        w.kind === "acted"
          ? `${prefix}value ${clip(pre.value)}→${clip(post.value)}`
          : `${prefix}${clip(pre.value)}→${clip(post.value)}`,
      );
    } else if (
      pre.selected !== undefined &&
      post.selected !== undefined &&
      pre.selected !== post.selected
    ) {
      out.push(`${prefix}selected ${String(pre.selected)}→${String(post.selected)}`);
    }
  });
  return out;
};

type SendFn = (
  tool: string,
  args: Record<string, unknown>,
  call: ScreenHostCall,
  context: ScreenHostContext,
  expectedConnectionGeneration?: string,
) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;

const quietRead = Effect.fn("DesktopEvidence.quietRead")(function* (
  send: SendFn,
  call: ScreenHostCall,
  context: ScreenHostContext,
  connectionGeneration: string,
  tool: string,
  args: Record<string, unknown>,
  reserveAfterMs = 0,
  budgetMs = 1500,
) {
  const now = yield* Clock.currentTimeMillis;
  const latestEnd = call.deadlineMillis - reserveAfterMs - CELL_RESERVE_MS;
  if (latestEnd - now < MIN_CALL_MS) return undefined;
  const effective = Math.min(budgetMs, latestEnd - now);
  const deadlineMillis = now + CELL_RESERVE_MS + effective;
  const sent = yield* send(
    tool,
    args,
    { ...call, deadlineMillis },
    context,
    connectionGeneration,
  ).pipe(Effect.timeoutOption(effective), Effect.option);
  const reply = Option.isSome(sent) ? Option.getOrUndefined(sent.value) : undefined;
  if (!reply || driverError(reply) !== undefined) return undefined;
  return driverValue(reply);
});

export const runInputWithEvidence = Effect.fn("DesktopEvidence.runInputWithEvidence")(
  function* (deps: {
    readonly send: SendFn;
    readonly call: ScreenHostCall;
    readonly context: ScreenHostContext;
    readonly pid: number;
    readonly windowId: number;
    readonly connectionGeneration: string;
    readonly tracker: CellWindowTracker;
    readonly tool: string;
    readonly forwarded: Record<string, unknown>;
    readonly acted: DesktopRow | undefined;
    readonly rows: ReadonlyArray<DesktopRow>;
    readonly runInput: Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
    readonly onSettled?: () => void;
  }) {
    const {
      send,
      call,
      context,
      pid,
      windowId,
      connectionGeneration,
      tracker,
      tool,
      forwarded,
      acted,
      rows,
      runInput,
      onSettled,
    } = deps;
    const inputCapMs = driverCallCapMs(tool, forwarded);
    const watched = buildWatchedElements(acted, rows);
    const preReserve = inputCapMs + (watched.length > 0 ? 1500 : 0);
    const preWinRaw = yield* quietRead(
      send,
      call,
      context,
      connectionGeneration,
      "list_windows",
      { pid },
      preReserve,
    );
    const preWins = parseWindowList(preWinRaw, pid);
    tracker.recordBefore(pid, preWins);
    const preVerifyRaw =
      watched.length > 0
        ? yield* quietRead(
            send,
            call,
            context,
            connectionGeneration,
            "verify_state",
            { pid, window_id: windowId, expect: toVerifyExpectations(watched), timeout_ms: 0 },
            inputCapMs,
          )
        : undefined;
    const base = yield* runInput;
    const nowAfter = yield* Clock.currentTimeMillis;
    if (call.deadlineMillis - nowAfter - CELL_RESERVE_MS >= 1_560) {
      yield* Effect.sleep("60 millis");
      onSettled?.();
    }
    const postWinRaw = yield* quietRead(
      send,
      call,
      context,
      connectionGeneration,
      "list_windows",
      { pid },
      0,
    );
    const postWins = parseWindowList(postWinRaw, pid);
    tracker.recordAfter(pid, preWins, postWins);
    const postVerifyRaw =
      watched.length > 0 && preVerifyRaw !== undefined
        ? yield* quietRead(
            send,
            call,
            context,
            connectionGeneration,
            "verify_state",
            { pid, window_id: windowId, expect: toVerifyExpectations(watched), timeout_ms: 0 },
            0,
          )
        : undefined;
    const winDiff = diffInputWindows(preWins, postWins, windowId);
    const elDiff =
      watched.length > 0 && preVerifyRaw !== undefined && postVerifyRaw !== undefined
        ? diffWatchedEvidence(
            watched,
            parseVerifyObservations(preVerifyRaw, watched.length),
            parseVerifyObservations(postVerifyRaw, watched.length),
          )
        : [];
    const allObserved = [...elDiff, ...winDiff.evidence].slice(0, 16);
    return {
      ...base,
      value: fitInputWindows(base.value, winDiff.report, context.limits.returnBytes, allObserved),
      evidence: [...(base.evidence ?? []), ...allObserved].slice(0, 16),
    };
  },
);

export const finishCellTracker = Effect.fn("DesktopEvidence.finishCellTracker")(function* (
  entry: { readonly tracker: CellWindowTracker; readonly connectionGeneration: string } | undefined,
  context: ScreenHostContext,
  options: { readonly skipEndRead?: boolean; readonly cellDeadlineMillis?: number } | undefined,
  send: SendFn,
): Effect.fn.Return<CellWindowsOutcome> {
  if (!entry) return {};
  if (options?.skipEndRead === true) return entry.tracker.finish();
  const endByPid = new Map<number, ReadonlyArray<WindowEntry> | undefined>();
  for (const pid of entry.tracker.pids()) {
    const now = yield* Clock.currentTimeMillis;
    const cap = options?.cellDeadlineMillis ?? now + CELL_RESERVE_MS + 1500;
    const remain = Math.min(1500, cap - now - CELL_RESERVE_MS);
    if (remain < MIN_CALL_MS) {
      endByPid.set(pid, undefined);
      continue;
    }
    const sent = yield* send(
      "list_windows",
      { pid },
      {
        t: "call",
        runId: context.runId,
        turnId: context.turnId,
        cellId: context.cellId,
        callId: 0,
        method: "list_windows",
        args: { pid },
        deadlineMillis: now + CELL_RESERVE_MS + remain,
      },
      context,
      entry.connectionGeneration,
    ).pipe(Effect.timeoutOption(remain), Effect.option);
    const reply = Option.isSome(sent) ? Option.getOrUndefined(sent.value) : undefined;
    endByPid.set(
      pid,
      reply && !driverError(reply) ? parseWindowList(driverValue(reply), pid) : undefined,
    );
  }
  return entry.tracker.finish(endByPid);
});

export const seedBatchBaseline = Effect.fn("DesktopEvidence.seedBatchBaseline")(function* (deps: {
  readonly send: SendFn;
  readonly calls: ReadonlyArray<ScreenHostCall>;
  readonly context: ScreenHostContext;
  readonly pid: number;
  readonly connectionGeneration: string;
  readonly boundInCellId?: string | undefined;
  readonly boundWindows?: ReadonlyArray<WindowEntry> | undefined;
  readonly tracker: CellWindowTracker;
}) {
  const { send, calls, context, pid, connectionGeneration, boundInCellId, boundWindows, tracker } =
    deps;
  const first = calls[0];
  if (!first || tracker.hasPid(pid)) return;
  if (boundInCellId === context.cellId && boundWindows !== undefined) {
    tracker.recordBefore(pid, boundWindows);
    return;
  }
  const batchCapMs = calls.reduce((sum, c) => sum + driverCallCapMs(c.method, c.args), 0);
  const raw = yield* quietRead(
    send,
    first,
    context,
    connectionGeneration,
    "list_windows",
    { pid },
    batchCapMs,
  );
  tracker.recordBefore(pid, parseWindowList(raw, pid));
});

export const pollHiddenWindow = Effect.fn("DesktopEvidence.pollHiddenWindow")(function* (deps: {
  readonly list: () => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  readonly pid: number;
  readonly windowId: number;
  readonly timeoutMs: unknown;
  readonly cellDeadlineMillis: number;
}) {
  const { list, pid, windowId, timeoutMs, cellDeadlineMillis } = deps;
  const started = yield* Clock.currentTimeMillis;
  const requested = typeof timeoutMs === "number" ? Math.max(0, timeoutMs) : 10_000;
  const waitCap = Math.max(
    0,
    Math.min(requested, 10_000, cellDeadlineMillis - started - CELL_RESERVE_MS - MIN_CALL_MS),
  );
  const deadline = started + waitCap;
  let hidden = hiddenWindowStatus({}, pid, windowId);
  for (let sample = 0; ; sample++) {
    const now = yield* Clock.currentTimeMillis;
    if (sample > 0 && now >= deadline) break;
    const remain = waitCap === 0 ? MIN_CALL_MS : Math.max(1, deadline - now);
    const polled = yield* list().pipe(
      Effect.timeoutOption(remain),
      Effect.catchIf(
        (err) => err.code === "deadline" && (sample > 0 || requested < MIN_CALL_MS),
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(polled)) break;
    if (waitCap > 0 && (yield* Clock.currentTimeMillis) > deadline) break;
    hidden = hiddenWindowStatus(driverValue(polled.value), pid, windowId);
    if (hidden.met || waitCap === 0) break;
    const after = yield* Clock.currentTimeMillis;
    if (after >= deadline) break;
    yield* Effect.sleep(Math.min(100, deadline - after));
  }
  return {
    value: hidden,
    category: hidden.met ? ("confirmed" as const) : ("unverifiable" as const),
    evidence: [`window_hidden:${hidden.status}`],
  };
});
