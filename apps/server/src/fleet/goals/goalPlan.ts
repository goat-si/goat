/**
 * The goal controller's decisions without I/O (docs/internals/agentic-k8s.md, "Controller"): from
 * a goal, its slot records and what was just observed, the next status, slot records and a
 * bounded list of actions. Level-triggered: the same observation gives the same plan, and every
 * action id comes from the goal, slot, attempt and run, so a repeated or restarted pass names the
 * same action, which the claim table and the receiver dedupe.
 */
import type {
  FleetGoal,
  FleetGoalEvent,
  FleetGoalPhase,
  FleetGoalStatus,
  GoalCondition,
  GoalConditionType,
  GoalWorkerPullRequest,
  OrchestrationV2ProviderFailureClass,
  ModelSelection,
  RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadHealth } from "../health/Health.ts";
import { publicWorker, type WorkerRecord } from "./GoalStore.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import {
  desiredSlots,
  followUpActionId,
  interruptActionId,
  newWorker,
  rescheduleActionId,
  resumeActionId,
} from "./goalWorkers.ts";

export const LAUNCH_GRACE_MS = 300_000;
export const MAX_ACTIONS_PER_GOAL = 3;
export const MAX_ACTIONS_PER_TICK = 10;
export const MAX_GOALS_PER_TICK = 20;
const RECONCILE_INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** Follow-ups per attempt before the slot asks for a person. */
const MAX_FOLLOW_UPS = 3;

export {
  branchFor,
  desiredSlots,
  fallbackActionId,
  launchActionId,
  newWorker,
  nextAttempt,
  ORPHAN_SLOT_BASE,
  repairWorkers,
  targetKey,
} from "./goalWorkers.ts";

export const nextDelayMs = (failures: number) =>
  failures <= 0
    ? RECONCILE_INTERVAL_MS
    : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

export type SlotObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly message: string }
  | {
      readonly kind: "seen";
      readonly health: ThreadHealth;
      readonly terminal: boolean;
      readonly runId: RunId | null;
      readonly runStatus: string | null;
      readonly lastActivityAt: string | null;
      /** When a usage limit on the latest run resets; null when unknown or not limited. */
      readonly usageLimitResetAt?: string | null;
      /** The thread's model as its host reports it; absent for a local worker. */
      readonly modelSelection?: ModelSelection | null;
      readonly result: {
        readonly reported: boolean;
        readonly pullRequest: number | null;
      } | null;
    };

export type PullRequestObservation =
  | {
      readonly kind: "seen";
      readonly state: GoalWorkerPullRequest["state"];
      readonly checks: GoalWorkerPullRequest["checks"];
    }
  | { readonly kind: "unknown"; readonly message: string };

export interface GoalObservation {
  readonly now: number;
  readonly owner:
    | { readonly available: true }
    | { readonly available: false; readonly reason: string };
  /** By slot, for slots that have a thread. */
  readonly workers: ReadonlyMap<number, SlotObservation>;
  /** Claims of the launches recorded on slots that have no thread yet. */
  readonly launchClaims: ReadonlyMap<
    string,
    { readonly claimedAt: number; readonly settled: boolean } | null
  >;
  /** Reschedules claimed that did not move their slot: refused, never sent, or never settled. */
  readonly unmovedReschedules: ReadonlySet<string>;
  /** Moves claimed and not settled, by slot; each holds its slot until it is resolved. */
  readonly pendingMoves: ReadonlyMap<
    number,
    { readonly actionId: string; readonly attempt: number; readonly clientRequestId: string }
  >;
  /** Fallbacks and hub hops that continued their run in its own thread, by action id. */
  readonly switchedFallbacks: ReadonlySet<string>;
  readonly pullRequests: ReadonlyMap<number, PullRequestObservation>;
  readonly issues: ReadonlyMap<number, "open" | "closed" | "unknown">;
  readonly turns: number;
  /** When the goal's first action was claimed; the wall-clock budget runs from here. */
  readonly firstClaimAt: number | null;
}

