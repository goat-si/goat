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
 * @module ChannelWorkerReports
 */
import {
  ChannelGatewayError,
  channelWorkerObservationEquals,
  CommandId,
  type ChannelTaskEventId,
  type ChannelTaskReportInput,
  type OrchestrationV2Run,
  type ThreadId,
} from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readStoredThreadResultReport } from "../threadResults/ThreadResultService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { questionIdFor } from "./channelIds.ts";
import { settleCompletedRun } from "./channelRunOutcome.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  completionHoldCount,
  needsYouFromRuntimeRequests,
  observeWorker,
  pullRequestsFromLinks,
  usageLimitWait,
  type UsageLimitWait,
} from "./channelWorkerObservation.ts";

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

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;

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
  const reconcileTask = (stored: ChannelLedger.ChannelStoredTask, owner: string) =>
    Effect.gen(function* () {
      const task = stored.task;
      const worker = task.worker;
      // Workers on another machine report through ChannelRemoteWorkers.
      if (worker === undefined || worker.host !== undefined) return false;
      const records = yield* threads
        .getThreadRecords(worker.threadId, ["runs", "providerThreads", "runtimeRequests"])
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
      const observed = observeWorker({
        pullRequests: pullRequestsFromLinks(pullRequestLinks),
        needsYou: [
          ...needsYouFromRuntimeRequests(records.value.runtimeRequests),
          ...(limit?.needsYou === undefined ? [] : [limit.needsYou]),
        ],
        usageLimitResetAt: limit?.resetAt,
      });
      if (!channelWorkerObservationEquals(latest.task.observed, observed)) {
        const wrote = yield* commitTransition(
          ledger,
          latest,
          {
            type: "task.worker.observed",
            payload: { generation: latest.task.generation, observed },
          },
          { owner },
        );
        if (wrote === undefined) return latest !== stored;
        const reread = yield* ledger.getTask(task.taskId);
        if (reread === undefined) return true;
        latest = reread;
      }

      if (!TERMINAL_RUN_STATUSES.has(current.status)) return latest !== stored;
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
        const held =
          completionHoldCount({
            current,
            runs,
            providerThreads: records.value.providerThreads,
            pullRequests: pullRequestLinks,
          }) > 0;
        if (held) {
          if (latest.completionHold !== BACKGROUND_HOLD) {
            yield* ledger.setCompletionHold({ owner, taskId: task.taskId, hold: BACKGROUND_HOLD });
          }
          return true;
        }
        // The worker's own report decides failed, cancelled and blocked; an unreadable report
        // waits for the next pass rather than settling as "no report".
        const reportRead = yield* readStoredThreadResultReport(worker.threadId, current.id).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.option,
        );
        if (reportRead._tag === "None") return latest !== stored;
        const reported = reportRead.value?.report;
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
              payload: { generation: task.generation, summary: input.summary },
            },
            { actor: "agent", eventId },
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
