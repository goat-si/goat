import {
  ChannelTaskId,
  type ChannelTask,
  CommandId,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeMode,
  ThreadId,
  RemoteOriginReportsWaitResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { reviewLaunchIdsFor } from "./channelIds.ts";
import { completionHoldCount } from "./channelWorkerObservation.ts";

const Cleanup = Schema.Struct({
  taskId: ChannelTaskId,
  generation: PositiveInt,
  workerRunId: RunId,
  projectId: ProjectId,
  threadId: ThreadId,
  host: Schema.optional(Schema.String),
  runtimeMode: RuntimeMode,
  createdAt: Schema.String,
  nextAttemptAt: Schema.String,
  attempts: Schema.Number,
  done: Schema.Boolean,
  readKey: Schema.optional(Schema.String),
  remoteThreadId: Schema.optional(ThreadId),
});
const codec = Schema.fromJsonString(Cleanup);
const decode = Schema.decodeUnknownSync(codec);
const encode = Schema.encodeSync(codec);
const decodeBinding = Schema.decodeUnknownEffect(RemoteOriginReportsWaitResult);
const decodeKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ readKey: Schema.String })),
);
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ readKey: Schema.String })),
);
export const REVIEW_CLEANUP_RETRY_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export class ChannelReviewCleanup extends Context.Service<
  ChannelReviewCleanup,
  {
    readonly track: (
      task: ChannelTask,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly reserveRemote: (
      task: ChannelTask,
      owner: string,
      readKey: string,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
    readonly bindRemote: (
      reviewThreadId: ThreadId,
      remoteThreadId: ThreadId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly notStarted: (
      reviewThreadId: ThreadId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly reconcile: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelReviewCleanup") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const entryFor = (task: ChannelTask, now: string, readKey?: string) =>
    encode({
      taskId: task.taskId,
      generation: task.generation,
      workerRunId: task.review!.workerRunId,
      projectId: task.target!.projectId,
      threadId: task.review!.threadId,
      ...(task.worker!.host === undefined ? {} : { host: task.worker!.host }),
      ...(readKey === undefined ? {} : { readKey }),
      runtimeMode: task.requester.runtimeModeCeiling,
      createdAt: now,
      nextAttemptAt: now,
      attempts: 0,
      done: false,
    });
  const track = Effect.fn("ChannelReviewCleanup.track")(function* (
    task: ChannelTask,
    owner: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.reserveReviewDispatch({
      owner,
      key: "cleanup:" + task.review!.threadId,
      now,
      value: entryFor(task, now),
    });
  });
  const reserveRemote = Effect.fn("ChannelReviewCleanup.reserveRemote")(function* (
    task: ChannelTask,
    owner: string,
    readKey: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const ids = reviewLaunchIdsFor(task.taskId, task.generation, task.review!.workerRunId);
    return yield* ledger.reserveReviewDispatch({
      owner,
      key: ids.correlationId,
      now,
      value: encodeKey({ readKey }),
      cleanup: { key: task.review!.threadId, value: entryFor(task, now, readKey) },
    });
  });

  const bindRemote = Effect.fn("ChannelReviewCleanup.bindRemote")(function* (
    reviewThreadId: ThreadId,
    remoteThreadId: ThreadId,
    owner: string,
  ) {
    const value = yield* ledger.getReviewDispatch("cleanup:" + reviewThreadId);
    if (value === undefined) return;
    const entry = decode(value);
    if (entry.remoteThreadId !== undefined) return;
    yield* ledger.updateReviewCleanup({
      owner,
      key: reviewThreadId,
      now: DateTime.formatIso(yield* DateTime.now),
      value: encode({ ...entry, remoteThreadId }),
    });
  });

  const notStarted = Effect.fn("ChannelReviewCleanup.notStarted")(function* (
    reviewThreadId: ThreadId,
    owner: string,
  ) {
    const value = yield* ledger.getReviewDispatch("cleanup:" + reviewThreadId);
    if (value === undefined) return;
    const entry = decode(value);
    if (entry.remoteThreadId !== undefined) return;
    yield* ledger.updateReviewCleanup({
      owner,
      key: reviewThreadId,
      now: DateTime.formatIso(yield* DateTime.now),
      value: encode({ ...entry, done: true }),
    });
  });

  const stop = Effect.fn("ChannelReviewCleanup.stop")(function* (
    entry: typeof Cleanup.Type,
    owner: string,
  ) {
    const ids = reviewLaunchIdsFor(entry.taskId, entry.generation, entry.workerRunId);
    if (entry.host !== undefined) {
      // Keep the private capability independently of the task's current review or generation.
      const dispatch =
        entry.readKey === undefined
          ? yield* ledger.getReviewDispatch(ids.correlationId)
          : undefined;
      const readKey =
        entry.readKey ?? (dispatch === undefined ? undefined : decodeKey(dispatch).readKey);
      if (readKey === undefined) return false;
      const call = (tool: string, args: Readonly<Record<string, unknown>>, writes: boolean) =>
        ssh.callHostTool(
          {
            host: entry.host!,
            tool,
            arguments: args,
            writes,
            timeoutMs: 15_000,
          },
          Effect.succeed(entry.runtimeMode),
        );
      const probe = yield* call(
        "goat_origin_reports_wait",
        {
          correlationId: ids.correlationId,
          readKey,
          afterSequence: 0,
          knownRun: null,
          watchRunId: null,
          timeoutMs: 0,
        },
        false,
      ).pipe(Effect.flatMap(decodeBinding), Effect.result);
      const remoteThreadId =
        probe._tag === "Success" ? probe.success.threadId : entry.remoteThreadId;
      if (remoteThreadId === undefined) return false;
      if (entry.remoteThreadId !== undefined && entry.remoteThreadId !== remoteThreadId)
        return false;
      if (entry.remoteThreadId === undefined)
        yield* bindRemote(entry.threadId, remoteThreadId, owner);
      const run = probe._tag === "Success" ? probe.success.observedRun : null;
      if (
        run !== null &&
        terminal.has(run.status) &&
        (run.holds?.backgroundTasks ?? 0) === 0 &&
        run.holds?.continuationPending !== true
      )
        return true;
      // The report binding proves ownership even if the launch reply/bound event was lost.
      const interrupted = yield* call(
        "goat_thread_interrupt",
        {
          threadId: remoteThreadId,
          stopCascade: true,
          clientRequestId: ids.commandId + ":cleanup:" + entry.attempts,
        },
        true,
      ).pipe(Effect.result);
      if (interrupted._tag === "Failure")
        yield* Effect.logWarning("channel review interruption will retry", {
          threadId: entry.threadId,
          reason: interrupted.failure.reason,
        });
      // An accepted interrupt is not termination; keep ownership until a later observation.
      return false;
    }
    const records = yield* threads
      .getThreadRecords(entry.threadId, ["runs", "providerThreads"])
      .pipe(Effect.result);
    if (records._tag === "Failure") {
      // A missing thread may still be a reserved launch in flight. Retain its identity.
      return false;
    }
    const latest = records.success.runs.toSorted((a, b) => a.ordinal - b.ordinal).at(-1);
    if (
      latest !== undefined &&
      terminal.has(latest.status) &&
      completionHoldCount({
        current: latest,
        runs: records.success.runs,
        providerThreads: records.success.providerThreads,
        pullRequests: records.success.thread.pullRequests,
      }) === 0 &&
      !(yield* threads
        .delegatedTaskResultPending(entry.threadId)
        .pipe(Effect.orElseSucceed(() => true)))
    )
      return true;
    const interrupted = yield* threads
      .interruptThread({
        projectId: entry.projectId,
        threadId: entry.threadId,
        commandId: CommandId.make(ids.commandId + ":cleanup:" + entry.attempts),
        reason: "The channel review no longer owns current work.",
      })
      .pipe(Effect.result);
    if (interrupted._tag === "Failure")
      yield* Effect.logWarning("channel review interruption will retry", {
        threadId: entry.threadId,
        reason: interrupted.failure._tag,
      });
    yield* threads
      .stopDelegatedTasks({
        threadId: entry.threadId,
        commandId: CommandId.make(ids.commandId + ":cleanup-children:" + entry.attempts),
        reason: "The channel review no longer owns current work.",
      })
      .pipe(Effect.result);
    return false;
  });

  const reconcile = Effect.fn("ChannelReviewCleanup.reconcile")(function* (owner: string) {
    if (!(yield* ledger.isOwner(owner))) return 0;
    const now = yield* DateTime.now;
    let changed = 0;
    for (const json of yield* ledger.listReviewCleanup(DateTime.formatIso(now))) {
      const entry = decode(json);
      const done = yield* stop(entry, owner);
      const persisted = yield* ledger.getReviewDispatch("cleanup:" + entry.threadId);
      const latest = persisted === undefined ? entry : decode(persisted);
      const attempts = entry.attempts + 1;
      const delay = Math.min(
        MAX_BACKOFF_MS,
        REVIEW_CLEANUP_RETRY_MS * 2 ** Math.min(entry.attempts, 6),
      );
      yield* ledger.updateReviewCleanup({
        owner,
        key: entry.threadId,
        now: DateTime.formatIso(now),
        value: encode({
          ...latest,
          done,
          attempts,
          nextAttemptAt: DateTime.formatIso(DateTime.add(now, { milliseconds: delay })),
        }),
      });
      changed += 1;
    }
    return changed;
  });
  return ChannelReviewCleanup.of({ track, reserveRemote, bindRemote, notStarted, reconcile });
});
export const layer = Layer.effect(ChannelReviewCleanup, make);
