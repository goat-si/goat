/**
 * Whether a goal's action may still run: read again after the action is claimed, and once more as
 * the last step before its command is handed to the orchestrator (docs/internals/agentic-k8s.md,
 * "Authority and safety"). The stored goal is read too, so a spec change, a lowered ceiling or a
 * deletion that lands while an action is under way stops it.
 */
import type { FleetGoal, RuntimeMode } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ActionIssue } from "./goalPlan.ts";
import { type GoalStore, NOT_SENT } from "./GoalStore.ts";
import {
  effectiveRuntimeMode,
  GoalOwnerAuthorityLost,
  type GoalWorkerRuntime,
  type OwnerAccess,
  runtimeModeCovers,
} from "./GoalWorkerRuntime.ts";

export type ActionKind = "launch" | "followup" | "fallback" | "interrupt";

/**
 * How a launch refused for lost authority settles. Any thread it left never got its first message
 * or its worktree, so it is never adopted; with no thread, the same attempt is sent again.
 */
export const OWNER_REFUSED = "owner_refused";

export const isLost = Schema.is(GoalOwnerAuthorityLost);

export const actionAuthority = ({
  store,
  runtime,
  goal,
  nowIso,
  block,
}: {
  readonly store: GoalStore["Service"];
  readonly runtime: GoalWorkerRuntime["Service"];
  /** The goal as this pass planned it. */
  readonly goal: FleetGoal;
  readonly nowIso: string;
  /** Receives the Blocked issue a lost authority raises. */
  readonly block: (issue: ActionIssue) => void;
}) => {
  /**
   * The goal and its owner's authority now. An action planned at `planned` is refused when the
   * goal moved on (a new generation, or a deletion for anything but an interrupt), the owner can
   * no longer act, or the owner's mode fell below the plan.
   */
  const current = Effect.fn("GoalAuthority.current")(function* (
    kind: ActionKind,
    planned: RuntimeMode | null,
  ) {
    const stored = yield* store.get(goal.id).pipe(Effect.result);
    if (stored._tag === "Failure")
      return new GoalOwnerAuthorityLost({
        message: "The goal could not be read again before acting.",
        goalChanged: false,
      });
    const latest = stored.success?.goal;
    if (
      latest === undefined ||
      latest.generation !== goal.generation ||
      (latest.deletionRequestedAt !== null && kind !== "interrupt")
    )
      return new GoalOwnerAuthorityLost({
        message: "The goal changed before this action was sent.",
        goalChanged: true,
      });
    const access = yield* runtime.owner(latest);
    if ("unavailable" in access)
      return new GoalOwnerAuthorityLost({ message: access.unavailable, goalChanged: false });
    const mode = kind === "interrupt" ? access.runtimeMode : effectiveRuntimeMode(access, latest);
    if (planned !== null && !runtimeModeCovers(mode, planned))
      return new GoalOwnerAuthorityLost({
        message:
          "The owner may now act only in " + mode + " mode, below the " + planned + " planned.",
        goalChanged: false,
      });
    // Last, so a revocation that lands while the profile or the goal is read is still seen. A
    // thread owner's constructed scope has no grant to ask; an outside client's asks its session.
    if (access.scope.reauthorize !== undefined) {
      const live = yield* access.scope.reauthorize(["orchestration:operate"]).pipe(Effect.result);
      if (live._tag === "Failure")
        return new GoalOwnerAuthorityLost({ message: live.failure.message, goalChanged: false });
    }
    return access;
  });

  /** An action refused for lost authority was never sent, so its claim may be taken again. */
  const lost = Effect.fn("GoalAuthority.lost")(function* (
    actionId: string,
    refusal: GoalOwnerAuthorityLost,
  ) {
    yield* store.settle(actionId, NOT_SENT, nowIso);
    if (!refusal.goalChanged)
      block({ condition: "Blocked", reason: "OwnerAuthorityLost", message: refusal.message });
  });

  return {
    lost,
    /** The owner's authority after a claim; null when the action must not run. */
    afterClaim: Effect.fn("GoalAuthority.afterClaim")(function* (
      actionId: string,
      kind: ActionKind,
    ) {
      const latest = yield* current(kind, null);
      if (!isLost(latest)) return latest;
      yield* lost(actionId, latest);
      return null;
    }),
    /** The runtime runs this last, right before it hands the action's command over. */
    confirm: (kind: ActionKind, planned: RuntimeMode) =>
      current(kind, planned).pipe(
        Effect.flatMap((latest) => (isLost(latest) ? Effect.fail(latest) : Effect.void)),
      ),
    /** The mode a launch or follow-up is planned at with this access. */
    planned: (access: OwnerAccess) => effectiveRuntimeMode(access, goal),
  };
};