export type GoalAction =
  | {
      readonly type: "launch";
      readonly slot: number;
      readonly attempt: number;
      readonly actionId: string;
    }
  | {
      readonly type: "resolve_launch";
      readonly slot: number;
      readonly attempt: number;
      readonly actionId: string;
      /** The grace passed: not found means the next attempt. */
      readonly expired: boolean;
    }
  | {
      readonly type: "followup";
      readonly slot: number;
      readonly attempt: number;
      readonly runId: RunId;
      readonly actionId: string;
      readonly message: string;
    }
  | {
      readonly type: "recover";
      readonly slot: number;
      readonly attempt: number;
      readonly runId: RunId | null;
      readonly reason: "failed" | "stalled" | "host_unreachable";
      readonly failureClass: OrchestrationV2ProviderFailureClass;
    }
  | {
      readonly type: "interrupt";
      readonly slot: number;
      readonly attempt: number;
      readonly actionId: string;
    }
  | {
      /** Continue a run that stopped at a usage limit, once the limit has reset. */
      readonly type: "resume";
      readonly slot: number;
      readonly attempt: number;
      readonly runId: RunId;
      readonly actionId: string;
    }
  | {
      /** Finds what an unconfirmed move to another host started; it takes no turn. */
      readonly type: "resolve_move";
      readonly slot: number;
      readonly attempt: number;
      readonly actionId: string;
      readonly clientRequestId: string;
    }
  | { readonly type: "delete_row" };

export interface GoalPlan {
  readonly status: FleetGoalStatus;
  readonly workers: ReadonlyArray<WorkerRecord>;
  readonly actions: ReadonlyArray<GoalAction>;
  readonly events: ReadonlyArray<FleetGoalEvent>;
  readonly truncated: boolean;
}

/** A problem an action ran into, which the final status reports as a condition. */
export interface ActionIssue {
  readonly condition: "Blocked" | "Degraded";
  readonly reason: string;
  readonly message: string;
}

const ACTIVE: ReadonlySet<WorkerRecord["state"]> = new Set([
  "placing",
  "launching",
  "launch_unknown",
  "running",
  "stalled",
]);

/** Stopping work and finding what earlier launches and moves started: never new work. */
const cleanup = (action: GoalAction) =>
  action.type === "interrupt" || action.type === "resolve_launch" || action.type === "resolve_move";

