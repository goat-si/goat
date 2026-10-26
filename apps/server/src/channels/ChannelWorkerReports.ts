/**
 * ChannelWorkerReports - turns what worker threads do into ledger task events.
 *
 * Completion comes from the worker thread's own runs, read from its projection: the task's
 * current run must finish `completed`, with no open question, no answer still on its way, no
 * provider background work, no pull request watch, and no pending restart continuation. Process
 * exit, a last assistant sentence, or an explicit "completed" report alone never finish a task.
 * Reading the projection (rather than counting events) makes a replayed or missed event harmless:
 * every pass decides from the current state, and a finished task cannot finish again.
 *
 * Each pass also records what the worker thread shows besides its run status (linked pull
 * requests, native questions and approvals, a usage-limit wait) as `task.worker.observed`. A run
 * that stopped on a usage limit keeps the task alive: GOAT resumes the worker after the reset, or
 * shows that a person has to.
 *
 * Workers may also report progress, questions, and proposed completion with channel_task_report;
 * the caller's thread and generation must match the task's assignment.
 *
 * A running run whose thread has not changed for STALLED_AFTER_MS is recorded stalled. The
 * requester hears about each quiet period once, in the same write as the status. Waiting on a
 * person is not a stall, and the work item itself stays in progress.
 *
 * @module ChannelWorkerReports
 */
import {
  ChannelGatewayError,
  ChannelWorkerObservation,
  channelWorkerObservationEquals,
  CommandId,
  type ChannelChildWorkState,
  type ChannelTaskEventId,
  type ChannelTask,
  type ChannelTaskNeedsYou,
  type ChannelTaskReportInput,
  type ChannelWorkerRunStatus,
  type OrchestrationV2Run,
  type ThreadId,
} from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readThreadResult } from "../threadResults/ThreadResultService.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor, questionIdFor, workerLaunchIdsFor } from "./channelIds.ts";
import { settleCompletedRun } from "./channelRunOutcome.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  completionHoldCount,
  isThreadMissing,
  newApprovals,
  needsYouFromRuntimeRequests,
  scanSubagents,
  observeWorker,
  withApprovalHost,
  pullRequestsFromLinks,
  usageLimitWait,
  type UsageLimitWait,
} from "./channelWorkerObservation.ts";

/** A worker run's own state, apart from the task it serves. */
const workerRunStatus = (
  status: OrchestrationV2Run["status"],
  needsYou: boolean,
): ChannelWorkerRunStatus => {
  switch (status) {
    case "completed":
      return "finished";
    case "cancelled":
      return "stopped";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return needsYou ? "waiting" : "running";
  }
};

/**
 * How long a running run can sit without thread activity before it is stalled. Same bound as
 * fleet thread health (`STALL_AFTER_MS`).
 */
export const STALLED_AFTER_MS = 20 * 60_000;

/** How far back, and how many per pass, finished tasks have their runs read into history. */
const RUN_HISTORY_DAYS = 7;
const RUN_HISTORY_PER_PASS = 20;

const openWorkerRun = (status: ChannelWorkerRunStatus) =>
  status === "running" || status === "waiting" || status === "stalled";

const stallNotice = (title: string) =>
  '"' +
  title +
  '" has made no progress for ' +
  STALLED_AFTER_MS / 60_000 +
  ' minutes. It may be stuck: say "stop" to stop it, or keep waiting.';

/** One notice per quiet period. A later period has a new activity time, so it notifies again. */
const stallDelivery = (
  task: ChannelTask,
  runId: string,
  activityAt: string,
): ChannelLedger.ChannelOutboxInsert => {
  const causeKey = "stall:" + task.taskId + ":" + runId + ":" + activityAt;
  const deliveryId = deliveryIdFor(causeKey);
  const mentionActorId =
    task.originAddress.kind === "slack" ? task.requester.externalActorId : undefined;
  return {
    deliveryId,
    causeKey,
    taskId: task.taskId,
    message: {
      deliveryId,
      destination: task.originAddress,
      kind: "receipt",
      text: stallNotice(task.title),
      taskId: task.taskId,
      taskVersion: task.version,
      ...(mentionActorId === undefined ? {} : { mentionActorId }),
    },
  };
};

/** How long a finished task without a thread waits for a launch that may still land. */
const NO_THREAD_GRACE_MS = 120_000;

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** The completion hold a worker gets while its finished run still has background work. */
export const BACKGROUND_HOLD = "background";

