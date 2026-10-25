/**
 * A goal's slot records and the ids its actions are claimed under. Every id comes from the goal,
 * slot, attempt and run, so a repeated or restarted pass names the same action. repairWorkers
 * rebuilds slot records from the launch records, which outlive any status write.
 */
import { type FleetGoal, type FleetGoalTarget, RunId } from "@goat/contracts";

import type { RescheduleReason } from "../health/reschedulePolicy.ts";
import { type LaunchClaim, NOT_SENT, type WorkerRecord } from "./GoalStore.ts";

export const launchActionId = (goal: Pick<FleetGoal, "id">, slot: number, attempt: number) =>
  "goal:" + goal.id + ":s" + slot + ":a" + attempt + ":launch";
export const followUpActionId = (
  goal: Pick<FleetGoal, "id">,
  slot: number,
  attempt: number,
  runId: string,
) => "goal:" + goal.id + ":s" + slot + ":a" + attempt + ":" + runId + ":followup";
export const fallbackActionId = (
  goal: Pick<FleetGoal, "id">,
  slot: number,
  attempt: number,
  runId: string,
  hop: number,
) => "goal:" + goal.id + ":s" + slot + ":a" + attempt + ":" + runId + ":fallback:" + hop;
export const resumeActionId = (
  goal: Pick<FleetGoal, "id">,
  slot: number,
  attempt: number,
  runId: string,
) => "goal:" + goal.id + ":s" + slot + ":a" + attempt + ":" + runId + ":resume";
/** One reschedule per run, or per reason when no run is known; claimed as a launch. */
export const rescheduleActionId = (
  goal: Pick<FleetGoal, "id">,
  slot: number,
  attempt: number,
  runOrReason: string,
) => "goal:" + goal.id + ":s" + slot + ":a" + attempt + ":" + runOrReason + ":reschedule";
/**
 * A move receipt's slot and attempt, read back from its id. The successor is the slot's next
 * attempt, so its launch id is the Rescheduler's clientRequestId and its branch is that attempt's.
 */
const REASONS: ReadonlySet<string> = new Set<RescheduleReason>([
  "stalled",
  "host_unreachable",
  "failed",
  "drain",
  "fallback_relaunch",
  "manual",
]);

const moveOf = (goal: Pick<FleetGoal, "id" | "spec">, actionId: string) => {
  const prefix = "goal:" + goal.id + ":s";
  if (!actionId.startsWith(prefix) || !actionId.endsWith(":reschedule")) return null;
  const parsed = /^(\d+):a(\d+):(.+):reschedule$/.exec(actionId.slice(prefix.length));
  if (parsed === null) return null;
  const slot = Number(parsed[1]);
  const attempt = Number(parsed[2]);
  const runOrReason = parsed[3] ?? "";
  return {
    slot,
    attempt,
    /** The run the move was taken for; null when it was taken for a reason alone. */
    runId: REASONS.has(runOrReason) ? null : RunId.make(runOrReason),
    successorAttempt: attempt + 1,
    successorLaunchId: launchActionId(goal, slot, attempt + 1),
    branch: branchFor(goal, slot, attempt + 1),
  };
};

/** Moves claimed and not settled: each holds its slot until resolve_move settles it. */
export const pendingMoves = (
  goal: Pick<FleetGoal, "id" | "spec">,
  launches: ReadonlyArray<LaunchClaim>,
) => {
  const pending = new Map<
    number,
    {
      readonly actionId: string;
      readonly attempt: number;
      readonly clientRequestId: string;
      readonly runId: RunId | null;
    }
  >();
  for (const launch of launches) {
    const move = moveOf(goal, launch.actionId);
    if (move === null || launch.settledAt !== null || launch.threadId !== null) continue;
    pending.set(move.slot, {
      actionId: launch.actionId,
      attempt: move.attempt,
      clientRequestId: move.successorLaunchId,
      runId: move.runId,
    });
  }
  return pending;
};

/** Names the run it stops: the id is the interrupt's command id, so a later run gets a new one. */
export const interruptActionId = (
  goal: Pick<FleetGoal, "id">,
  slot: number,
  attempt: number,
  runId: string | null,
) =>
  "goal:" +
  goal.id +
  ":s" +
  slot +
  ":a" +
  attempt +
  (runId === null ? "" : ":" + runId) +
  ":interrupt";

export const branchFor = (goal: Pick<FleetGoal, "spec">, slot: number, attempt: number) =>
  goal.spec.workers.workspace.branchPrefix.replace(/\/+$/, "") + "/s" + slot + "-a" + attempt;

export const targetKey = (target: FleetGoalTarget) =>
  target.type === "issue"
    ? "issue:" + target.number
    : target.type === "pull_request"
      ? "pull_request:" + target.number
      : target.type === "branch"
        ? "branch:" + target.name
        : "prompt:" + target.key;

/** The slots the spec asks for, each with the target it owns when slots follow targets. */
export const desiredSlots = (goal: Pick<FleetGoal, "spec">) => {
  const { workers, limits, targets } = goal.spec;
  const count = workers.perTarget ? targets.length : workers.count;
  return Array.from({ length: Math.min(count, limits.maxWorkers) }, (_, slot) => ({
    slot,
    target: workers.perTarget ? (targets[slot] ?? null) : null,
  }));
};

/** Slots for earlier attempts found only in launch records; they are stopped like dropped slots. */
export const ORPHAN_SLOT_BASE = 10_000;