export function planGoal(
  goal: FleetGoal,
  previous: ReadonlyArray<WorkerRecord>,
  observation: GoalObservation,
): GoalPlan {
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(observation.now));
  const { spec } = goal;
  const kinds = new Set(spec.doneWhen.map((entry) => entry.type));
  const events: Array<FleetGoalEvent> = [];
  const event = (
    type: FleetGoalEvent["type"],
    reason: string,
    message: string,
    worker?: WorkerRecord,
  ) =>
    events.push({
      at: nowIso,
      type,
      reason,
      message,
      slot: worker?.slot ?? null,
      attempt: worker?.attempt ?? null,
      actionId: null,
    });

  const desired = desiredSlots(goal);
  const bySlot = new Map(previous.map((worker) => [worker.slot, worker]));
  const actions: Array<GoalAction> = [];
  let unobserved = false;
  const prTargets = spec.targets.flatMap((target) =>
    target.type === "pull_request" ? [target.number] : [],
  );

  const judge = (start: WorkerRecord): WorkerRecord => {
    let worker = start;
    if (worker.state === "succeeded" || worker.state === "failed" || worker.state === "superseded")
      return worker;
    if (worker.threadId === null) {
      const claim = observation.launchClaims.get(worker.launchClientRequestId) ?? null;
      if (claim === null) {
        actions.push({
          type: "launch",
          slot: worker.slot,
          attempt: worker.attempt,
          actionId: worker.launchClientRequestId,
        });
        return { ...worker, state: "placing" };
      }
      // Claimed and never confirmed: never sent again under the same attempt.
      actions.push({
        type: "resolve_launch",
        slot: worker.slot,
        attempt: worker.attempt,
        actionId: worker.launchClientRequestId,
        expired: observation.now - claim.claimedAt > LAUNCH_GRACE_MS,
      });
      return { ...worker, state: "launch_unknown" };
    }
    const seen = observation.workers.get(worker.slot) ?? {
      kind: "unknown" as const,
      message: "Not observed this pass.",
    };
    if (seen.kind === "missing")
      return {
        ...worker,
        state: "failed",
        note: "The worker thread is gone; it is not relaunched.",
      };
    if (seen.kind === "unknown") {
      unobserved = true;
      return { ...worker, note: seen.message };
    }
    const hostModel = seen.modelSelection;
    worker = {
      ...worker,
      lastActivityAt: seen.lastActivityAt ?? worker.lastActivityAt,
      lastRunId: seen.runId ?? worker.lastRunId,
      // A worker on another host runs the model its thread reports, as after a lost status write.
      ...(hostModel == null ||
      (hostModel.instanceId === worker.modelSelection.instanceId &&
        hostModel.model === worker.modelSelection.model)
        ? {}
        : { modelSelection: hostModel }),
      note: null,
    };
    const fresh = seen.runId !== null && worker.followedUpRunId !== seen.runId;
    // Each run is recovered once. A row an earlier controller wrote marks a run followed up both
    // after a same-thread fallback it sent and after a move that did not happen; only the move
    // left it without a way forward (#1452). A sent fallback's receipt also outlives a lost status
    // write, while its message may wait held behind the failed run.
    const runPrefix = (runId: string) =>
      "goal:" + goal.id + ":s" + worker.slot + ":a" + worker.attempt + ":" + runId + ":";
    const switched = (runId: string) =>
      [...observation.switchedFallbacks].some((id) => id.startsWith(runPrefix(runId)));
    const unrecovered =
      seen.runId !== null &&
      worker.recoveredRunId !== seen.runId &&
      !switched(seen.runId) &&
      (fresh ||
        observation.unmovedReschedules.has(
          rescheduleActionId(goal, worker.slot, worker.attempt, seen.runId),
        ));
    const followUp = (message: string): WorkerRecord => {
      if (seen.runId === null || !fresh) return worker;
      if (worker.followUps >= MAX_FOLLOW_UPS)
        return { ...worker, state: "needs_human", note: "Follow-up limit reached." };
      actions.push({
        type: "followup",
        slot: worker.slot,
        attempt: worker.attempt,
        runId: seen.runId,
        actionId: followUpActionId(goal, worker.slot, worker.attempt, seen.runId),
        message,
      });
      return worker;
    };
    const recover = (
      reason: "failed" | "stalled" | "host_unreachable",
      failureClass: OrchestrationV2ProviderFailureClass,
      // A steered stall and a lost host ask again on every pass; the reschedule's next-attempt
      // launch id dedupes them instead.
      once = true,
    ) => {
      if (!once || unrecovered)
        actions.push({
          type: "recover",
          slot: worker.slot,
          attempt: worker.attempt,
          runId: seen.runId,
          reason,
          failureClass,
        });
    };
    if (!seen.terminal) {
      switch (seen.health._tag) {
        case "waiting":
          return { ...worker, state: "needs_human", note: "Waiting on a question or approval." };
        case "host_lost":
          if (spec.workers.onHostLost === "wait")
            return { ...worker, state: "needs_human", note: "Its host is unreachable." };
          recover("host_unreachable", "transport_error", false);
          return { ...worker, state: "stalled" };
        case "stalled":
          if (worker.steeredRunId !== seen.runId)
            return {
              ...followUp(
                "Report your status in one line: what you are doing now and what blocks you, then continue.",
              ),
              state: "stalled",
            };
          recover("stalled", "unknown", false);
          return { ...worker, state: "stalled" };
        default:
          return { ...worker, state: "running" };
      }
    }
    if (seen.runStatus === "interrupted" || seen.runStatus === "cancelled")
      // Someone stopped it on purpose; acting would fight them.
      return { ...worker, state: "needs_human", note: "A person stopped the run." };
    if (seen.runStatus === "failed") {
      const failureClass = seen.health._tag === "failed" ? seen.health.failureClass : "unknown";
      // A usage-limited run the fallback could not move waits for its reset, then the goal
      // continues it itself: goal threads are left out of the ordinary recovery sweep.
      if (failureClass === "usage_limit" && !fresh && seen.runId !== null) {
        if (worker.resumedRunId === seen.runId) return { ...worker, state: "running" };
        const resetAt = seen.usageLimitResetAt ?? null;
        // Another host does not say when its limit resets, and GOAT there resumes its own threads.
        if (resetAt === null && worker.host !== null)
          return {
            ...worker,
            state: "needs_human",
            note:
              worker.host +
              " holds this run at its usage limit; GOAT there or a person continues it.",
          };
        if (resetAt !== null && observation.now >= Date.parse(resetAt)) {
          actions.push({
            type: "resume",
            slot: worker.slot,
            attempt: worker.attempt,
            runId: seen.runId,
            actionId: resumeActionId(goal, worker.slot, worker.attempt, seen.runId),
          });
          return { ...worker, state: "running", note: "Its usage limit has reset." };
        }
        return {
          ...worker,
          state: "running",
          note:
            resetAt === null
              ? "Waits for its usage limit to reset."
              : "Waits for its usage limit to reset at " + resetAt + ".",
        };
      }
      recover("failed", failureClass);
      return { ...worker, state: "running", note: "The run failed." };
    }
    const prNumber = worker.pullRequest?.number ?? seen.result?.pullRequest ?? null;
    const pr = prNumber === null ? undefined : observation.pullRequests.get(prNumber);
    if (prNumber !== null && pr?.kind === "seen")
      worker = { ...worker, pullRequest: { number: prNumber, state: pr.state, checks: pr.checks } };
    if (prNumber !== null && pr?.kind === "unknown") unobserved = true;
    const reported = worker.reported || seen.result?.reported === true;
    worker = { ...worker, reported };
    const settledPr = worker.pullRequest !== null && worker.pullRequest.state !== "open";
    const done =
      (!kinds.has("thread_reported_result") || reported) &&
      (!kinds.has("pull_requests_merged") || prNumber === null || settledPr) &&
      (!kinds.has("checks_green") ||
        prNumber === null ||
        settledPr ||
        worker.pullRequest?.checks === "passing");
    if (done) return { ...worker, state: "succeeded" };
    // Built from numbers and fixed text only: check names and errors come from outside, and
    // the worker reads them itself, so they never become part of an instruction.
    if (worker.pullRequest?.state === "open" && worker.pullRequest.checks === "failing")
      return {
        ...followUp(
          "CI failed on PR #" +
            worker.pullRequest.number +
            ". Read the failing checks on the pull request, fix them, push, and report again.",
        ),
        state: "running",
      };
    if (kinds.has("pull_requests_merged") && prTargets.length === 0 && prNumber === null)
      return {
        ...followUp(
          `Open a pull request for your work, then report it with ${goatCallText("thread.report_result")}.`,
        ),
        state: "running",
      };
    if (kinds.has("thread_reported_result") && !reported)
      return {
        ...followUp(
          `Report your result with ${goatCallText("thread.report_result")}: outcome, summary, and any pull request.`,
        ),
        state: "running",
      };
    return { ...worker, state: "running", note: "Waiting for the pull request to merge." };
  };

  const deleting = goal.deletionRequestedAt !== null;
  const owner = observation.owner;
  const workers: Array<WorkerRecord> = [];
  for (const { slot, target } of desired) {
    const stored = bySlot.get(slot);
    // A slot the spec dropped and now wants again starts a new attempt on a new branch.
    const known =
      stored === undefined
        ? newWorker(goal, slot, target)
        : stored.state === "superseded"
          ? {
              ...newWorker(goal, slot, target, stored.attempt + 1),
              modelSelection: stored.modelSelection,
              tried: stored.tried,
            }
          : stored;
    const unclear =
      known.threadId === null && observation.launchClaims.get(known.launchClientRequestId) != null;
    if (moving(known)) {
      workers.push(hold(known));
      continue;
    }
    workers.push(
      deleting && unclear
        ? judge(known)
        : deleting || spec.paused || !owner.available
          ? observeOnly(known)
          : judge(known),
    );
  }
  /** A slot whose move is unconfirmed takes no other action: it waits for its successor. */
  function moving(worker: WorkerRecord) {
    return observation.pendingMoves.get(worker.slot)?.attempt === worker.attempt;
  }
  function hold(worker: WorkerRecord): WorkerRecord {
    const move = observation.pendingMoves.get(worker.slot);
    if (move === undefined) return worker;
    actions.push({
      type: "resolve_move",
      slot: worker.slot,
      attempt: worker.attempt,
      actionId: move.actionId,
      clientRequestId: move.clientRequestId,
    });
    return {
      ...observeOnly(worker),
      note: worker.note ?? "Its move to another host is not confirmed yet.",
    };
  }
  function observeOnly(worker: WorkerRecord): WorkerRecord {
    const seen = observation.workers.get(worker.slot);
    if (seen?.kind !== "seen") return worker;
    return {
      ...worker,
      lastActivityAt: seen.lastActivityAt ?? worker.lastActivityAt,
      lastRunId: seen.runId ?? worker.lastRunId,
    };
  }
  const isLive = (worker: WorkerRecord) => {
    const seen = observation.workers.get(worker.slot);
    return worker.threadId !== null && seen?.kind === "seen" && !seen.terminal;
  };
  const interrupt = (worker: WorkerRecord): GoalAction => {
    const seen = observation.workers.get(worker.slot);
    return {
      type: "interrupt",
      slot: worker.slot,
      attempt: worker.attempt,
      actionId: interruptActionId(
        goal,
        worker.slot,
        worker.attempt,
        seen?.kind === "seen" ? seen.runId : null,
      ),
    };
  };
  /** Known to have stopped: no thread was ever started, the run ended, or the thread is gone. */
  const confirmedDone = (worker: WorkerRecord) => {
    if (worker.state === "launch_unknown" || moving(worker)) return false;
    if (worker.threadId === null) return true;
    const seen = observation.workers.get(worker.slot);
    return seen?.kind === "missing" || (seen?.kind === "seen" && seen.terminal);
  };
  // Slots the spec no longer asks for, and every live slot of a goal being deleted.
  const shrunk = previous.filter((worker) => worker.slot >= desired.length);
  // A dropped slot stays as it is until its run is confirmed stopped, so an interrupt that did
  // not fit in this pass, or failed, is planned again next pass.
  for (const worker of shrunk) {
    if (moving(worker)) {
      workers.push(hold(worker));
      continue;
    }
    const claim =
      worker.threadId === null
        ? (observation.launchClaims.get(worker.launchClientRequestId) ?? null)
        : null;
    if (claim !== null && worker.state !== "superseded") {
      // A dropped slot's unclear launch is still looked up, so its thread can be stopped.
      actions.push({
        type: "resolve_launch",
        slot: worker.slot,
        attempt: worker.attempt,
        actionId: worker.launchClientRequestId,
        expired: observation.now - claim.claimedAt > LAUNCH_GRACE_MS,
      });
      workers.push({ ...worker, state: "launch_unknown" });
      continue;
    }
    if (isLive(worker)) actions.push(interrupt(worker));
    workers.push(confirmedDone(worker) ? { ...worker, state: "superseded" } : worker);
  }
  if (deleting) {
    // Unclear launches are still looked up, since one may have started a thread to stop.
    const resolving = actions.filter(cleanup);
    actions.length = 0;
    actions.push(...resolving.filter((action) => action.type !== "interrupt"));
    const live = workers.filter(isLive);
    for (const worker of live) actions.push(interrupt(worker));
    // Like a finalizer: the row goes only once every attempt is known to have stopped. A worker
    // that cannot be read keeps the goal as a tombstone; goat_goal_delete with force drops it.
    if (workers.every(confirmedDone)) actions.push({ type: "delete_row" });
  }

  for (const worker of workers) {
    const before = bySlot.get(worker.slot);
    if (before !== undefined && before.state !== worker.state)
      event(
        worker.state === "failed" || worker.state === "stalled" || worker.state === "needs_human"
          ? "Warning"
          : "Normal",
        "Worker" + worker.state.replace(/(^|_)(\w)/g, (_m, _s, c: string) => c.toUpperCase()),
        "Slot " +
          worker.slot +
          " attempt " +
          worker.attempt +
          ": " +
          before.state +
          " → " +
          worker.state +
          (worker.note === null ? "" : ". " + worker.note),
        worker,
      );
  }

  const live = workers.filter((worker) => worker.slot < desired.length);
  const pullRequests = [
    ...new Set([
      ...prTargets,
      ...live.flatMap((worker) => (worker.pullRequest === null ? [] : [worker.pullRequest.number])),
    ]),
  ];
  const prState = (number: number) => observation.pullRequests.get(number);
  const issueTargets = spec.targets.flatMap((target) =>
    target.type === "issue" ? [target.number] : [],
  );
  const anyActive = live.some((worker) => ACTIVE.has(worker.state));
  const holds = {
    pull_requests_merged:
      pullRequests.length > 0 &&
      !anyActive &&
      pullRequests.every((number) => {
        const seen = prState(number);
        return seen?.kind === "seen" && seen.state === "merged";
      }),
    checks_green:
      pullRequests.length > 0 &&
      pullRequests.every((number) => {
        const seen = prState(number);
        return seen?.kind === "seen" && (seen.state === "merged" || seen.checks === "passing");
      }),
    thread_reported_result: live.length > 0 && live.every((worker) => worker.reported),
    issues_closed:
      issueTargets.length > 0 &&
      issueTargets.every((number) => observation.issues.get(number) === "closed"),
  };
  const done = spec.doneWhen.every((entry) => holds[entry.type]);
  const startedAt =
    observation.firstClaimAt === null
      ? goal.status.usage.startedAt
      : DateTime.formatIso(DateTime.makeUnsafe(observation.firstClaimAt));
  const budgetSpent =
    (spec.limits.maxTurns !== null && observation.turns >= spec.limits.maxTurns) ||
    (spec.limits.maxWallClockMs !== null &&
      startedAt !== null &&
      observation.now - Date.parse(startedAt) > spec.limits.maxWallClockMs);
  const needsHuman = live.filter((worker) => worker.state === "needs_human");
  const allFailed = live.length > 0 && live.every((worker) => worker.state === "failed");
  const troubled = live.some((worker) => worker.state === "failed" || worker.state === "stalled");

  let phase: FleetGoalPhase;
  let reason: string;
  let message: string;
  if (deleting) {
    phase = "deleting";
    reason = "Deleting";
    message = "Interrupting live workers before the goal is removed.";
  } else if (spec.paused) {
    phase = "paused";
    reason = "Paused";
    message = "Paused; no actions are taken.";
  } else if (!owner.available) {
    phase = "blocked";
    reason = "OwnerAuthorityLost";
    message = owner.reason;
  } else if (done) {
    phase = "succeeded";
    reason = "DoneWhenHolds";
    message = "Every doneWhen condition holds.";
  } else if (budgetSpent) {
    phase = "blocked";
    reason = "BudgetExhausted";
    message = "The goal spent its turn or time budget; a person decides what next.";
  } else if (allFailed) {
    phase = "failed";
    reason = "WorkersFailed";
    message = "Every slot failed and has no attempts left.";
  } else if (needsHuman.length > 0 && !anyActive) {
    phase = "blocked";
    reason = "NeedsHuman";
    message = needsHuman.length + " slots wait on a person.";
  } else if (troubled || unobserved) {
    phase = "degraded";
    reason = troubled ? "WorkersUnhealthy" : "ObservationFailed";
    message = troubled ? "Some slots failed or stalled." : "Some state could not be read.";
  } else if (
    live.every((worker) => worker.threadId === null) &&
    goal.status.lastReconcileAt === null &&
    actions.length === 0
  ) {
    phase = "pending";
    reason = "NothingStarted";
    message = "No worker has started.";
  } else {
    phase = "progressing";
    reason = "Working";
    message = live.filter((worker) => ACTIVE.has(worker.state)).length + " slots active.";
  }

  // Only deletion interrupts and the row removal survive a stop on acting.
  const allowed = deleting
    ? actions
    : spec.paused || !owner.available
      ? []
      : done
        ? // Done stops new work, but threads it may have started are still found and stopped.
          actions.filter(cleanup)
        : // A spent budget refuses new work; finding what a move already started is not new work.
          budgetSpent
          ? actions.filter(cleanup)
          : actions;
  const bounded = [
    ...allowed.filter(cleanup),
    ...allowed.filter((action) => !cleanup(action)),
  ].slice(0, MAX_ACTIONS_PER_GOAL);

  if (phase !== goal.status.phase)
    event(
      phase === "failed" || phase === "blocked" || phase === "degraded" ? "Warning" : "Normal",
      reason,
      "Phase " + goal.status.phase + " → " + phase + ": " + message,
    );

  const status: FleetGoalStatus = {
    ...goal.status,
    phase,
    observedGeneration: goal.generation,
    conditions: conditionsFor(goal, nowIso, {
      phase,
      reason,
      message,
      done,
      budgetSpent,
      needsHuman: needsHuman.length > 0,
      degraded: troubled || unobserved,
    }),
    workers: workers.map(publicWorker),
    usage: { ...goal.status.usage, turns: observation.turns, startedAt },
    lastReconcileAt: nowIso,
  };
  return { status, workers, actions: bounded, events, truncated: allowed.length > bounded.length };
}

