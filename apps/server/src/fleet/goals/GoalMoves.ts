/**
 * Moving a goal's worker to another host, and settling a move whose answer was lost. A move is
 * claimed under its reschedule action id (one per run) and launched under the next attempt's
 * launch id, the Rescheduler's clientRequestId. Until the move settles, its slot takes no other
 * action (goalPlan resolve_move), so a second worker never starts for that attempt; finding what
 * it started takes no turn and is never refused by the budget.
 */
import {
  type FleetGoal,
  type FleetGoalEvent,
  FleetOwnerKey,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import {
  RescheduleNotAllowed,
  type Rescheduler,
  type RescheduleReason,
  type RescheduleResult,
} from "../health/Rescheduler.ts";
import type { actionAuthority } from "./GoalAuthority.ts";
import { renderPrompt } from "./goalPrompt.ts";
import type { ActionIssue } from "./goalPlan.ts";
import {
  type ClaimRefusal,
  type GoalStore,
  type GoalStoreError,
  NOT_SENT,
  type WorkerRecord,
} from "./GoalStore.ts";
import { launchActionId, rescheduleActionId, successorBranch, successorOf } from "./goalWorkers.ts";
import type { GoalWorkerRuntime, OwnerAccess } from "./GoalWorkerRuntime.ts";

/** Records that a move stopped its own attempt; claimed as an interrupt, so it takes no turn. */
const moveStopId = (moveId: string) => moveId.replace(/:reschedule$/, ":move-stop");

/** Refusals that say nothing about the move itself: it is asked for again on a later pass. */
const TRANSIENT = new Set(["no_capacity", "host_still_answers", "not_allowed"]);

export const makeGoalMoves = (deps: {
  readonly store: GoalStore["Service"];
  readonly runtime: GoalWorkerRuntime["Service"];
  readonly rescheduler: Rescheduler["Service"];
  readonly goal: FleetGoal;
  readonly nowIso: string;
  readonly authority: ReturnType<typeof actionAuthority>;
  readonly claim: (
    actionId: string,
    kind: "launch" | "interrupt",
    worker: WorkerRecord,
    host: string | null,
  ) => Effect.Effect<ClaimRefusal | "consumed" | null, GoalStoreError>;
  readonly setWorker: (worker: WorkerRecord) => void;
  readonly note: (
    type: FleetGoalEvent["type"],
    reason: string,
    message: string,
    worker: WorkerRecord,
    actionId: string,
  ) => void;
  readonly issue: (issue: ActionIssue) => void;
  readonly fail: () => void;
}) => {
  const { store, runtime, rescheduler, goal, nowIso, authority } = deps;
  const owner = FleetOwnerKey.make("goal:" + goal.id);

  const unconfirmed = (worker: WorkerRecord, actionId: string, message: string) => {
    deps.fail();
    deps.setWorker({ ...worker, note: message });
    deps.issue({
      condition: "Degraded",
      reason: "MoveUnconfirmed",
      message: "Slot " + worker.slot + ": " + message,
    });
    deps.note(
      "Warning",
      "MoveUnconfirmed",
      "Slot " + worker.slot + ": " + message,
      worker,
      actionId,
    );
  };

  const moved = Effect.fn("GoalMoves.moved")(function* (
    worker: WorkerRecord,
    actionId: string,
    to: { readonly host: string | null; readonly threadId: string; readonly branch: string },
    why: string,
    modelSelection?: ModelSelection,
  ) {
    // The thread is recorded on the receipt, which outlives the status write that follows.
    yield* store.settle(actionId, "rescheduled", nowIso, {
      host: to.host,
      threadId: to.threadId,
    });
    deps.setWorker({
      // A successor that launched is the slot's attempt even if the cap was lowered since.
      ...successorOf(goal, worker, why),
      host: to.host,
      threadId: to.threadId as WorkerRecord["threadId"],
      branch: to.branch,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      state: "running",
    });
    deps.note(
      "Normal",
      "Rescheduled",
      "Slot " +
        worker.slot +
        " moved to attempt " +
        (worker.attempt + 1) +
        " on " +
        (to.host ?? "this machine") +
        ".",
      worker,
      actionId,
    );
  });

  /**
   * Recorded before the move's interrupt is sent, so a stop whose answer is lost, or a restart
   * right after it, still reads as the goal's own: the move goes on instead of asking a person.
   */
  const recordStop = Effect.fn("GoalMoves.recordStop")(
    function* (worker: WorkerRecord, actionId: string) {
      const stopId = moveStopId(actionId);
      const refused = yield* deps.claim(stopId, "interrupt", worker, worker.host);
      if (refused !== null)
        return yield* new RescheduleNotAllowed({
          message: "The goal changed before its run could be stopped (" + refused + ").",
        });
      yield* store.settle(stopId, "stop_requested", nowIso);
    },
    // Not recorded, not sent: a stop the goal cannot later recognise would read as a person's.
    Effect.mapError((error) =>
      error instanceof RescheduleNotAllowed
        ? error
        : new RescheduleNotAllowed({ message: "Could not record the stop: " + error.message }),
    ),
  );

  /** What the Rescheduler made of one move of worker off its host, under the owner's authority now. */
  const send = Effect.fn("GoalMoves.send")(function* (
    worker: WorkerRecord & { readonly host: string | null; readonly threadId: ThreadId },
    actionId: string,
    current: OwnerAccess,
    reason: Exclude<RescheduleReason, "manual">,
    selection: ModelSelection,
    stopRunId: RunId | null,
  ) {
    const allowed = yield* runtime
      .moveAuthority(
        current,
        goal,
        authority.confirm("launch", authority.planned(current)),
        worker.host,
      )
      .pipe(Effect.result);
    // Refused before anything was sent.
    if (allowed._tag === "Failure")
      return {
        _tag: "Refused",
        reason: "not_allowed",
        message: allowed.failure.message,
      } satisfies RescheduleResult;
    const may = allowed.success;
    const project = yield* runtime.project(goal);
    const branch = successorBranch(goal, worker);
    return yield* rescheduler.reschedule({
      ref: { host: worker.host, threadId: worker.threadId, watchId: worker.watchId },
      owner,
      attempt: worker.attempt,
      reason,
      modelSelection: selection,
      workspace: {
        baseRef: goal.spec.workers.workspace.baseRef,
        branch,
        startFromOrigin: goal.spec.workers.workspace.startFromOrigin,
      },
      previousBranch: worker.branch,
      replica: null,
      prompt: renderPrompt(goal, { ...worker, attempt: worker.attempt + 1 }, branch),
      runtimeMode: may.runtimeMode,
      callerRuntimeMode: may.callerRuntimeMode,
      clientRequestId: launchActionId(goal, worker.slot, worker.attempt + 1),
      ...(project === null ? {} : { project }),
      maxAttempts: goal.spec.limits.maxAttemptsPerWorker,
      holdUnconfirmed: true,
      authorize: may.authorize,
      authorizeSource: may.authorizeSource,
      beforeStop: recordStop(worker, actionId),
      ...(stopRunId === null ? {} : { stopRunId }),
      ...(may.allowedHosts === undefined ? {} : { allowedHosts: may.allowedHosts }),
      ...(may.excludeHosts === undefined ? {} : { excludeHosts: may.excludeHosts }),
      ...(may.permissionProfileCeiling === undefined
        ? {}
        : { permissionProfileCeiling: may.permissionProfileCeiling }),
      ...(may.prepareCeiling === undefined ? {} : { prepareCeiling: may.prepareCeiling }),
    });
  });

  const refusal = (worker: WorkerRecord, actionId: string, why: string, message: string) => {
    deps.fail();
    deps.setWorker({ ...worker, note: message });
    deps.issue({
      condition: "Degraded",
      reason: "RescheduleRefused",
      message: "Slot " + worker.slot + ": " + message,
    });
    deps.note(
      "Warning",
      "RescheduleRefused",
      "Slot " + worker.slot + " (" + why + "): " + message,
      worker,
      actionId,
    );
  };

  /**
   * The move had to interrupt its attempt first. Its receipt stays open, so the slot keeps waiting
   * for it (resolve_move), which goes on once the run has stopped.
   */
  const stopped = (worker: WorkerRecord, actionId: string, message: string) => {
    deps.setWorker({ ...worker, note: message });
    deps.note("Normal", "MoveStopping", "Slot " + worker.slot + ": " + message, worker, actionId);
  };

  /**
   * The source still runs, or no longer drains: the drain move is called off before it sent
   * anything, and asked for again only while the host drains and the attempt is idle.
   */
  const deferred = (worker: WorkerRecord, actionId: string, message: string) => {
    deps.setWorker({ ...worker, note: message });
    deps.note("Normal", "MoveDeferred", "Slot " + worker.slot + ": " + message, worker, actionId);
  };

  /**
   * Moves a stopped or lost worker; `handled` is the worker once this run counts as recovered.
   * Only a drain moves a worker off this machine; ordinary recovery restarts it here.
   */
  const move = Effect.fn("GoalMoves.move")(function* (input: {
    readonly worker: WorkerRecord;
    readonly handled: WorkerRecord;
    readonly reason: Exclude<RescheduleReason, "manual">;
    readonly runId: RunId | null;
    readonly selection: ModelSelection;
  }) {
    const { worker } = input;
    const { host, threadId } = worker;
    if (threadId === null || (host === null && input.reason !== "drain")) return;
    const actionId = rescheduleActionId(
      goal,
      worker.slot,
      worker.attempt,
      input.runId ?? input.reason,
    );
    if ((yield* deps.claim(actionId, "launch", worker, host)) !== null) return;
    const current = yield* authority.afterClaim(actionId, "launch");
    if (current === null) return;
    const result = yield* send(
      { ...worker, host, threadId },
      actionId,
      current,
      input.reason,
      input.selection,
      input.runId,
    );
    switch (result._tag) {
      case "Rescheduled":
        return yield* moved(
          worker,
          actionId,
          { host: result.host ?? host, threadId: result.threadId, branch: result.branch },
          "Rescheduled after " + input.reason + ".",
          input.selection,
        );
      case "Unconfirmed":
        // The receipt stays open: the slot waits for resolve_move to find the thread.
        return unconfirmed(worker, actionId, result.message);
      case "Refused":
        if (result.stopping === true) return stopped(worker, actionId, result.message);
        if (input.reason === "drain" && result.reason === "host_still_answers") {
          yield* store.settle(actionId, NOT_SENT, nowIso);
          return deferred(worker, actionId, result.message);
        }
        // Nothing was sent, or nothing launched: transient refusals may be asked again later.
        yield* store.settle(actionId, TRANSIENT.has(result.reason) ? NOT_SENT : "refused", nowIso);
        return refusal(
          TRANSIENT.has(result.reason) ? worker : input.handled,
          actionId,
          input.reason,
          result.message,
        );
    }
  });

  /**
   * Settles or carries on an open move, from what its destination shows. A move that never
   * launched is released unless it stopped its attempt to take it over and may still proceed:
   * then it goes on, outside the turn budget it already spent.
   */
  const resolve = Effect.fn("GoalMoves.resolve")(function* (
    worker: WorkerRecord,
    action: {
      readonly actionId: string;
      readonly clientRequestId: string;
      readonly stopRunId: RunId | null;
      readonly proceed: boolean;
    },
    current: OwnerAccess,
  ) {
    const found = yield* rescheduler.findMove({ clientRequestId: action.clientRequestId, owner });
    if (found._tag === "Launched")
      return yield* moved(
        worker,
        action.actionId,
        found,
        "Its move to " + found.host + " was confirmed.",
      );
    if (found._tag === "Unknown") return unconfirmed(worker, action.actionId, found.message);
    const { host, threadId } = worker;
    const ours = (yield* store.claimOf(moveStopId(action.actionId))) !== null;
    if (!ours || !action.proceed || host === null || threadId === null) {
      // Nothing launched, so nothing holds the slot; moving again is new work, budget and all.
      yield* store.settle(action.actionId, NOT_SENT, nowIso);
      const why = ours ? "Its move was called off before it started." : "Its move never started.";
      deps.setWorker({ ...worker, note: why });
      deps.note(
        "Warning",
        "MoveNotStarted",
        "Slot " + worker.slot + ": " + why,
        worker,
        action.actionId,
      );
      return;
    }
    const result = yield* send(
      { ...worker, host, threadId },
      action.actionId,
      current,
      "stalled",
      worker.modelSelection,
      action.stopRunId,
    );
    switch (result._tag) {
      case "Rescheduled":
        return yield* moved(
          worker,
          action.actionId,
          { host: result.host ?? host, threadId: result.threadId, branch: result.branch },
          "Moved once its stopped run let it.",
        );
      case "Unconfirmed":
        return unconfirmed(worker, action.actionId, result.message);
      case "Refused":
        if (result.stopping === true) return stopped(worker, action.actionId, result.message);
        // The receipt stays open on a transient refusal, so the stop stays the goal's.
        if (!TRANSIENT.has(result.reason)) yield* store.settle(action.actionId, "refused", nowIso);
        return refusal(worker, action.actionId, "stalled", result.message);
    }
  });

  return { move, resolve };
};