const attemptOf = (actionId: string) => Number(/:a(\d+):launch$/.exec(actionId)?.[1] ?? 1);
const slotOf = (actionId: string) => Number(/:s(\d+):a\d+:launch$/.exec(actionId)?.[1] ?? 0);

/**
 * Rebuilds slot records from the launch records, which outlive any status write. A launch whose
 * thread is recorded is attached to its slot; one whose slot record was never written, or was
 * dropped by a write lost to a generation change, becomes that slot again; and a launch for a
 * slot that has since moved to another attempt becomes an orphan slot the plan stops. A claimed
 * launch with no outcome yet is kept as unclear, so nothing (deletion included) forgets it.
 */
export function repairWorkers(
  goal: FleetGoal,
  workers: ReadonlyArray<WorkerRecord>,
  launches: ReadonlyArray<LaunchClaim>,
): ReadonlyArray<WorkerRecord> {
  const bySlot = new Map(workers.map((worker) => [worker.slot, worker]));
  const threads = new Set(
    workers.flatMap((worker) => (worker.threadId === null ? [] : [worker.threadId as string])),
  );
  const referenced = new Set(workers.map((worker) => worker.launchClientRequestId));
  let nextOrphan = Math.max(ORPHAN_SLOT_BASE - 1, ...workers.map((worker) => worker.slot)) + 1;
  const targets = new Map(desiredSlots(goal).map(({ slot, target }) => [slot, target]));
  const orphan = (record: WorkerRecord, slot: number) => {
    bySlot.set(nextOrphan, {
      ...record,
      slot: nextOrphan,
      target: null,
      note: "An earlier attempt of slot " + slot + ".",
    });
    nextOrphan += 1;
  };
  for (const launch of launches) {
    if (launch.outcome === NOT_SENT) continue;
    if (launch.threadId !== null && threads.has(launch.threadId)) continue;
    const move = moveOf(goal, launch.actionId);
    if (move !== null) {
      // An unsettled move holds its slot through the plan, and one that ended without a thread
      // started nothing. A recorded successor whose slot write was lost becomes that slot again,
      // unless the slot has moved past it.
      if (launch.threadId === null) continue;
      const current = bySlot.get(move.slot);
      const successor: WorkerRecord = {
        ...newWorker(goal, move.slot, targets.get(move.slot) ?? null, move.successorAttempt),
        ...(current === undefined
          ? {}
          : {
              target: current.target,
              modelSelection: current.modelSelection,
              tried: current.tried,
            }),
        host: launch.host,
        threadId: launch.threadId as WorkerRecord["threadId"],
        branch: move.branch,
        state: "running",
      };
      if (current !== undefined && current.attempt > move.attempt) orphan(successor, move.slot);
      else {
        if (current?.threadId != null) orphan(current, move.slot);
        bySlot.set(move.slot, successor);
      }
      threads.add(launch.threadId);
      referenced.add(successor.launchClientRequestId);
      continue;
    }
    const slot = launch.slot ?? slotOf(launch.actionId);
    const current = bySlot.get(slot);
    if (current !== undefined && current.launchClientRequestId === launch.actionId) {
      if (current.threadId === null && launch.threadId !== null) {
        bySlot.set(slot, {
          ...current,
          host: launch.host,
          threadId: launch.threadId as WorkerRecord["threadId"],
          state: "running",
        });
        threads.add(launch.threadId);
      }
      continue;
    }
    // Settled without a thread: it failed or was given up; nothing started.
    if (launch.threadId === null && (launch.settledAt !== null || referenced.has(launch.actionId)))
      continue;
    const record: WorkerRecord = {
      ...newWorker(goal, slot, targets.get(slot) ?? null, attemptOf(launch.actionId)),
      launchClientRequestId: launch.actionId,
      host: launch.host,
      threadId: launch.threadId as WorkerRecord["threadId"],
      state: launch.threadId === null ? "launch_unknown" : "running",
    };
    if (current === undefined) bySlot.set(slot, record);
    else orphan(record, slot);
    if (launch.threadId !== null) threads.add(launch.threadId);
    referenced.add(launch.actionId);
  }
  return [...bySlot.values()].toSorted((left, right) => left.slot - right.slot);
}

export const newWorker = (
  goal: FleetGoal,
  slot: number,
  target: FleetGoalTarget | null,
  attempt = 1,
): WorkerRecord => ({
  slot,
  attempt,
  host: null,
  threadId: null,
  watchId: null,
  branch: null,
  modelSelection: goal.spec.workers.modelSelection,
  state: "placing",
  launchClientRequestId: launchActionId(goal, slot, attempt),
  tried: [],
  target: target === null ? null : targetKey(target),
  pullRequest: null,
  lastActivityAt: null,
  reported: false,
  followUps: 0,
  followedUpRunId: null,
  recoveredRunId: null,
  steeredRunId: null,
  resumedRunId: null,
  lastRunId: null,
  note: null,
});

/** The slot record for the next attempt, or a failed one when attempts are spent. */
export const nextAttempt = (goal: FleetGoal, worker: WorkerRecord, note: string): WorkerRecord =>
  worker.attempt >= goal.spec.limits.maxAttemptsPerWorker
    ? { ...worker, state: "failed", note: note + " No attempts left." }
    : {
        ...newWorker(goal, worker.slot, null, worker.attempt + 1),
        target: worker.target,
        modelSelection: worker.modelSelection,
        tried: worker.tried,
        note,
      };
