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
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { Rescheduler, RescheduleReason } from "../health/Rescheduler.ts";
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
import { branchFor, launchActionId, nextAttempt, rescheduleActionId } from "./goalWorkers.ts";
import type { GoalWorkerRuntime } from "./GoalWorkerRuntime.ts";

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
    kind: "launch",
    worker: WorkerRecord,
    host: string | null,
  ) => Effect.Effect<ClaimRefusal | null, GoalStoreError>;
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
    to: { readonly host: string; readonly threadId: string; readonly branch: string },
    why: string,
    modelSelection?: ModelSelection,
  ) {
    // The thread is recorded on the receipt, which outlives the status write that follows.
    yield* store.settle(actionId, "rescheduled", nowIso, {
      host: to.host,
      threadId: to.threadId,
    });
    deps.setWorker({
      ...nextAttempt(goal, worker, why),
      host: to.host,
      threadId: to.threadId as WorkerRecord["threadId"],
      branch: to.branch,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      state: "running",
    });
    deps.note(
      "Normal",
      "Rescheduled",
      "Slot " + worker.slot + " moved to attempt " + (worker.attempt + 1) + " on " + to.host + ".",
      worker,
      actionId,
    );
  });

  /** Moves a stopped or lost worker; `handled` is the worker once this run counts as recovered. */
  const move = Effect.fn("GoalMoves.move")(function* (input: {
    readonly worker: WorkerRecord;
    readonly handled: WorkerRecord;
    readonly reason: Exclude<RescheduleReason, "drain" | "manual">;
    readonly runId: RunId | null;
    readonly selection: ModelSelection;
  }) {
    const { worker } = input;
    if (worker.threadId === null || worker.host === null) return;
    const actionId = rescheduleActionId(
      goal,
      worker.slot,
      worker.attempt,
      input.runId ?? input.reason,
    );
    if ((yield* deps.claim(actionId, "launch", worker, worker.host)) !== null) return;
    const current = yield* authority.afterClaim(actionId, "launch");
    if (current === null) return;
    const refused = Effect.fn("GoalMoves.refused")(function* (
      message: string,
      settle: string,
      next: WorkerRecord,
    ) {
      yield* store.settle(actionId, settle, nowIso);
      deps.fail();
      deps.setWorker({ ...next, note: message });
      deps.issue({
        condition: "Degraded",
        reason: "RescheduleRefused",
        message: "Slot " + worker.slot + ": " + message,
      });
      deps.note(
        "Warning",
        "RescheduleRefused",
        "Slot " + worker.slot + " (" + input.reason + "): " + message,
        worker,
        actionId,
      );
    });
    const allowed = yield* runtime
      .moveAuthority(current, goal, authority.confirm("launch", authority.planned(current)))
      .pipe(Effect.result);
    // Refused before anything was sent: the move may be asked for again.
    if (allowed._tag === "Failure")
      return yield* refused(allowed.failure.message, NOT_SENT, worker);
    const may = allowed.success;
    const project = yield* runtime.project(goal);
    const branch = branchFor(goal, worker.slot, worker.attempt + 1);
    const result = yield* rescheduler.reschedule({
      ref: { host: worker.host, threadId: worker.threadId, watchId: worker.watchId },
      owner,
      attempt: worker.attempt,
      reason: input.reason,
      modelSelection: input.selection,
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
      ...(may.allowedHosts === undefined ? {} : { allowedHosts: may.allowedHosts }),
      ...(may.excludeHosts === undefined ? {} : { excludeHosts: may.excludeHosts }),
      ...(may.permissionProfileCeiling === undefined
        ? {}
        : { permissionProfileCeiling: may.permissionProfileCeiling }),
      ...(may.prepareCeiling === undefined ? {} : { prepareCeiling: may.prepareCeiling }),
    });
    switch (result._tag) {
      case "Rescheduled":
        return yield* moved(
          worker,
          actionId,
          { host: result.host ?? worker.host, threadId: result.threadId, branch: result.branch },
          "Rescheduled after " + input.reason + ".",
          input.selection,
        );
      case "Unconfirmed":
        // The receipt stays open: the slot waits for resolve_move to find the thread.
        return unconfirmed(worker, actionId, result.message);
      case "Refused":
        return yield* TRANSIENT.has(result.reason)
          ? refused(result.message, NOT_SENT, worker)
          : refused(result.message, "refused", input.handled);
    }
  });

  /** Settles a move whose answer was lost, from what its destination shows. */
  const resolve = Effect.fn("GoalMoves.resolve")(function* (
    worker: WorkerRecord,
    action: { readonly actionId: string; readonly clientRequestId: string },
  ) {
    const found = yield* rescheduler.findMove({ clientRequestId: action.clientRequestId, owner });
    switch (found._tag) {
      case "Launched":
        return yield* moved(
          worker,
          action.actionId,
          found,
          "Its move to " + found.host + " was confirmed.",
        );
      case "NotLaunched":
        // Nothing was sent, so nothing holds the slot; moving again is new work, budget and all.
        yield* store.settle(action.actionId, NOT_SENT, nowIso);
        deps.setWorker({ ...worker, note: "Its move never started." });
        deps.note(
          "Warning",
          "MoveNotStarted",
          "Slot " + worker.slot + ": its move never started.",
          worker,
          action.actionId,
        );
        return;
      case "Unknown":
        return unconfirmed(worker, action.actionId, found.message);
    }
  });

  return { move, resolve };
};
