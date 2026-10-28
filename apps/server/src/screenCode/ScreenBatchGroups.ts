/**
 * Desktop input a cell started without awaiting each call (the prelude's flush) reaches the bridge
 * as consecutive host calls marked `batch: {index, size}`. Each stays its own call, with its own
 * admission, receipt and reply; the group only shares the trip to the driver. The first call
 * opens the group, holds the target's gate and waits until every member has arrived and passed
 * its own checks, then dispatches the ready members in order as one batch. A later call of the
 * cell closes the group; members after a gap, a refusal or a failure do not run.
 *
 * @module ScreenBatchGroups
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ScreenHostCall, ScreenRunError } from "@goat/contracts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

/** The most calls the prelude sends as one group; the driver allows 64 steps. */
export const MAX_BATCH_CALLS = 16;

type Outcome = Exit.Exit<ScreenHostDispatchResult, ScreenRunError>;
type NotRun = (callId: number, failedCallId: number) => ScreenRunError;

interface BatchGroup {
  readonly targetId: string;
  readonly first: number;
  readonly size: number;
  readonly slots: Map<number, BatchSlot>;
  closed: boolean;
  readonly settled: Deferred.Deferred<void>;
}

export interface BatchSlot {
  readonly call: ScreenHostCall;
  readonly index: number;
  readonly group: BatchGroup;
  state: "joined" | "ready" | "withdrawn";
  markDispatched?: () => void;
  readonly outcome: Deferred.Deferred<ScreenHostDispatchResult, ScreenRunError>;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const batchMarker = (call: ScreenHostCall) => {
  if (call.targetRef?.kind !== "app") return undefined;
  const batch = record(record(Array.isArray(call.args) ? call.args[0] : call.args)?.batch);
  const index = batch?.index;
  const size = batch?.size;
  return natural(index) && natural(size) && size >= 2 && size <= MAX_BATCH_CALLS && index < size
    ? { index, size }
    : undefined;
};

const check = (group: BatchGroup) => {
  const arrived = group.closed || group.slots.size === group.size;
  if (arrived && [...group.slots.values()].every((slot) => slot.state !== "joined"))
    Deferred.doneUnsafe(group.settled, Exit.void);
};

const close = (group: BatchGroup) => {
  group.closed = true;
  check(group);
};

/** One call at a time, stopping after the first that failed or did not do what was asked. */
export const dispatchInTurn = Effect.fn("ScreenHostBridge.dispatchInTurn")(function* (
  calls: ReadonlyArray<ScreenHostCall>,
  dispatch: (call: ScreenHostCall) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>,
  failedCategories: ReadonlySet<ScreenHostDispatchResult["category"]>,
) {
  const outcomes: Outcome[] = [];
  for (const call of calls) {
    const outcome = yield* Effect.exit(dispatch(call));
    outcomes.push(outcome);
    if (Exit.isFailure(outcome) || failedCategories.has(outcome.value.category)) break;
  }
  return outcomes;
});

/** A cell's batch groups; at most one is still taking members. */
export class BatchGroups {
  private open: BatchGroup | undefined;

  /** The slot a call takes; any other call closes the open group. */
  join(call: ScreenHostCall): BatchSlot | undefined {
    const marker = batchMarker(call);
    const open = this.open;
    if (open !== undefined && !open.closed) {
      if (
        marker !== undefined &&
        marker.index > 0 &&
        marker.size === open.size &&
        call.targetRef?.id === open.targetId &&
        call.callId === open.first + marker.index &&
        !open.slots.has(marker.index)
      )
        return this.slot(open, call, marker.index);
      close(open);
    }
    const targetId = call.targetRef?.id;
    if (marker?.index !== 0 || targetId === undefined) return undefined;
    const group: BatchGroup = {
      targetId,
      first: call.callId,
      size: marker.size,
      slots: new Map(),
      closed: false,
      settled: Deferred.makeUnsafe<void>(),
    };
    this.open = group;
    return this.slot(group, call, 0);
  }

  private slot(group: BatchGroup, call: ScreenHostCall, index: number): BatchSlot {
    const slot: BatchSlot = {
      call,
      index,
      group,
      state: "joined",
      outcome: Deferred.makeUnsafe<ScreenHostDispatchResult, ScreenRunError>(),
    };
    group.slots.set(index, slot);
    return slot;
  }

  /**
   * A member that will not take part: refused on admission, failed its checks or interrupted.
   * The group stops there, and without its first call none of it runs.
   */
  withdraw(slot: BatchSlot, notRun: NotRun) {
    if (slot.state !== "joined") return;
    slot.state = "withdrawn";
    close(slot.group);
    if (slot.index === 0)
      for (const other of slot.group.slots.values())
        if (other !== slot)
          Deferred.doneUnsafe(
            other.outcome,
            Exit.fail(notRun(other.call.callId, slot.call.callId)),
          );
  }

  ready(slot: BatchSlot, markDispatched: () => void) {
    if (slot.state !== "joined") return;
    slot.state = "ready";
    slot.markDispatched = markDispatched;
    check(slot.group);
  }

  /**
   * The first call's part, holding the target's gate: once every member has arrived and settled
   * its own checks, dispatch the ready ones from the first, in order, and hand each its outcome.
   * Members past a gap, or past an outcome the dispatcher did not return, get notRun.
   */
  run = Effect.fn("ScreenHostBridge.runBatch")(function* (
    opener: BatchSlot,
    deps: {
      /** Why nothing of the group may go out now (a stop or an earlier failure). */
      readonly blocked: (callId: number) => ScreenRunError | undefined;
      readonly dispatch: (
        calls: ReadonlyArray<ScreenHostCall>,
      ) => Effect.Effect<ReadonlyArray<Outcome>>;
      readonly notRun: NotRun;
    },
  ) {
    const group = opener.group;
    yield* Deferred.await(group.settled);
    let ready = 0;
    while (group.slots.get(ready)?.state === "ready") ready++;
    const blocked = deps.blocked(opener.call.callId);
    const calls = Array.from({ length: ready }, (_, index) => group.slots.get(index)?.call);
    const outcomes =
      blocked !== undefined
        ? []
        : yield* Effect.suspend(() => {
            for (let index = 0; index < ready; index++) group.slots.get(index)?.markDispatched?.();
            return deps.dispatch(calls.filter((call) => call !== undefined));
          });
    let failed: number | undefined;
    for (let index = 0; index < group.size; index++) {
      const slot = group.slots.get(index);
      if (slot === undefined || slot.state === "withdrawn") {
        failed ??= group.first + index;
        continue;
      }
      const outcome = index < ready ? outcomes[index] : undefined;
      if (outcome === undefined) {
        Deferred.doneUnsafe(
          slot.outcome,
          Exit.fail(
            blocked === undefined
              ? deps.notRun(slot.call.callId, failed ?? group.first + index - 1)
              : { ...blocked, callId: slot.call.callId },
          ),
        );
        failed ??= slot.call.callId;
        continue;
      }
      Deferred.doneUnsafe(slot.outcome, outcome);
      if (Exit.isFailure(outcome)) failed ??= slot.call.callId;
    }
  });
}