export class ChannelWorkerReports extends Context.Service<
  ChannelWorkerReports,
  {
    /** Brings every running task in line with its worker thread. Returns how many changed. */
    readonly reconcile: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    /** Whether a thread runs a ledger task, so run events there should wake the workers. */
    readonly isWorkerThread: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
    /** A worker's explicit report, from channel_task_report. */
    readonly report: (
      input: ChannelTaskReportInput,
      callerThreadId: ThreadId | undefined,
    ) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("goat/channels/ChannelWorkerReports") {}

const decodeStoredObservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChannelWorkerObservation),
);
const noNeeds: ReadonlyArray<ChannelTaskNeedsYou> = [];
const CHILD_WORK_HOLD_STATES: ReadonlySet<ChannelChildWorkState> = new Set([
  "launched",
  "bound",
  "unknown",
]);

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const childWorkStore = yield* Effect.serviceOption(ChannelChildWorkStore.ChannelChildWorkStore);

  /**
   * Whether launched child work of this generation is still running. A bare reservation
   * ("reserved") never claimed a launch, so after the worker's run ends it cannot hold completion;
   * a store read failure returns "unknown" so the pass waits rather than settling early.
   */
  const hasActiveChildWork = (taskId: ChannelTask["taskId"], generation: number) =>
    Option.isNone(childWorkStore)
      ? Effect.succeed(false as const)
      : childWorkStore.value.listForTask(taskId).pipe(
          Effect.flatMap((records) =>
            Effect.gen(function* () {
              const current = records.filter((record) => record.generation === generation);
              if (current.some((record) => CHILD_WORK_HOLD_STATES.has(record.state))) return true;
              for (const record of current) {
                const childThreadId = record.destination?.threadId;
                if (childThreadId === undefined || record.state !== "completed") continue;
                const pending = yield* threads
                  .delegatedTaskResultPending(childThreadId)
                  .pipe(Effect.orElseSucceed(() => false));
                if (pending) return true;
              }
              return false;
            }),
          ),
          Effect.orElseSucceed(() => "unknown" as const),
        );

  /** Needs-you already stored for a remote subagent's dispatch. Reconcile does not open SSH. */
  const storedRemoteNeeds = (correlationId: string) =>
    sql<{ readonly observation: string | null }>`
      SELECT observation FROM remote_dispatches
      WHERE correlation_id = ${correlationId} AND kind = 'task'
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const raw = rows[0]?.observation;
        if (raw == null || raw === "") return Effect.succeed(noNeeds);
        return decodeStoredObservation(raw).pipe(
          Effect.map((observation) => observation.needsYou),
          Effect.orElseSucceed(() => noNeeds),
        );
      }),
      Effect.orElseSucceed(() => noNeeds),
    );

  const lastAssistantText = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      })
      .pipe(
        Effect.map((records) => {
          const texts = records.messages
            .filter((message) => !message.streaming && message.text.trim() !== "")
            .map((message) => message.text.trim());
          return texts.at(-1);
        }),
        Effect.orElseSucceed(() => undefined),
      );

  /**
   * Whether `run` stopped on a usage limit, and how it continues. A reset ahead with no choice
   * made for this run arms automatic resume for the worker thread, the same recovery a person turns
   * on for a thread, so channel work continues after the limit without anyone watching.
   * `"unknown"` means the thread could not be read; the caller decides nothing this pass.
   */
  const workerUsageLimit = (threadId: ThreadId, run: OrchestrationV2Run) =>
    Effect.gen(function* (): Effect.fn.Return<UsageLimitWait | "unknown" | undefined> {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.option);
      if (shell._tag === "None") return "unknown";
      const wait = usageLimitWait(shell.value, run, yield* DateTime.now);
      if (wait?.arm === undefined) return wait;
      const { resetAt, resetMs } = wait.arm;
      const armed = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`channel-limit-arm:${threadId}:${run.id}:${resetMs}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true, snooze: false },
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("channels.worker.limit-recovery-arm-failed", {
              threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      // A refused arm leaves the limit to a person; the next pass tries again with the same id.
      return armed
        ? { resetAt }
        : { resetAt, ...(wait.needsYou === undefined ? {} : { needsYou: wait.needsYou }) };
    });

  /** One task against its worker's current runs. True when the ledger changed. */
  /**
   * Records the task's runs from the one it is bound to onward, each with its own state. A run is
   * written only when its state changed, so a quiet worker costs no writes.
   */
  const recordRuns = (
    task: ChannelTask,
    runs: ReadonlyArray<OrchestrationV2Run>,
    floor: number,
    needsYou: boolean,
    activityAt: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const worker = task.worker;
      if (worker === undefined) return true;
      const known = new Map(
        (yield* ledger.listWorkerRuns([task.taskId])).map((run) => [run.runId, run]),
      );
      const nowDt = yield* DateTime.now;
      const now = DateTime.formatIso(nowDt);
      const activityIso = DateTime.formatIso(activityAt);
      const quiet =
        DateTime.toEpochMillis(nowDt) - DateTime.toEpochMillis(activityAt) > STALLED_AFTER_MS;
      const latestOrdinal = runs.at(-1)?.ordinal;
      // Agents over MCP never answer, so they are not told a run stalled.
      const tellRequester = task.requester.originKind !== "mcp";
      for (const run of runs) {
        if (run.ordinal < floor) continue;
        // Only the newest run can be waiting on a person; earlier ones have ended.
        const derived = workerRunStatus(run.status, needsYou && run.ordinal === latestOrdinal);
        const status = derived === "running" && quiet ? "stalled" : derived;
        const before = known.get(run.id);
        if (before?.status === status) continue;
        const notify = status === "stalled" && tellRequester;
        yield* ledger.upsertWorkerRun(
          {
            runId: run.id,
            taskId: task.taskId,
            generation: worker.generation,
            threadId: worker.threadId,
            status,
            startedAt: before?.startedAt ?? DateTime.formatIso(run.requestedAt),
            updatedAt: now,
            ...(openWorkerRun(status) ? {} : { endedAt: before?.endedAt ?? now }),
          },
          notify ? [stallDelivery(task, run.id, activityIso)] : [],
        );
      }
      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("channel worker run not recorded", { cause }).pipe(Effect.as(false)),
      ),
    );

  const reconcileTask = (stored: ChannelLedger.ChannelStoredTask, owner: string) =>
    Effect.gen(function* () {
      const task = stored.task;
      const worker = task.worker;
      // Workers on another machine report through ChannelRemoteWorkers.
      if (worker === undefined || worker.host !== undefined) return false;
      const records = yield* threads
        .getThreadRecords(worker.threadId, [
          "runs",
          "providerThreads",
          "runtimeRequests",
          "subagents",
        ])
        .pipe(Effect.option);
      if (records._tag === "None") return false;
      const runs = records.value.runs.toSorted((left, right) => left.ordinal - right.ordinal);
      const pullRequestLinks = records.value.thread.pullRequests;
      const bound = runs.find((run) => run.id === worker.runId);

      // An answer was sent to the worker: wait for the run it starts before judging anything.
      let current: OrchestrationV2Run | undefined;
      let clearPendingAnswer = false;
      if (stored.pendingAnswerMessageId !== undefined) {
        current = runs.find((run) => run.userMessageId === stored.pendingAnswerMessageId);
        if (current === undefined) return false;
        clearPendingAnswer = true;
      } else {
        // The newest run since the bound one is the task's current run: a follow-up or a
        // restart continuation replaces the run it follows.
        const floor = bound?.ordinal ?? 0;
        current = runs.findLast((run) => run.ordinal >= floor);
      }
      if (current === undefined) return false;

      let latest = stored;
      if (current.id !== worker.runId || clearPendingAnswer) {
        const rebound = yield* commitTransition(
          ledger,
          stored,
          { type: "task.worker.bound", payload: { worker: { ...worker, runId: current.id } } },
          { owner, ...(clearPendingAnswer ? { pendingAnswerMessageId: null } : {}) },
        );
        if (rebound === undefined) return false;
        const reread = yield* ledger.getTask(task.taskId);
        if (reread === undefined) return true;
        // Someone else wrote after this pass's write (a follow-up and its fence, say): the runs
        // read above may no longer be the task's, so judge again on the next pass.
        if (reread.task.version !== rebound.version) return true;
        latest = reread;
      }

      // A follow-up queued behind a usage-limited run cannot start until the limit is resumed, so
      // the limit belongs to the newest run the worker thread executed, even once the task is bound
      // to the queued run. Runs cancelled before they started never executed.
      const limitedRun = current.status === "queued" ? latestExecutedRun(runs) : current;
      const limitRead =
        limitedRun?.status === "failed"
          ? yield* workerUsageLimit(worker.threadId, limitedRun)
          : undefined;
      if (limitRead === "unknown") return latest !== stored;
      const limit = limitRead;
      const children = yield* scanSubagents(records.value.subagents, (threadId) =>
        threads.getThreadRecords(threadId, ["runtimeRequests", "subagents"]),
      );
      const remoteNeeds = yield* Effect.forEach(
        children.remote,
        (child) =>
          storedRemoteNeeds(child.correlationId).pipe(
            Effect.map((needs) => withApprovalHost(needs, child.host)),
          ),
        { concurrency: 1 },
      );
      const resultRead = yield* readThreadResult(records.value.thread, current).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.option,
      );
      if (resultRead._tag === "None" && current.status === "completed") return latest !== stored;
      const result = resultRead._tag === "Some" ? resultRead.value : undefined;
      const observed = observeWorker({
        result,
        pullRequests: pullRequestsFromLinks(pullRequestLinks),
        needsYou: [
          ...needsYouFromRuntimeRequests(records.value.runtimeRequests, () => worker.threadId),
          // A subagent waiting on an approval or answer blocks the work as much as the worker.
          ...needsYouFromRuntimeRequests(children.requests, (request) => request.threadId),
          // A subagent on another GOAT machine: the needs-you list that machine last reported.
          ...remoteNeeds.flat(),
          ...(limit?.needsYou === undefined ? [] : [limit.needsYou]),
        ],
        usageLimitResetAt: limit?.resetAt,
      });
      if (!channelWorkerObservationEquals(latest.task.observed, observed)) {
        // A new approval becomes an approve/deny card for a person; an MCP requester is an agent,
        // and agents never answer approvals.
        const card =
          latest.task.requester.originKind !== "mcp" &&
          newApprovals(latest.task.observed?.needsYou, observed.needsYou).length > 0;
        const wrote = yield* commitTransition(
          ledger,
          latest,
          {
            type: "task.worker.observed",
            payload: { generation: latest.task.generation, observed },
          },
          { owner, ...(card ? { narrate: true } : {}) },
        );
        if (wrote === undefined) return latest !== stored;
        const reread = yield* ledger.getTask(task.taskId);
        if (reread === undefined) return true;
        if (reread.task.version !== wrote.version) return true;
        latest = reread;
      }

      // From the generation's first run, so a run rebound past before it was seen ending still
      // gets its final state.
      const launched = runs.find(
        (run) => run.userMessageId === workerLaunchIdsFor(task.taskId, worker.generation).messageId,
      );
      yield* recordRuns(
        latest.task,
        runs,
        launched?.ordinal ?? bound?.ordinal ?? 0,
        observed.needsYou.length > 0,
        records.value.thread.updatedAt,
      );

      if (!TERMINAL_RUN_STATUSES.has(current.status)) return latest !== stored;
      // A follow-up or answer recorded but not yet sent belongs to this work; the run read above
      // has not seen it, so it cannot be the last word.
      if (yield* ledger.hasPendingForward(task.taskId)) return latest !== stored;
      // A worker that asked a question and stopped waits for the answer; one whose run failed or
      // was stopped while waiting has ended the task all the same.
      const waitingForAnswer =
        latest.task.status === "waiting_input" && current.status === "completed";
      if (
        waitingForAnswer ||
        (latest.task.status !== "running" && latest.task.status !== "waiting_input")
      ) {
        return latest !== stored;
      }

      // A restart continuation still to come means this terminal run is not the last word.
      const continuationPending = yield* threads
        .delegatedTaskResultPending(worker.threadId)
        .pipe(Effect.orElseSucceed(() => false));
      if (continuationPending) return latest !== stored;

      // A usage limit is a pause: the continuation run GOAT or a person starts rebinds the task.
      if (limit !== undefined) return latest !== stored;

      if (current.status === "completed") {
        const childWorkActive = yield* hasActiveChildWork(task.taskId, latest.task.generation);
        if (childWorkActive === "unknown") return latest !== stored;
        const held =
          completionHoldCount({
            current,
            runs,
            providerThreads: records.value.providerThreads,
            pullRequests: pullRequestLinks,
          }) > 0 || childWorkActive;
        if (held) {
          if (latest.completionHold !== BACKGROUND_HOLD) {
            yield* ledger.setCompletionHold({ owner, taskId: task.taskId, hold: BACKGROUND_HOLD });
          }
          return true;
        }
        // The worker's own report decides failed, cancelled and blocked; an unreadable report
        // waits for the next pass rather than settling as "no report".
        const reported =
          result !== undefined && result.reportedAt !== null && result.outcome !== null
            ? {
                outcome: result.outcome,
                ...(result.summary === undefined ? {} : { summary: result.summary }),
              }
            : undefined;
        const fallbackSummary =
          (yield* lastAssistantText(worker.threadId, current)) ??
          (latest.task.proposedCompletion?.runId === current.id
            ? latest.task.proposedCompletion.summary
            : "Finished.");
        yield* commitTransition(
          ledger,
          latest,
          settleCompletedRun({
            task: latest.task,
            runId: current.id,
            reported,
            fallbackSummary,
            now: DateTime.formatIso(yield* DateTime.now),
          }),
          { owner, narrate: true, completionHold: null },
        );
        return true;
      }
      if (current.status === "cancelled") {
        yield* commitTransition(
          ledger,
          latest,
          { type: "task.cancelled", payload: { reason: "The coding thread was stopped." } },
          { owner, narrate: true, completionHold: null },
        );
        return true;
      }
      yield* commitTransition(
        ledger,
        latest,
        {
          type: "task.failed",
          payload: {
            generation: task.generation,
            reason: current.status,
            summary: "The coding thread ended with " + current.status.replaceAll("_", " ") + ".",
          },
        },
        { owner, narrate: true, completionHold: null },
      );
      return true;
    });

  const reconcile: ChannelWorkerReports["Service"]["reconcile"] = (owner) =>
    Effect.gen(function* () {
      const active = yield* ledger.listTasksByStatus(["running", "waiting_input"]);
      let changed = 0;
      for (const stored of active) {
        if (yield* reconcileTask(stored, owner)) changed += 1;
      }
      // Check rows commit after settlement. Read them through the same result service on every
      // owner pass, including after restart; this never re-enters outcome settlement.
      for (const stored of yield* ledger.listLocalCheckUpdates()) {
        const worker = stored.task.worker!;
        const records = yield* threads
          .getThreadRecords(worker.threadId, ["runs"])
          .pipe(Effect.option);
        if (records._tag === "None") continue;
        const run = records.value.runs.find((candidate) => candidate.id === worker.runId);
        if (run === undefined) continue;
        const result = yield* readThreadResult(records.value.thread, run).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.option,
        );
        if (result._tag === "None") continue;
        const observed = observeWorker({
          pullRequests: stored.task.observed?.pullRequests ?? [],
          needsYou: [],
          result: result.value,
        });
        if (channelWorkerObservationEquals(stored.task.observed, observed)) continue;
        const wrote = yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.worker.observed",
            payload: { generation: stored.task.generation, observed },
          },
          { owner, narrate: true },
        );
        if (wrote !== undefined) changed += 1;
      }
      // A finished task's runs are read into history until all of them have ended, even when
      // the task ended first (stopped, or settled by the worker's own report) or its launch
      // never bound a worker, in which case its thread is the one the generation derives.
      const now = yield* DateTime.now;
      const since = DateTime.formatIso(DateTime.subtract(now, { days: RUN_HISTORY_DAYS }));
      for (const finished of yield* ledger.listUnsettledRunHistory({
        since,
        limit: RUN_HISTORY_PER_PASS,
      })) {
        const generation = finished.worker?.generation ?? finished.generation;
        const ids = workerLaunchIdsFor(finished.taskId, generation);
        const worker = finished.worker ?? {
          environmentId: finished.target!.environmentId,
          threadId: ids.threadId,
          generation,
        };
        const settle = ledger.settleRunHistory({
          taskId: finished.taskId,
          now: DateTime.formatIso(now),
        });
        const records = yield* threads
          .getThreadRecords(worker.threadId, ["runs"])
          .pipe(Effect.result);
        if (records._tag === "Failure") {
          // Only a thread that does not exist means the launch never landed; any other failed
          // read is tried again next pass.
          if (
            isThreadMissing(records.failure) &&
            DateTime.toEpochMillis(now) - Date.parse(finished.updatedAt) > NO_THREAD_GRACE_MS
          ) {
            yield* settle;
          }
          continue;
        }
        const runs = records.success.runs.toSorted((left, right) => left.ordinal - right.ordinal);
        const launched = runs.find((run) => run.userMessageId === ids.messageId);
        const recorded = yield* recordRuns(
          { ...finished, worker },
          runs,
          launched?.ordinal ?? 0,
          false,
          records.success.thread.updatedAt,
        );
        if (recorded && runs.every((run) => TERMINAL_RUN_STATUSES.has(run.status))) {
          yield* settle;
        }
      }
      // Open runs whose task has ended (stopped, or settled by the worker's own report) still end
      // on their own; record how. A stalled run stays stalled until that orchestration run ends,
      // so the next pass does not tell the requester again.
      const activeIds = new Set(active.map((stored) => stored.task.taskId as string));
      const open = (yield* ledger.listOpenWorkerRuns()).filter(
        (run) => !activeIds.has(run.taskId) && run.host === undefined,
      );
      for (const threadId of new Set(open.map((run) => run.threadId))) {
        const records = yield* threads
          .getThreadRecords(threadId as ThreadId, ["runs"])
          .pipe(Effect.option);
        if (records._tag === "None") continue;
        const now = DateTime.formatIso(yield* DateTime.now);
        for (const recorded of open.filter((run) => run.threadId === threadId)) {
          const run = records.value.runs.find((candidate) => candidate.id === recorded.runId);
          const derived = run === undefined ? "stopped" : workerRunStatus(run.status, false);
          const status =
            recorded.status === "stalled" && derived === "running" ? "stalled" : derived;
          if (status === recorded.status) continue;
          yield* ledger.upsertWorkerRun({
            ...recorded,
            status,
            updatedAt: now,
            ...(openWorkerRun(status) ? {} : { endedAt: now }),
          });
        }
      }
      return changed;
    });

  const isWorkerThread: ChannelWorkerReports["Service"]["isWorkerThread"] = (threadId) =>
    ledger.findTaskByWorkerThread(threadId).pipe(Effect.map((stored) => stored !== undefined));

  const report: ChannelWorkerReports["Service"]["report"] = (input, callerThreadId) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(input.taskId);
      const worker = stored?.task.worker;
      if (
        stored === undefined ||
        worker === undefined ||
        callerThreadId === undefined ||
        worker.threadId !== callerThreadId ||
        input.generation !== stored.task.generation
      ) {
        return yield* new ChannelGatewayError({ reason: "forbidden" });
      }
      if (yield* ledger.hasTaskEvent(input.eventId)) return;
      const eventId = input.eventId as ChannelTaskEventId;
      const task = stored.task;
      const now = DateTime.formatIso(yield* DateTime.now);
      switch (input.status) {
        case "running":
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.progress",
              payload: {
                generation: task.generation,
                summary: input.summary,
                ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
              },
            },
            { actor: "agent", eventId, narrate: input.milestone === true },
          );
          return;
        case "waiting_input":
          if (input.question === undefined) {
            return yield* new ChannelGatewayError({ reason: "invalid_input" });
          }
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.question.opened",
              payload: {
                question: {
                  questionId: questionIdFor(task.taskId, task.version + 1),
                  text: input.question,
                  askedAt: now,
                  ...(task.requester.externalActorId === undefined
                    ? {}
                    : { requesterExternalActorId: task.requester.externalActorId }),
                },
              },
            },
            { actor: "agent", eventId, narrate: true },
          );
          return;
        case "completed":
          // Held until the run itself finishes; reconcile then decides.
          if (worker.runId === undefined) {
            return yield* new ChannelGatewayError({ reason: "invalid_input" });
          }
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.completion.proposed",
              payload: {
                proposal: {
                  eventId,
                  generation: task.generation,
                  runId: worker.runId,
                  summary: input.summary,
                },
              },
            },
            { actor: "agent", eventId },
          );
          return;
        case "failed":
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.failed",
              payload: {
                generation: task.generation,
                reason: "reported_failed",
                summary: input.summary,
              },
            },
            { actor: "agent", eventId, narrate: true },
          );
          return;
      }
    }).pipe(
      Effect.catchTags({
        ChannelLedgerError: () =>
          Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" })),
      }),
    );

  return ChannelWorkerReports.of({ reconcile, isWorkerThread, report });
});

export const layer = Layer.effect(ChannelWorkerReports, make);
