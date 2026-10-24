/**
 * Drives fleet goals toward their spec (docs/internals/agentic-k8s.md, "Controller"). One
 * Scheduler source, level-triggered: each tick reconciles due goals, at most 20 goals and 10
 * actions per tick and 3 per goal. Every action is claimed in the store before it runs; a launch
 * that never confirmed is looked up by its title marker and never resent under the same attempt.
 * Placement, health, rescheduling and fallback come from the fleet service tags.
 */
import {
  type FleetGoal,
  type FleetGoalEvent,
  FleetOwnerKey,
  type ModelSelection,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HubDown, type PausedGoalWork } from "../../hub/HubDown.ts";
import { type HubWork, UNAFFECTED } from "../../hub/hubDownPolicy.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { Health } from "../health/Health.ts";
import { Rescheduler } from "../health/Rescheduler.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import {
  type ActionIssue,
  applyIssues,
  branchFor,
  desiredSlots,
  fallbackActionId,
  type GoalAction,
  type GoalObservation,
  launchActionId,
  MAX_ACTIONS_PER_TICK,
  MAX_GOALS_PER_TICK,
  nextAttempt,
  nextDelayMs,
  planGoal,
  repairWorkers,
  type PullRequestObservation,
  type SlotObservation,
  targetKey,
} from "./goalPlan.ts";
import { GoalRecovery } from "./GoalRecovery.ts";
import {
  type GoalRecord,
  GoalStore,
  type LaunchClaim,
  NOT_SENT,
  publicWorker,
  type WorkerRecord,
} from "./GoalStore.ts";
import {
  effectiveRuntimeMode,
  GoalWorkerRuntime,
  REMOTE_WORKERS_DISABLED,
  workerTitle,
} from "./GoalWorkerRuntime.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

const SOON_MS = 5_000;
const PULL_REQUESTS_PER_PASS = 60;

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class GoalController extends Context.Service<
  GoalController,
  {
    /** One tick: reconciles due goals within the tick's action budget, when enabled. */
    readonly runDue: Effect.Effect<void>;
    /** One pass over one goal, due or not; returns how many actions it took. */
    readonly reconcile: (record: GoalRecord, budget: number) => Effect.Effect<number>;
  }
>()("goat/fleet/goals/GoalController") {}

const renderPrompt = (goal: FleetGoal, worker: WorkerRecord, branch: string) => {
  const target = goal.spec.workers.perTarget ? goal.spec.targets[worker.slot] : undefined;
  const targetText =
    target === undefined
      ? goal.spec.targets.map(targetKey).join(", ")
      : target.type === "prompt"
        ? target.text
        : target.type === "issue"
          ? "issue #" + target.number
          : target.type === "pull_request"
            ? "pull request #" + target.number
            : "branch " + target.name;
  const body = goal.spec.workers.promptTemplate
    .replaceAll("{{target}}", targetText)
    .replaceAll("{{branch}}", branch)
    .replaceAll("{{attempt}}", String(worker.attempt))
    .replaceAll(
      "{{previousAttempt}}",
      worker.attempt > 1 ? branchFor(goal, worker.slot, worker.attempt - 1) : "",
    );
  return (
    body +
    "\n\nYou are slot " +
    worker.slot +
    " (attempt " +
    worker.attempt +
    ") of GOAT goal " +
    goal.id +
    `. When you finish, report with ${goatCallText("thread.report_result")}, including any pull request you opened.`
  );
};

