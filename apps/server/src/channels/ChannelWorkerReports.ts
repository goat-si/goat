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
  channelWorkerObservationEquals,
  CommandId,
  type ChannelChildWork,
  type ChannelChildWorkState,
  type ChannelTaskEventId,
  type ChannelTask,
  type ChannelTaskReportInput,
  type ChannelWorkerRunStatus,
  isGoatBotSessionThreadId,
  localChildThreadId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readThreadResult } from "../threadResults/ThreadResultService.ts";
import { sessionTaskRuns } from "./channelBotSessionRuns.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import {
  anyLaunchedResultOwed,
  ChannelLaunchWakes,
  launchedResultOwed,
  type LaunchedEnd,
  readLaunchedEnds,
} from "./channelLaunchedResults.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { deliverNoticeAnswers, noticeMessageIds, resultRunsOf } from "./channelNoticeAnswers.ts";
import {
  channelTaskIdFromAgent,
  deliveryIdFor,
  questionIdFor,
  workerLaunchIdsFor,
} from "./channelIds.ts";
import { failedAfterAsking, settleCompletedRun } from "./channelRunOutcome.ts";
import { sessionFinalText, sessionReceiptPending } from "./channelSessionReceipt.ts";
import { makeSkillProposalOffers } from "./channelSkillProposals.ts";
import { settleSupersededTurn } from "./channelSupersededTurns.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { commitWorkerObserved, reconcileLateApprovals } from "./channelLateApprovals.ts";
import {
  launchObservationNeeds,
  remoteLaunchChildren,
  storedRemoteNeeds,
} from "./channelRemoteChildNeeds.ts";
import {
  completionHoldCount,
  isThreadMissing,
  newApprovals,
  hasNewLocalQuestion,
  launchedRequestRead,
  launchedThreadRequests,
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
  const skillProposals = yield* makeSkillProposalOffers;
  const launchWakes = yield* ChannelLaunchWakes;

  /** A task's child work, every generation, or "unknown" when the store cannot be read. */
  const readChildWork = (taskId: ChannelTask["taskId"]) =>
    Option.isNone(childWorkStore)
      ? Effect.succeed<ReadonlyArray<ChannelChildWork>>([])
      : childWorkStore.value
          .listForTask(taskId)
          .pipe(Effect.orElseSucceed(() => "unknown" as const));

  const launchedEnds = (
    records: ReadonlyArray<ChannelChildWork> | "unknown",
    generation: number,
    launcherThreadId: ThreadId,
  ) =>
    readLaunchedEnds({ threads, watch: launchWakes.watch }, records, generation, launcherThreadId);

  /**
   * A coding thread that ended STALLED_AFTER_MS ago without its result coming back is told to
   * the person the way a quiet run is, once per end; the task keeps waiting for the result.
   */
  const launchStallNotices = (
    task: ChannelTask,
    ends: ReadonlyArray<LaunchedEnd | "unreadable">,
    runs: ReadonlyArray<OrchestrationV2Run>,
    allRuns: ReadonlyArray<OrchestrationV2Run>,
  ) =>
    Effect.gen(function* () {
      // Agents over MCP never answer, so they are not told.
      if (task.requester.originKind === "mcp") return;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const notices = ends.flatMap((end) =>
        end !== "unreadable" &&
        end.endIso !== null &&
        nowMs - Date.parse(end.endIso) > STALLED_AFTER_MS &&
        launchedResultOwed(end, runs, allRuns)
          ? [stallDelivery(task, "launch:" + end.childThreadId + ":" + end.runId, end.endIso)]
          : [],
      );
      if (notices.length > 0) yield* ledger.enqueueDeliveries(notices, DateTime.formatIso(now));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("launched thread stall notice not recorded", { cause }),
      ),
    );

  /**
   * Whether this generation's child work still runs or a thread it launched still owes its result.
   * A bare reservation never claimed a launch, so it cannot hold completion; an unreadable store
   * is "unknown" so the pass waits. `runs` (the task's) and `allRuns` (the worker thread's) come
   * from the read made after `ends`.
   */
  const hasActiveChildWork = (
    records: ReadonlyArray<ChannelChildWork> | "unknown",
    generation: number,
    ends: ReadonlyArray<LaunchedEnd | "unreadable">,
    runs: ReadonlyArray<OrchestrationV2Run>,
    allRuns: ReadonlyArray<OrchestrationV2Run>,
  ) =>
    Effect.gen(function* () {
      if (records === "unknown") return "unknown" as const;
      const current = records.filter((record) => record.generation === generation);
      if (current.some((record) => CHILD_WORK_HOLD_STATES.has(record.state))) return true;
      if (anyLaunchedResultOwed(ends, runs, allRuns)) return true;
      for (const record of current) {
        const childThreadId = localChildThreadId(record.destination);
        if (childThreadId === undefined || record.state !== "completed") continue;
        const pending = yield* threads
          .delegatedTaskResultPending(childThreadId)
          .pipe(Effect.orElseSucceed(() => false));
        if (pending) return true;
      }
      return false;
    });

  /**
   * Pending requests in coding threads this generation launched. A completed run still contributes
   * a waiting question, not an approval. A failed read returns "unknown" so the pass keeps what
   * it observed; a deleted thread asks nothing.
   */
  const childWorkRequests = (
    records: ReadonlyArray<ChannelChildWork> | "unknown",
    generation: number,
  ) =>
    records === "unknown"
      ? Effect.succeed("unknown" as const)
      : Effect.forEach(
          records.flatMap((record) => {
            const read = launchedRequestRead(record, generation);
            return read === undefined ? [] : [read];
          }),
          (read) =>
            threads.getThreadRecords(read.threadId, ["runtimeRequests"]).pipe(
              Effect.map((records) =>
                launchedThreadRequests(records.runtimeRequests, read.threadId, read.questionsOnly),
              ),
              Effect.catchIf(isThreadMissing, () => Effect.succeed([])),
            ),
          { concurrency: 1 },
        ).pipe(
          Effect.map((perThread) => perThread.flat()),
          Effect.orElseSucceed(() => "unknown" as const),
        );

  const lastAssistantText = (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    taskId: ChannelTask["taskId"],
  ) =>
    threads
      .getThreadRecords(threadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      })
      .pipe(
        Effect.flatMap((records) => {
          const message = records.messages
            .filter((message) => !message.streaming && message.text.trim() !== "")
            .at(-1);
          if (message === undefined) return Effect.void;
          const item = records.turnItems.find(
            (item) => item.type === "assistant_message" && item.messageId === message.id,
          );
          return sessionFinalText(sql, taskId, run.id, item?.id, message.text);
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
      if (yield* settleSupersededTurn(ledger, stored, owner)) return true;
      // Child work, then what each coding thread it launched owes, before the worker's runs: a
      // wake already sent is then among those runs, so the hold and the result share one read.
      const childWork = yield* readChildWork(task.taskId);
      const ends = yield* launchedEnds(childWork, task.generation, worker.threadId);
      const records = yield* threads
        .getThreadRecords(worker.threadId, [
          "runs",
          "providerThreads",
          "runtimeRequests",
          "subagents",
        ])
        .pipe(Effect.option);
      if (records._tag === "None") return false;
      // A GOAT Bot session serves several tasks: this task sees only its own runs, children and
      // approvals, never another task's.
      const session = isGoatBotSessionThreadId(worker.threadId);
      const allRuns = records.value.runs.toSorted((left, right) => left.ordinal - right.ordinal);
      const scoped = session
        ? yield* threads.getThreadRecords(worker.threadId, ["messages", "providerTurns"]).pipe(
            Effect.flatMap(({ messages, providerTurns }) =>
              sessionTaskRuns(sql, worker.threadId, { runs: allRuns, messages }, task).pipe(
                Effect.map((own) => ({ own, providerTurns, notices: noticeMessageIds(messages) })),
              ),
            ),
            Effect.option,
          )
        : Option.some({ own: allRuns, providerTurns: [], notices: new Set<string>() });
      if (Option.isNone(scoped)) return false;
      const runs = scoped.value.own;
      // A background command's notice run answers the request on its own (channelNoticeAnswers),
      // so it is never the task's result; it still belongs to the task for everything else.
      const resultRuns = resultRunsOf(runs, scoped.value.notices);
      // A request belongs to the run whose provider turn raised it; one whose turn cannot be
      // traced to this task's runs is left out rather than shown on the wrong task.
      const runtimeRequests = !session
        ? records.value.runtimeRequests
        : records.value.runtimeRequests.filter((request) => {
            const turn = scoped.value.providerTurns.find(
              (candidate) => candidate.id === request.providerTurnId,
            );
            return runs.some((run) =>
              turn === undefined
                ? run.rootNodeId !== null && run.rootNodeId === request.nodeId
                : run.rootNodeId === turn.nodeId ||
                  (turn.runAttemptId !== null && run.activeAttemptId === turn.runAttemptId),
            );
          });
      const subagents = session
        ? records.value.subagents.filter((child) => runs.some((run) => run.id === child.runId))
        : records.value.subagents;
      const pullRequestLinks = session ? [] : records.value.thread.pullRequests;
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
        // Bound to a notice (a recovered send, or a follow-up that joined one), the task's own
        // newest run still answers it; the notice answers through channelNoticeAnswers.
        current =
          resultRuns.findLast((run) => run.ordinal >= floor) ??
          (bound !== undefined && scoped.value.notices.has(bound.userMessageId)
            ? resultRuns.at(-1)
            : undefined);
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
      const launchedRequests = yield* childWorkRequests(childWork, latest.task.generation);
      if (launchedRequests === "unknown") return latest !== stored;
      const children = yield* scanSubagents(subagents, (threadId) =>
        threads.getThreadRecords(threadId, ["runtimeRequests", "subagents"]),
      );
      // A coding thread can be both a subagent and launched child work; each request counts once.
      const childRequests = [
        ...new Map(
          [...children.requests, ...launchedRequests].map(
            (request) => [request.threadId + "\u0000" + request.id, request] as const,
          ),
        ).values(),
      ];
      const remoteNeeds = yield* Effect.forEach(
        children.remote,
        (child) =>
          storedRemoteNeeds(sql, child.correlationId).pipe(
            Effect.map((needs) => withApprovalHost(needs, child.host)),
          ),
        { concurrency: 1 },
      );
      const launchNeeds = yield* launchObservationNeeds(
        sql,
        remoteLaunchChildren(childWork, latest.task.generation),
        latest.task.observed?.needsYou,
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
          ...needsYouFromRuntimeRequests(runtimeRequests, () => worker.threadId),
          // A subagent waiting on an approval or answer blocks the work as much as the worker.
          ...needsYouFromRuntimeRequests(childRequests, (request) => request.threadId),
          // A subagent on another GOAT machine: the needs-you list that machine last reported.
          ...remoteNeeds.flat(),
          ...launchNeeds,
          ...(limit?.needsYou === undefined ? [] : [limit.needsYou]),
        ],
        usageLimitResetAt: limit?.resetAt,
      });
      if (!channelWorkerObservationEquals(latest.task.observed, observed)) {
        const card =
          latest.task.requester.originKind !== "mcp" &&
          (newApprovals(latest.task.observed?.needsYou, observed.needsYou).length > 0 ||
            hasNewLocalQuestion(latest.task.observed?.needsYou, observed.needsYou));
        const requests = [...runtimeRequests, ...childRequests];
        const wrote = yield* commitWorkerObserved(
          ledger,
          latest,
          observed,
          owner,
          card,
          requests,
          threads,
        );
        if (wrote === undefined) return latest !== stored;
        const reread = wrote === "unchanged" ? latest : yield* ledger.getTask(task.taskId);
        if (reread === undefined) return true;
        if (wrote !== "unchanged" && reread.task.version !== wrote.version) return true;
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
        (latest.task.observed?.needsYou.length ?? 0) > 0,
        records.value.thread.updatedAt,
      );

      if (!TERMINAL_RUN_STATUSES.has(current.status)) return latest !== stored;
      // A follow-up or answer recorded but not yet sent belongs to this work; the run read above
      // has not seen it, so it cannot be the last word.
      if (yield* ledger.hasPendingForward(task.taskId)) return latest !== stored;
      // A worker that asked a question and stopped waits for the answer; one whose run failed or
      // was stopped while waiting, or that reported a failure after asking, has ended the task.
      const waitingForAnswer =
        latest.task.status === "waiting_input" &&
        current.status === "completed" &&
        !failedAfterAsking(latest.task, result);
      if (
        waitingForAnswer ||
        (latest.task.status !== "running" && latest.task.status !== "waiting_input")
      ) {
        return latest !== stored;
      }

      // A restart continuation still to come means this terminal run is not the last word.
      const continuationPending = session
        ? subagents.some(
            (child) =>
              child.completionDelivery?.state === "pending" ||
              child.completionDelivery?.state === "claimed",
          )
        : yield* threads
            .delegatedTaskResultPending(worker.threadId)
            .pipe(Effect.orElseSucceed(() => false));
      if (continuationPending) return latest !== stored;

      // A usage limit is a pause: the continuation run GOAT or a person starts rebinds the task.
      if (limit !== undefined) return latest !== stored;

      if (current.status === "completed") {
        // The ends were read for the generation this pass began with.
        if (latest.task.generation !== task.generation) return true;
        const childWorkActive = yield* hasActiveChildWork(
          childWork,
          latest.task.generation,
          ends,
          runs,
          allRuns,
        );
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
          yield* launchStallNotices(latest.task, ends, runs, allRuns);
          return true;
        }
        // The answer is stripped against the session's committed first line, so it waits for it.
        if (
          latest.task.kind === "turn" &&
          (yield* sessionReceiptPending(sql, latest.task.originInputId))
        )
          return latest !== stored;
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
          (yield* lastAssistantText(worker.threadId, current, task.taskId)) ??
          (latest.task.proposedCompletion?.runId === current.id
            ? latest.task.proposedCompletion.summary
            : "Finished.");
        const settled = settleCompletedRun({
          task: latest.task,
          runId: current.id,
          reported:
            fallbackSummary === "" && reported?.outcome === "succeeded"
              ? { outcome: "succeeded" }
              : reported,
          fallbackSummary,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        // A skill the worker proposed is asked about in the same write that settles the task.
        const offered = yield* skillProposals.offerFor(latest, current.id, settled);
        yield* commitTransition(ledger, latest, settled, {
          owner,
          narrate: true,
          completionHold: null,
          ...offered,
        });
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
          needsYou: (stored.task.observed?.needsYou ?? []).filter(
            (need) => need.kind === "approval",
          ),
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
      changed += yield* deliverNoticeAnswers({ sql, ledger, threads }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("background command answers not sent", { cause }).pipe(Effect.as(0)),
        ),
      );
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
      return changed + (yield* reconcileLateApprovals(owner, { ledger, threads, sql }));
    });

  const isWorkerThread: ChannelWorkerReports["Service"]["isWorkerThread"] = (threadId) =>
    ledger.findTaskByWorkerThread(threadId).pipe(Effect.map((stored) => stored !== undefined));

  const report: ChannelWorkerReports["Service"]["report"] = (input, callerThreadId) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(channelTaskIdFromAgent(input.taskId));
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
      // In a GOAT Bot session only the task's newest result run may report for it; an earlier
      // run's delayed report, another task's, or a background command's notice is refused.
      if (isGoatBotSessionThreadId(worker.threadId)) {
        const caller = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        const runId = Option.isSome(caller) ? caller.value.thread?.runId : undefined;
        if (runId !== undefined) {
          const records = yield* threads
            .getThreadRecords(worker.threadId, ["runs", "messages"])
            .pipe(Effect.orElseSucceed(() => ({ runs: [], messages: [] })));
          const own = yield* sessionTaskRuns(sql, worker.threadId, records, stored.task).pipe(
            Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2Run> => []),
          );
          if (resultRunsOf(own, noticeMessageIds(records.messages)).at(-1)?.id !== runId)
            return yield* new ChannelGatewayError({ reason: "forbidden" });
        }
      }
      if (yield* ledger.hasTaskEvent(input.eventId)) return;
      const eventId = input.eventId as ChannelTaskEventId;
      const task = stored.task;
      const now = DateTime.formatIso(yield* DateTime.now);
      switch (input.status) {
        case "running": {
          // A GOAT Bot turn's running report is a direct message to the person unless milestone:false.
          const milestone = input.milestone ?? (task.kind === "turn" ? true : undefined);
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.progress",
              payload: {
                generation: task.generation,
                summary: input.summary,
                ...(milestone === undefined ? {} : { milestone }),
              },
            },
            { actor: "agent", eventId, narrate: milestone === true },
          );
          return;
        }
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
                  ...(input.skillProposal === undefined
                    ? {}
                    : { skillProposal: input.skillProposal }),
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
