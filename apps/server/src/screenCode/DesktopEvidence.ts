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
  parseWindowList,
  type WindowEntry,
} from "./DesktopWindows.ts";
import type { DesktopRow } from "./DesktopObserveRead.ts";

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
    if (normRole(other.role) === r && other.name.toLowerCase().includes(needle)) matches++;
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

const quietRead = Effect.fn("DesktopEvidence.quietRead")(function* (
  send: (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>,
  call: ScreenHostCall,
  context: ScreenHostContext,
  connectionGeneration: string,
  tool: string,
  args: Record<string, unknown>,
  budgetMs = 1500,
) {
  const now = yield* Clock.currentTimeMillis;
  if (call.deadlineMillis - now <= 1000) return undefined;
  const deadlineMillis = Math.min(call.deadlineMillis, now + budgetMs);
  const sent = yield* send(
    tool,
    args,
    { ...call, deadlineMillis },
    context,
    connectionGeneration,
  ).pipe(Effect.option);
  if (Option.isNone(sent) || driverError(sent.value) !== undefined) return undefined;
  return driverValue(sent.value);
});

export const runInputWithEvidence = Effect.fn("DesktopEvidence.runInputWithEvidence")(
  function* (deps: {
    readonly send: (
      tool: string,
      args: Record<string, unknown>,
      call: ScreenHostCall,
      context: ScreenHostContext,
      expectedConnectionGeneration?: string,
    ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
    readonly call: ScreenHostCall;
    readonly context: ScreenHostContext;
    readonly pid: number;
    readonly windowId: number;
    readonly connectionGeneration: string;
    readonly tracker: CellWindowTracker;
    readonly acted: DesktopRow | undefined;
    readonly rows: ReadonlyArray<DesktopRow>;
    readonly runInput: Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  }) {
    const {
      send,
      call,
      context,
      pid,
      windowId,
      connectionGeneration,
      tracker,
      acted,
      rows,
      runInput,
    } = deps;
    const read = (tool: string, args: Record<string, unknown>) =>
      quietRead(send, call, context, connectionGeneration, tool, args);
    const preWinRaw = yield* read("list_windows", { pid });
    const preWins = parseWindowList(preWinRaw, pid);
    tracker.recordBefore(pid, preWins);
    const watched = buildWatchedElements(acted, rows);
    const preVerifyRaw =
      watched.length > 0
        ? yield* read("verify_state", {
            pid,
            window_id: windowId,
            expect: toVerifyExpectations(watched),
            timeout_ms: 0,
          })
        : undefined;
    const base = yield* runInput;
    const postWinRaw = yield* read("list_windows", { pid });
    const postWins = parseWindowList(postWinRaw, pid);
    tracker.recordAfter(pid, preWins, postWins);
    const postVerifyRaw =
      watched.length > 0 && preVerifyRaw !== undefined
        ? yield* read("verify_state", {
            pid,
            window_id: windowId,
            expect: toVerifyExpectations(watched),
            timeout_ms: 0,
          })
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
    return {
      ...base,
      value: fitInputWindows(base.value, winDiff.report, context.limits.returnBytes),
      evidence: [...(base.evidence ?? []), ...elDiff, ...winDiff.evidence].slice(0, 16),
    };
  },
);

export const finishCellTracker = Effect.fn("DesktopEvidence.finishCellTracker")(function* (
  entry: { readonly tracker: CellWindowTracker; readonly connectionGeneration: string } | undefined,
  context: ScreenHostContext,
  skipEndRead: boolean,
  send: (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>,
): Effect.fn.Return<CellWindowsOutcome> {
  if (!entry) return {};
  if (skipEndRead) return entry.tracker.finish();
  const endByPid = new Map<number, ReadonlyArray<WindowEntry> | undefined>();
  const now = yield* Clock.currentTimeMillis;
  for (const pid of entry.tracker.pids()) {
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
        deadlineMillis: now + 1500,
      },
      context,
      entry.connectionGeneration,
    ).pipe(Effect.option);
    endByPid.set(
      pid,
      Option.isSome(sent) && !driverError(sent.value)
        ? parseWindowList(driverValue(sent.value), pid)
        : undefined,
    );
  }
  return entry.tracker.finish(endByPid);
});