function conditionsFor(
  goal: FleetGoal,
  nowIso: string,
  state: {
    readonly phase: FleetGoalPhase;
    readonly reason: string;
    readonly message: string;
    readonly done: boolean;
    readonly budgetSpent: boolean;
    readonly needsHuman: boolean;
    readonly degraded: boolean;
  },
): ReadonlyArray<GoalCondition> {
  const set = (
    type: GoalConditionType,
    on: boolean,
    reason: string,
    message: string,
  ): Omit<GoalCondition, "lastTransitionTime"> => ({
    type,
    status: on ? "True" : "False",
    reason,
    message,
    observedGeneration: goal.generation,
  });
  const blocked = state.phase === "blocked" || state.needsHuman;
  return mergeConditions(goal.status.conditions, nowIso, [
    set(
      "Ready",
      state.done,
      state.done ? "DoneWhenHolds" : state.reason,
      state.done ? "" : state.message,
    ),
    set("Done", state.done, "DoneWhenHolds", state.done ? state.message : ""),
    set("Progressing", state.phase === "progressing", state.reason, state.message),
    set(
      "Blocked",
      blocked,
      state.phase === "blocked" ? state.reason : state.needsHuman ? "NeedsHuman" : "NotBlocked",
      blocked ? state.message : "",
    ),
    set(
      "Degraded",
      state.degraded,
      state.degraded ? state.reason : "Healthy",
      state.degraded ? state.message : "",
    ),
    set(
      "BudgetExhausted",
      state.budgetSpent,
      state.budgetSpent ? "BudgetExhausted" : "WithinBudget",
      "",
    ),
  ]);
}

