/**
 * What one reconcile pass sees of a goal: its workers' threads and health, the hosts that drain,
 * its claimed launches and moves, pull requests, issues and budget. Read-only.
 */
import * as Effect from "effect/Effect";

import type { Health } from "../health/Health.ts";
import type { GoalObservation, PullRequestObservation, SlotObservation } from "./goalPlan.ts";
import type { GoalRecovery } from "./GoalRecovery.ts";
import { type GoalRecord, type GoalStore, type LaunchClaim, NOT_SENT } from "./GoalStore.ts";
import { pendingMoves } from "./goalWorkers.ts";
import type { GoalWorkerRuntime } from "./GoalWorkerRuntime.ts";

const PULL_REQUESTS_PER_PASS = 60;

export const makeObserve = (deps: {
  readonly store: GoalStore["Service"];
  readonly runtime: GoalWorkerRuntime["Service"];
  readonly health: Health["Service"];
  readonly recovery: GoalRecovery["Service"];
}) => {
  const { store, runtime, health, recovery } = deps;
  return Effect.fn("GoalObserve.observe")(function* (
    record: GoalRecord,
    launches: ReadonlyArray<LaunchClaim>,
    now: number,
  ) {
    const { goal } = record;
    const access = yield* runtime.owner(goal);
    const owner = "unavailable" in access ? null : access;
    const workers = new Map<number, SlotObservation>();
    const reported = new Set<number>();
    if (owner !== null)
      yield* Effect.forEach(
        record.workers.filter((worker) => worker.threadId !== null && worker.state !== "failed"),
        (worker) =>
          Effect.gen(function* () {
            const threadId = worker.threadId;
            if (threadId === null) return;
            const reading = yield* runtime.observeWorker(owner, goal, worker);
            yield* recovery.capture(goal, worker, reading);
            if (reading.kind === "unknown" && worker.host !== null) {
              // A host that stopped answering is judged by its health, so a Lost one moves.
              const lost = yield* health.threadHealth({
                host: worker.host,
                threadId,
                watchId: worker.watchId,
              });
              if (lost._tag === "host_lost")
                return workers.set(worker.slot, {
                  kind: "seen",
                  terminal: false,
                  runId: worker.lastRunId,
                  runStatus: null,
                  lastActivityAt: worker.lastActivityAt,
                  result: null,
                  health: lost,
                });
            }
            if (reading.kind !== "seen") return workers.set(worker.slot, reading);
            if (reading.result?.pullRequest != null) reported.add(reading.result.pullRequest);
            const threadHealth = yield* health.threadHealth({
              host: worker.host,
              threadId,
              watchId: worker.watchId,
            });
            return workers.set(worker.slot, { ...reading, health: threadHealth });
          }),
        { concurrency: 4, discard: true },
      );
    // Every launch claim, from the records that outlive status writes. A claim never sent counts
    // as none, so the launch is claimed and sent again.
    const launchClaims = new Map<string, { claimedAt: number; settled: boolean } | null>();
    const unmovedReschedules = new Set<string>();
    const refusedReschedules = new Set<string>();
    for (const launch of launches) {
      if (launch.actionId.endsWith(":reschedule") && launch.outcome === "refused")
        refusedReschedules.add(launch.actionId);
      if (launch.outcome !== NOT_SENT)
        launchClaims.set(launch.actionId, {
          claimedAt: Date.parse(launch.claimedAt),
          settled: launch.settledAt !== null,
        });
      if (launch.actionId.endsWith(":reschedule") && launch.outcome !== "rescheduled")
        unmovedReschedules.add(launch.actionId);
    }
    const wanted = new Set<number>([
      ...goal.spec.targets.flatMap((target) =>
        target.type === "pull_request" ? [target.number] : [],
      ),
      ...record.workers.flatMap((worker) =>
        worker.pullRequest === null ? [] : [worker.pullRequest.number],
      ),
      ...reported,
    ]);
    const pullRequests = new Map<number, PullRequestObservation>();
    yield* Effect.forEach(
      [...wanted].slice(0, PULL_REQUESTS_PER_PASS),
      (number) =>
        runtime
          .observePullRequest(goal, number)
          .pipe(Effect.map((seen) => pullRequests.set(number, seen))),
      { concurrency: 4, discard: true },
    );
    const issues = new Map<number, "open" | "closed" | "unknown">();
    if (goal.spec.doneWhen.some((entry) => entry.type === "issues_closed"))
      yield* Effect.forEach(
        goal.spec.targets.flatMap((target) => (target.type === "issue" ? [target.number] : [])),
        (number) =>
          runtime.observeIssue(goal, number).pipe(Effect.map((state) => issues.set(number, state))),
        { concurrency: 4, discard: true },
      );
    // Read where the cordon table lives, so an uncordon takes effect on the next pass.
    const drainingHosts = new Set<string | null>();
    yield* Effect.forEach(
      new Set(
        record.workers
          .filter((worker) => worker.threadId !== null && worker.state !== "failed")
          .map((worker) => worker.host),
      ),
      (host) =>
        health.hostCondition(host).pipe(
          Effect.map((set) => {
            if (set.conditions.some((condition) => condition.type === "Draining"))
              drainingHosts.add(host);
          }),
        ),
      { concurrency: 4, discard: true },
    );
    const observation: GoalObservation = {
      now,
      drainingHosts,
      refusedReschedules,
      owner:
        owner === null
          ? { available: false, reason: (access as { unavailable: string }).unavailable }
          : { available: true },
      workers,
      launchClaims,
      unmovedReschedules,
      pendingMoves: pendingMoves(goal, launches),
      switchedFallbacks: new Set(yield* store.switchedFallbacks(goal.id)),
      pullRequests,
      issues,
      turns: yield* store.turns(goal.id),
      firstClaimAt: yield* store
        .firstClaimAt(goal.id)
        .pipe(Effect.map((started) => (started === null ? null : Date.parse(started)))),
    };
    return observation;
  });
};