const make = Effect.gen(function* () {
  const store = yield* GoalStore;
  const runtime = yield* GoalWorkerRuntime;
  const placement = yield* Placement;
  const health = yield* Health;
  const rescheduler = yield* Rescheduler;
  const fallback = yield* Fallback;
  const settings = yield* ServerSettings.ServerSettingsService;
  const hubDown = yield* HubDown;
  const recovery = yield* GoalRecovery;
  // Goal work the hub-down policy paused since the last tick settled it.
  let pausedSinceSettle: Array<PausedGoalWork> = [];

  const observe = (record: GoalRecord, launches: ReadonlyArray<LaunchClaim>, now: number) =>
    Effect.gen(function* () {
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
              const reading = yield* runtime.observeWorker(owner, goal, worker);
              yield* recovery.capture(goal, worker, reading);
              if (reading.kind !== "seen") return workers.set(worker.slot, reading);
              if (reading.result?.pullRequest != null) reported.add(reading.result.pullRequest);
              const threadHealth = yield* health.threadHealth({
                host: worker.host,
                threadId: worker.threadId!,
                watchId: worker.watchId,
              });
              return workers.set(worker.slot, { ...reading, health: threadHealth });
            }),
          { concurrency: 4, discard: true },
        );
      // Every launch claim, from the records that outlive status writes. A claim never sent counts
      // as none, so the launch is claimed and sent again.
      const launchClaims = new Map<string, { claimedAt: number; settled: boolean } | null>();
      for (const launch of launches)
        if (launch.outcome !== NOT_SENT)
          launchClaims.set(launch.actionId, {
            claimedAt: Date.parse(launch.claimedAt),
            settled: launch.settledAt !== null,
          });
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
            runtime
              .observeIssue(goal, number)
              .pipe(Effect.map((state) => issues.set(number, state))),
          { concurrency: 4, discard: true },
        );
      const observation: GoalObservation = {
        now,
        owner:
          owner === null
            ? { available: false, reason: (access as { unavailable: string }).unavailable }
            : { available: true },
        workers,
        launchClaims,
        pullRequests,
        issues,
        turns: yield* store.turns(goal.id),
        firstClaimAt: yield* store
          .firstClaimAt(goal.id)
          .pipe(Effect.map((started) => (started === null ? null : Date.parse(started)))),
      };
      return observation;
    });

  const reconcile = (record: GoalRecord, budget: number) =>
    Effect.gen(function* () {
      const { goal } = record;
      const now = yield* Clock.currentTimeMillis;
      const nowIso = isoAt(now);
      // Slot records are rebuilt from the launch records first, so a launch whose status write
      // was lost (a crash, or a spec change between launch and write) is never orphaned.
      const launches = yield* store.launches(goal.id);
      const repaired = { goal, workers: repairWorkers(goal, record.workers, launches) };
      const plan = planGoal(goal, repaired.workers, yield* observe(repaired, launches, now));
      const workers = new Map(plan.workers.map((worker) => [worker.slot, worker]));
      const events: Array<FleetGoalEvent> = [...plan.events];
      const issues: Array<ActionIssue> = [];
      let failed =
        plan.status.phase === "degraded" &&
        plan.status.conditions.some(
          (c) => c.type === "Degraded" && c.reason === "ObservationFailed",
        );
      let startedAt = plan.status.usage.startedAt;
      let used = 0;
      const owner = FleetOwnerKey.make("goal:" + goal.id);
      const note = (
        type: FleetGoalEvent["type"],
        reason: string,
        message: string,
        worker: WorkerRecord | null,
        actionId: string | null,
      ) =>
        events.push({
          at: nowIso,
          type,
          reason,
          message,
          slot: worker?.slot ?? null,
          attempt: worker?.attempt ?? null,
          actionId,
        });
      const claim = (
        actionId: string,
        kind: "launch" | "followup" | "fallback" | "interrupt",
        worker: WorkerRecord,
        host: string | null,
      ) =>
        store
          .claim({
            goalId: goal.id,
            generation: goal.generation,
            actionId,
            kind,
            host,
            slot: worker.slot,
            nowIso,
          })
          .pipe(
            // A claimed action that never settled (a crash between claim and send) is sent again
            // under the same id, which its receiver dedupes: the command id for local dispatches,
            // the clientRequestId for a remote send, the next attempt's launch id for a reschedule.
            // An interrupt may always repeat; stopping a stopped run is a no-op. A launch is never
            // resent: it is resolved by looking its thread up.
            Effect.flatMap((refusal) =>
              refusal !== "already_claimed"
                ? Effect.succeed(refusal)
                : kind === "interrupt" || actionId.endsWith(":reschedule")
                  ? Effect.succeed(null)
                  : kind === "launch"
                    ? Effect.succeed(refusal)
                    : store
                        .claimOf(actionId)
                        .pipe(
                          Effect.map((receipt) =>
                            receipt !== null && receipt.settledAt === null ? null : refusal,
                          ),
                        ),
            ),
            Effect.tap((refusal) =>
              refusal === null
                ? Effect.logInfo("fleet.goal.action", { goalId: goal.id, actionId, kind })
                : Effect.sync(() => {
                    if (refusal === "budget")
                      issues.push({
                        condition: "Blocked",
                        reason: "BudgetExhausted",
                        message: "The goal spent its budget.",
                      });
                    if (refusal !== "already_claimed")
                      note(
                        "Normal",
                        "ActionRefused",
                        kind + " not taken: " + refusal + ".",
                        worker,
                        actionId,
                      );
                  }),
            ),
          );

      /**
       * Re-reads the owner after a claim. When the owner can no longer act, the claim is settled
       * as never sent, so a later pass may claim and send it again, and the goal is blocked.
       */
      const authorityAfterClaim = (actionId: string) =>
        Effect.gen(function* () {
          const latest = yield* runtime.owner(goal);
          if (!("unavailable" in latest)) return latest;
          yield* store.settle(actionId, NOT_SENT, nowIso);
          issues.push({
            condition: "Blocked",
            reason: "OwnerAuthorityLost",
            message: latest.unavailable,
          });
          return null;
        });

      /**
       * Whether provider work for this worker may start while the hub is down. Asked before the
       * claim, so a paused action stays unclaimed and is taken once the hub answers. Only this
       * machine's work is judged: its own OpenCodex is the evidence.
       */
      const hubGate = (host: string | null, selection: ModelSelection) =>
        (host !== null ? Effect.succeed<HubWork>(UNAFFECTED) : hubDown.forWork(selection)).pipe(
          Effect.tap((work) =>
            Effect.sync(() => {
              if (work._tag !== "Paused") return;
              issues.push({
                condition: "Blocked",
                reason: "HubUnreachable",
                message: work.message,
              });
              pausedSinceSettle.push({
                goalId: goal.id,
                title: goal.title,
                ownerThreadId: goal.owner.threadId,
                instanceId: selection.instanceId,
                message: work.message,
              });
            }),
          ),
        );

      const perform = (action: GoalAction) =>
        Effect.gen(function* () {
          if (action.type === "delete_row") {
            yield* recovery.forget(goal.id);
            yield* store.remove(goal.id);
            return "deleted" as const;
          }
          const worker = workers.get(action.slot);
          if (worker === undefined) return;
          const access = yield* runtime.owner(goal);
          if ("unavailable" in access) {
            issues.push({
              condition: "Blocked",
              reason: "OwnerAuthorityLost",
              message: access.unavailable,
            });
            return;
          }
          switch (action.type) {
            case "resolve_launch": {
              const found = yield* runtime
                .findLaunched(access, goal, action.actionId, worker.host)
                .pipe(Effect.result);
              if (found._tag === "Failure") {
                // Not knowing is not absence: the slot waits, and the attempt is not advanced.
                failed = true;
                note(
                  "Warning",
                  "LaunchLookupFailed",
                  "Slot " + worker.slot + ": " + found.failure.message,
                  worker,
                  action.actionId,
                );
                return;
              }
              if (found.success !== null) {
                const thread = found.success;
                yield* store.settle(action.actionId, "adopted", nowIso, {
                  host: thread.host,
                  threadId: thread.threadId,
                });
                workers.set(worker.slot, {
                  ...worker,
                  host: thread.host,
                  threadId: thread.threadId,
                  lastRunId: thread.runId,
                  state: "running",
                });
                note(
                  "Normal",
                  "WorkerRecovered",
                  "Slot " + worker.slot + " found its unconfirmed launch.",
                  worker,
                  action.actionId,
                );
              } else if (action.expired) {
                yield* store.settle(action.actionId, "unknown", nowIso);
                // A dropped slot just ends; a wanted one moves to its next attempt.
                const dropped = worker.slot >= desiredSlots(goal).length;
                const next = dropped
                  ? { ...worker, state: "superseded" as const }
                  : nextAttempt(goal, worker, "Launch was never confirmed.");
                workers.set(worker.slot, next);
                note(
                  "Warning",
                  "LaunchUnknown",
                  "Slot " +
                    worker.slot +
                    " launch was never confirmed" +
                    (dropped ? "." : "; moving to attempt " + next.attempt + "."),
                  worker,
                  action.actionId,
                );
              }
              return;
            }
            case "launch": {
              const placed = yield* placement.place({
                owner,
                modelSelection: worker.modelSelection,
                fallbackChain: goal.spec.workers.fallbackChain,
                hostSelector: goal.spec.workers.hostSelector,
                project: goal.spec.project,
                avoidHosts: [],
              });
              if (placed._tag === "Refused") {
                failed = true;
                const reasons = placed.reasons
                  .map((entry) => (entry.host ?? "this machine") + ": " + entry.reason.message)
                  .join("; ");
                issues.push({
                  condition: "Blocked",
                  reason: "PlacementRefused",
                  message: reasons || "No host can take this worker.",
                });
                return;
              }
              if (placed.host !== null) {
                // Remote goal workers are off until remote authority is carried end to end.
                failed = true;
                issues.push({
                  condition: "Blocked",
                  reason: "RemoteWorkersDisabled",
                  message: placed.host + ": " + REMOTE_WORKERS_DISABLED,
                });
                return;
              }
              // A later attempt starts from the work the one before it left, once that stopped.
              const resume = yield* recovery.resume(goal, worker.slot, worker.attempt);
              if (resume._tag !== "Start") {
                failed = true;
                if (resume._tag === "Refused")
                  issues.push({
                    condition: "Blocked",
                    reason: "ResumeRefused",
                    message: resume.message,
                  });
                workers.set(worker.slot, { ...worker, note: resume.message });
                return;
              }
              const work = yield* hubGate(placed.host, placed.modelSelection);
              if (work._tag === "Paused") return;
              if ((yield* claim(action.actionId, "launch", worker, placed.host)) !== null) return;
              // The owner's authority as it is now, after placement and the claim, is what the
              // launch runs with.
              const current = yield* authorityAfterClaim(action.actionId);
              if (current === null) return;
              startedAt ??= nowIso;
              const branch = branchFor(goal, worker.slot, worker.attempt);
              const launched = yield* runtime
                .launch(current, {
                  goal,
                  slot: worker.slot,
                  actionId: action.actionId,
                  host: placed.host,
                  title: workerTitle(goal.title, worker.slot, worker.attempt),
                  message:
                    renderPrompt(goal, worker, branch) +
                    (resume.note === null ? "" : "\n\n" + resume.note),
                  branch,
                  modelSelection: work._tag === "Hop" ? work.selection : placed.modelSelection,
                  ...(resume.workspace === null ? {} : { workspace: resume.workspace }),
                })
                .pipe(Effect.result);
              if (launched._tag === "Success") {
                // Recorded on the claim, outside the status write, so a spec change that drops
                // this pass's status cannot lose the thread.
                yield* store.settle(action.actionId, "launched", nowIso, {
                  host: launched.success.host,
                  threadId: launched.success.threadId,
                });
                if (work._tag === "Hop")
                  yield* hubDown.notice(launched.success.threadId, action.actionId, work.notice);
                workers.set(worker.slot, {
                  ...worker,
                  host: launched.success.host,
                  threadId: launched.success.threadId,
                  lastRunId: launched.success.runId,
                  branch,
                  // The goal's own selection: the next attempt goes back to the hub once it answers.
                  modelSelection: placed.modelSelection,
                  state: "running",
                  note:
                    work._tag === "Hop"
                      ? "Runs on this device's own sign-in while the hub is unreachable."
                      : (placed.reason ?? null),
                });
                note(
                  "Normal",
                  "WorkerLaunched",
                  "Slot " +
                    worker.slot +
                    " attempt " +
                    worker.attempt +
                    " started on " +
                    (launched.success.host ?? "this machine") +
                    ".",
                  worker,
                  action.actionId,
                );
                return;
              }
              failed = true;
              // The thread may exist even though the call failed after creating it.
              const created = yield* runtime
                .findLaunched(current, goal, action.actionId, placed.host)
                .pipe(Effect.result);
              if (created._tag === "Failure") {
                // Unclear: the claim stays open and the next pass resolves it.
                workers.set(worker.slot, {
                  ...worker,
                  host: placed.host,
                  state: "launch_unknown",
                  note: launched.failure.message,
                });
                note(
                  "Warning",
                  "LaunchUnclear",
                  "Slot " + worker.slot + ": " + launched.failure.message,
                  worker,
                  action.actionId,
                );
                return;
              }
              if (created.success !== null) {
                const thread = created.success;
                yield* store.settle(action.actionId, "adopted", nowIso, {
                  host: thread.host,
                  threadId: thread.threadId,
                });
                workers.set(worker.slot, {
                  ...worker,
                  host: thread.host,
                  threadId: thread.threadId,
                  branch,
                  state: "running",
                });
                note(
                  "Normal",
                  "WorkerRecovered",
                  "Slot " + worker.slot + " launch reported an error, but its thread exists.",
                  worker,
                  action.actionId,
                );
                return;
              }
              yield* store.settle(action.actionId, "failed", nowIso);
              workers.set(worker.slot, nextAttempt(goal, worker, launched.failure.message));
              note(
                "Warning",
                "LaunchFailed",
                "Slot " + worker.slot + ": " + launched.failure.message,
                worker,
                action.actionId,
              );
              return;
            }
            case "followup": {
              const work = yield* hubGate(worker.host, worker.modelSelection);
              if (work._tag === "Paused") return;
              if ((yield* claim(action.actionId, "followup", worker, worker.host)) !== null) return;
              const current = yield* authorityAfterClaim(action.actionId);
              if (current === null) return;
              const sent = yield* runtime
                .followUp(
                  current,
                  goal,
                  worker,
                  action.message,
                  action.actionId,
                  work._tag === "Hop" ? work.selection : undefined,
                )
                .pipe(Effect.result);
              yield* store.settle(
                action.actionId,
                sent._tag === "Success" ? "sent" : "failed",
                nowIso,
              );
              if (sent._tag === "Failure") {
                failed = true;
                note(
                  "Warning",
                  "FollowUpFailed",
                  "Slot " + worker.slot + ": " + sent.failure.message,
                  worker,
                  action.actionId,
                );
                return;
              }
              if (work._tag === "Hop")
                yield* hubDown.notice(worker.threadId!, action.actionId, work.notice);
              workers.set(worker.slot, {
                ...worker,
                followUps: worker.followUps + 1,
                followedUpRunId: action.runId,
                steeredRunId: worker.state === "stalled" ? action.runId : worker.steeredRunId,
              });
              note(
                "Normal",
                "FollowUpSent",
                "Slot " + worker.slot + ": " + action.message,
                worker,
                action.actionId,
              );
              return;
            }
            case "resume": {
              const work = yield* hubGate(worker.host, worker.modelSelection);
              if (work._tag === "Paused") return;
              if ((yield* claim(action.actionId, "followup", worker, worker.host)) !== null) return;
              const current = yield* authorityAfterClaim(action.actionId);
              if (current === null) return;
              const sent = yield* runtime
                .followUp(
                  current,
                  goal,
                  worker,
                  "Your usage limit has reset. Continue where you left off.",
                  action.actionId,
                  work._tag === "Hop" ? work.selection : undefined,
                )
                .pipe(Effect.result);
              yield* store.settle(
                action.actionId,
                sent._tag === "Success" ? "sent" : "failed",
                nowIso,
              );
              if (sent._tag === "Failure") {
                failed = true;
                note(
                  "Warning",
                  "ResumeFailed",
                  "Slot " + worker.slot + ": " + sent.failure.message,
                  worker,
                  action.actionId,
                );
                return;
              }
              if (work._tag === "Hop")
                yield* hubDown.notice(worker.threadId!, action.actionId, work.notice);
              workers.set(worker.slot, { ...worker, resumedRunId: action.runId });
              note(
                "Normal",
                "WorkerResumed",
                "Slot " + worker.slot + " continued after its usage limit reset.",
                worker,
                action.actionId,
              );
              return;
            }
            case "recover": {
              const handled = {
                ...worker,
                followedUpRunId: action.runId ?? worker.followedUpRunId,
              };
              // A run that failed while the hub was down spends no fallback hop or attempt.
              const work = yield* hubGate(worker.host, worker.modelSelection);
              if (work._tag === "Paused") return;
              if (work._tag === "Hop") {
                if (action.runId === null || worker.threadId === null) return;
                const id =
                  "goal:" +
                  goal.id +
                  ":s" +
                  worker.slot +
                  ":a" +
                  worker.attempt +
                  ":" +
                  action.runId +
                  ":hub-hop";
                if ((yield* claim(id, "fallback", worker, worker.host)) !== null) return;
                const current = yield* authorityAfterClaim(id);
                if (current === null) return;
                const sent = yield* runtime
                  .followUp(
                    current,
                    goal,
                    worker,
                    "Continue where you left off.",
                    id,
                    work.selection,
                  )
                  .pipe(Effect.result);
                yield* store.settle(id, sent._tag === "Success" ? "switched" : "failed", nowIso);
                if (sent._tag === "Failure") {
                  failed = true;
                  return;
                }
                yield* hubDown.notice(worker.threadId, id, work.notice);
                workers.set(worker.slot, handled);
                note(
                  "Normal",
                  "HubFallback",
                  "Slot " + worker.slot + " continued on this device's own sign-in.",
                  worker,
                  id,
                );
                return;
              }
              const step = yield* fallback.next({
                chain: goal.spec.workers.fallbackChain,
                selection: worker.modelSelection,
                failure: action.failureClass,
                tried: worker.tried,
                host: worker.host,
                threadId: worker.threadId,
              });
              if (step._tag === "SwitchInThread" && action.runId !== null) {
                const id = fallbackActionId(
                  goal,
                  worker.slot,
                  worker.attempt,
                  action.runId,
                  step.hop,
                );
                if ((yield* claim(id, "fallback", worker, worker.host)) !== null) return;
                const current = yield* authorityAfterClaim(id);
                if (current === null) return;
                const sent = yield* runtime
                  .followUp(
                    current,
                    goal,
                    worker,
                    "Continue where you left off.",
                    id,
                    step.selection,
                  )
                  .pipe(Effect.result);
                yield* store.settle(id, sent._tag === "Success" ? "switched" : "failed", nowIso);
                if (sent._tag === "Success") {
                  workers.set(worker.slot, {
                    ...handled,
                    modelSelection: step.selection,
                    tried: [...worker.tried, worker.modelSelection],
                  });
                  note(
                    "Normal",
                    "FallbackSwitched",
                    "Slot " + worker.slot + " switched to " + step.selection.model + ".",
                    worker,
                    id,
                  );
                } else failed = true;
                return;
              }
              if (
                step._tag === "Exhausted" &&
                action.reason === "failed" &&
                action.failureClass === "usage_limit"
              ) {
                workers.set(worker.slot, { ...handled, note: "Waits for the usage-limit reset." });
                return;
              }
              if (
                worker.attempt >= goal.spec.limits.maxAttemptsPerWorker ||
                worker.threadId === null
              ) {
                workers.set(worker.slot, {
                  ...handled,
                  state: "failed",
                  note: "No attempts left after " + action.reason + ".",
                });
                return;
              }
              const nextId = launchActionId(goal, worker.slot, worker.attempt + 1);
              const selection = step._tag === "Relaunch" ? step.selection : worker.modelSelection;
              if (worker.host === null) {
                // Attempts on this machine restart here: the next attempt's launch resumes from this
                // one's work once it stops, and its launch record makes this one an orphan to stop.
                workers.set(worker.slot, {
                  ...nextAttempt(
                    goal,
                    worker,
                    "Restarts on this machine after " + action.reason + ".",
                  ),
                  modelSelection: selection,
                });
                note(
                  "Normal",
                  "Rescheduled",
                  "Slot " + worker.slot + " restarts as attempt " + (worker.attempt + 1) + " here.",
                  worker,
                  null,
                );
                return;
              }
              // One reschedule per run: the claim names the run; the next attempt's launch id is the
              // receiver's dedupe key.
              const rescheduleId =
                "goal:" +
                goal.id +
                ":s" +
                worker.slot +
                ":a" +
                worker.attempt +
                ":" +
                (action.runId ?? action.reason) +
                ":reschedule";
              if ((yield* claim(rescheduleId, "launch", worker, worker.host)) !== null) return;
              const rescheduleAuthority = yield* authorityAfterClaim(rescheduleId);
              if (rescheduleAuthority === null) return;
              const branch = branchFor(goal, worker.slot, worker.attempt + 1);
              const moved = yield* rescheduler.reschedule({
                ref: { host: worker.host, threadId: worker.threadId, watchId: worker.watchId },
                owner,
                attempt: worker.attempt,
                reason: step._tag === "Relaunch" ? "fallback_relaunch" : action.reason,
                modelSelection: selection,
                workspace: {
                  baseRef: goal.spec.workers.workspace.baseRef,
                  branch,
                  startFromOrigin: goal.spec.workers.workspace.startFromOrigin,
                },
                previousBranch: worker.branch,
                replica: null,
                prompt: renderPrompt(goal, { ...worker, attempt: worker.attempt + 1 }, branch),
                runtimeMode: effectiveRuntimeMode(rescheduleAuthority, goal),
                clientRequestId: nextId,
              });
              if (moved._tag === "Rescheduled") {
                yield* store.settle(rescheduleId, "rescheduled", nowIso);
                workers.set(worker.slot, {
                  ...nextAttempt(goal, worker, "Rescheduled after " + action.reason + "."),
                  host: moved.host,
                  threadId: moved.threadId,
                  branch: moved.branch,
                  modelSelection: selection,
                  state: "running",
                });
                note(
                  "Normal",
                  "Rescheduled",
                  "Slot " +
                    worker.slot +
                    " moved to attempt " +
                    (worker.attempt + 1) +
                    " on " +
                    (moved.host ?? "this machine") +
                    ".",
                  worker,
                  rescheduleId,
                );
                return;
              }
              yield* store.settle(rescheduleId, "refused", nowIso);
              workers.set(worker.slot, { ...handled, note: moved.message });
              issues.push({
                condition: "Degraded",
                reason: "RescheduleRefused",
                message: "Slot " + worker.slot + ": " + moved.message,
              });
              note(
                "Warning",
                "RescheduleRefused",
                "Slot " + worker.slot + " (" + action.reason + "): " + moved.message,
                worker,
                rescheduleId,
              );
              return;
            }
            case "interrupt": {
              if ((yield* claim(action.actionId, "interrupt", worker, worker.host)) !== null)
                return;
              const stopped = yield* runtime
                .interrupt(access, worker, action.actionId)
                .pipe(Effect.result);
              yield* store.settle(
                action.actionId,
                stopped._tag === "Success" ? "interrupted" : "failed",
                nowIso,
              );
              if (stopped._tag === "Failure") failed = true;
              else if (worker.slot >= desiredSlots(goal).length)
                workers.set(worker.slot, { ...worker, state: "superseded" });
              note(
                stopped._tag === "Success" ? "Normal" : "Warning",
                stopped._tag === "Success" ? "WorkerInterrupted" : "InterruptFailed",
                "Slot " +
                  worker.slot +
                  (stopped._tag === "Success" ? " interrupted." : ": " + stopped.failure.message),
                worker,
                action.actionId,
              );
              return;
            }
          }
        });

      for (const action of plan.actions.slice(0, budget)) {
        used += 1;
        if ((yield* perform(action)) === "deleted") return used;
      }

      const failures = failed ? goal.status.failures + 1 : 0;
      const terminal = plan.status.phase === "succeeded" || plan.status.phase === "failed";
      // A finished goal keeps its passes while it still has slots to stop or launches to resolve.
      const cleanup =
        plan.truncated ||
        [...workers.values()].some(
          (worker) =>
            worker.slot >= desiredSlots(goal).length &&
            worker.state !== "superseded" &&
            worker.state !== "failed",
        );
      const finished = terminal && !cleanup;
      const delay = plan.truncated && !failed ? SOON_MS : nextDelayMs(failures);
      const status = applyIssues(
        goal,
        {
          ...plan.status,
          workers: [...workers.values()].map(publicWorker),
          usage: { ...plan.status.usage, startedAt, turns: yield* store.turns(goal.id) },
          failures,
          nextReconcileAt: finished ? null : isoAt(now + delay),
        },
        issues,
        nowIso,
      );
      const written = yield* store.writeStatus({
        id: goal.id,
        generation: goal.generation,
        status,
        workers: [...workers.values()],
        events,
        nowIso,
      });
      if (!written)
        yield* Effect.logDebug("fleet goal spec moved during a pass", { goalId: goal.id });
      return used;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fleet goal pass failed", { goalId: record.goal.id, error }).pipe(
          Effect.as(0),
        ),
      ),
      Effect.withSpan("GoalController.reconcile", { attributes: { goalId: record.goal.id } }),
    );

  const runDue = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    // The kill switch: off stops every goal action on the next tick and touches no thread.
    if (!current.fleet.controllerEnabled) return;
    const now = yield* Clock.currentTimeMillis;
    let budget = MAX_ACTIONS_PER_TICK;
    for (const record of yield* store.due(isoAt(now), MAX_GOALS_PER_TICK)) {
      if (budget <= 0) break;
      budget -= yield* reconcile(record, budget);
    }
    const paused = pausedSinceSettle;
    pausedSinceSettle = [];
    yield* hubDown.settle(paused);
  }).pipe(Effect.catch((error) => Effect.logWarning("fleet goals: tick failed", { error })));

  return GoalController.of({ runDue, reconcile });
});

export const layer = Layer.effect(GoalController, make);

/** Registers the controller as the "fleet-goals" source on the shared Scheduler. */
export const layerRunning = Layer.effectDiscard(
  Effect.gen(function* () {
    const controller = yield* GoalController;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("fleet-goals", controller.runDue);
  }),
);