function mergeConditions(
  previous: ReadonlyArray<GoalCondition>,
  nowIso: string,
  next: ReadonlyArray<Omit<GoalCondition, "lastTransitionTime">>,
): ReadonlyArray<GoalCondition> {
  return next.map((condition) => {
    const before = previous.find((entry) => entry.type === condition.type);
    return {
      ...condition,
      lastTransitionTime:
        before !== undefined && before.status === condition.status
          ? before.lastTransitionTime
          : nowIso,
    };
  });
}

/** Folds what actions ran into the status: a refused placement blocks, a refused recovery degrades. */
export function applyIssues(
  goal: FleetGoal,
  status: FleetGoalStatus,
  issues: ReadonlyArray<ActionIssue>,
  nowIso: string,
): FleetGoalStatus {
  if (issues.length === 0) return status;
  const blocked = issues.find((issue) => issue.condition === "Blocked");
  const degraded = issues.find((issue) => issue.condition === "Degraded");
  const movable =
    status.phase === "progressing" || status.phase === "pending" || status.phase === "degraded";
  const phase: FleetGoalPhase =
    blocked !== undefined && movable
      ? "blocked"
      : degraded !== undefined && (status.phase === "progressing" || status.phase === "pending")
        ? "degraded"
        : status.phase;
  return {
    ...status,
    phase,
    conditions: status.conditions.map((condition) => {
      const issue =
        condition.type === "Blocked"
          ? blocked
          : condition.type === "Degraded"
            ? degraded
            : undefined;
      if (issue === undefined) return condition;
      return {
        ...condition,
        status: "True",
        reason: issue.reason,
        message: issue.message,
        lastTransitionTime: condition.status === "True" ? condition.lastTransitionTime : nowIso,
      };
    }),
  };
}

export const initialStatus = (): FleetGoalStatus => ({
  phase: "pending",
  observedGeneration: 0,
  conditions: [],
  workers: [],
  usage: { turns: 0, tokens: null, startedAt: null },
  lastReconcileAt: null,
  nextReconcileAt: null,
  failures: 0,
});
