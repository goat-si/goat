/**
 * ChannelChildWork - admission, ownership, and reconciliation for work a channel-owned thread
 * launches: delegated subagents and bot-launched GOAT threads, local or on another machine.
 *
 * One serialized admission path serves every launch surface. Capacity is counted from durable
 * records (at most CHANNEL_CHILD_WORK_MAX_ACTIVE active descendants per channel task), depth is
 * enforced against the records' destinations (a recorded child never gets descendants), and every
 * admission carries a durable request identity so a retry finds its record instead of launching
 * twice. A caller that is not channel-owned keeps today's behavior and is never recorded.
 *
 * The reconcile pass settles records against the real state of their destinations: child thread
 * runs for local work, remote_dispatches rows for remote work. An unresolved remote outcome keeps
 * its capacity until the destination answers; only the destination's fence (the dispatch is then
 * recorded cancelled) or a confirmed pre-launch refusal releases it.
 *
 * @module ChannelChildWork
 */
import {
  type ChannelChildWork as ChannelChildWorkRecord,
  type ChannelChildWorkDestination,
  type ChannelChildWorkState,
  type ChannelChildWorkSurface,
  type ChannelTask,
  type ChannelTaskEventId,
  type ChannelTaskId,
  isChannelChildWorkActive,
  isChannelTaskTerminal,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import {
  childWorkIdFor,
  childWorkKeylessRequestKeyFor,
  childWorkPromptDigestFor,
  childWorkStopCommandIdFor,
} from "./channelIds.ts";

/** At most this many active descendants per channel task, delegates and threads together. */
export const CHANNEL_CHILD_WORK_MAX_ACTIVE = 2;

export class ChannelChildWorkError extends Schema.TaggedError<ChannelChildWorkError>()(
  "ChannelChildWorkError",
  {
    reason: Schema.Literals(["at_capacity", "depth_exceeded", "owner_terminal", "storage"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type ChannelChildWorkOwnership =
  | { readonly _tag: "not_channel_owned" }
  | { readonly _tag: "worker"; readonly task: ChannelTask; readonly ownerId: string }
  | { readonly _tag: "child"; readonly record: ChannelChildWorkRecord };

export type ChannelChildWorkAdmission =
  | { readonly _tag: "not_channel_owned" }
  | {
      readonly _tag: "admitted";
      readonly record: ChannelChildWorkRecord;
      readonly requestKey: string;
    }
  | {
      readonly _tag: "existing";
      readonly record: ChannelChildWorkRecord;
      readonly requestKey: string;
    };

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type TerminalRunStatus = "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

const isTerminalRunStatus = (status: string): status is TerminalRunStatus =>
  !ACTIVE_RUN_STATUSES.has(status);

const recordStateForRun = (status: TerminalRunStatus): ChannelChildWorkState => {
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  return "failed";
};

export class ChannelChildWork extends Context.Service<
  ChannelChildWork,
  {
    /** Who owns this caller thread: a channel task's worker, a recorded child, or nobody. */
    readonly ownershipForCaller: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<ChannelChildWorkOwnership, ChannelChildWorkError>;
    /**
     * The one admission path. Resolves ownership, refuses descendants of recorded children,
     * reserves capacity, and returns the durable request key the surface derives its ids from.
     */
    readonly admit: (input: {
      readonly callerThreadId: ThreadId;
      readonly surface: ChannelChildWorkSurface;
      readonly prompt: string;
      /** The launch target's canonical parts: host, cwd/workspace, model. */
      readonly destinationKey: string;
      readonly destinationHint?: string | undefined;
      readonly clientRequestId?: string | undefined;
    }) => Effect.Effect<ChannelChildWorkAdmission, ChannelChildWorkError>;
    /**
     * reserved -> launched, recording where the launch is headed; false when the record is no
     * longer reserved (a task stop released it) or the write failed, and the launch must not run.
     * Until the scope closes the launch counts as in flight, so a stop or reconcile pass never
     * settles its destination as missing while the launch can still create it.
     */
    readonly claimLaunch: (
      record: ChannelChildWorkRecord,
      destination: ChannelChildWorkDestination,
    ) => Effect.Effect<boolean, never, Scope.Scope>;
    /** reserved|launched -> bound; the destination accepted the work. */
    readonly markBound: (
      record: ChannelChildWorkRecord,
      destination?: ChannelChildWorkDestination,
    ) => Effect.Effect<void, never>;
    /** Any active state -> a terminal state. */
    readonly markTerminal: (
      record: ChannelChildWorkRecord,
      to: "completed" | "failed" | "cancelled",
    ) => Effect.Effect<void, never>;
    /** The launch never happened; capacity returns. */
    readonly markReleased: (record: ChannelChildWorkRecord) => Effect.Effect<void, never>;
    /** The launch was never attempted; capacity returns. A record past reserved is untouched. */
    readonly releaseReserved: (record: ChannelChildWorkRecord) => Effect.Effect<void, never>;
    /** The outcome is uncertain; capacity stays reserved until reconciliation resolves it. */
    readonly markUnknown: (record: ChannelChildWorkRecord) => Effect.Effect<void, never>;
    /** One reconcile pass over active records; returns how many changed state. */
    readonly reconcile: Effect.Effect<number, ChannelChildWorkError>;
    /**
     * Stop what a task stop can reach through the ownership records: reservations release,
     * launched thread children get a thread.stop (their own delegated subtrees cascade with
     * it), and a record settles cancelled once the stop lands or the thread proves gone.
     * Delegates are covered by the worker's own cascade and remote-binding children by
     * reconcile, so both are only watched here. "retry" asks the caller to run the stop pass
     * again: a launch still in flight, a record another writer moved, or a stop that did not
     * land. A refused stop while the child is still live advances the owning stop's attempt,
     * since a refused command id is refused for good.
     */
    readonly cancelForTask: (input: {
      readonly taskId: ChannelTaskId;
      readonly generation: number;
      readonly stopEventId: ChannelTaskEventId;
      readonly attempt: number;
      readonly reason: string;
    }) => Effect.Effect<"settled" | "retry", ChannelChildWorkError>;
  }
>()("goat/channels/ChannelChildWork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toError = (detail: string, cause?: unknown): ChannelChildWorkError =>
    new ChannelChildWorkError({ reason: "storage", detail, cause });

  // Launches this process is running, by record id. A launch commits its destination inside its
  // own fiber (the orchestrator dispatches in the caller under the thread lock, and a remote
  // launch inserts its dispatch row before any remote write), so once a claim's scope closes, a
  // destination still missing never appears. The server owner lock keeps one process per
  // database, which makes this process's view complete.
  const launching = new Map<string, number>();
  const isLaunching = (record: ChannelChildWorkRecord) =>
    (launching.get(record.childWorkId) ?? 0) > 0;
  const enterLaunch = (record: ChannelChildWorkRecord) =>
    Effect.sync(() => {
      launching.set(record.childWorkId, (launching.get(record.childWorkId) ?? 0) + 1);
    });
  const leaveLaunch = (record: ChannelChildWorkRecord) =>
    Effect.sync(() => {
      const remaining = (launching.get(record.childWorkId) ?? 0) - 1;
      if (remaining > 0) launching.set(record.childWorkId, remaining);
      else launching.delete(record.childWorkId);
    });

  const ownershipForCaller = Effect.fn("ChannelChildWork.ownershipForCaller")(function* (
    callerThreadId: ThreadId,
  ) {
    const stored = yield* ledger
      .findTaskByWorkerThread(callerThreadId)
      .pipe(
        Effect.mapError((error) =>
          toError("Unable to read the channel task for this thread.", error),
        ),
      );
    if (stored !== undefined) {
      return {
        _tag: "worker",
        task: stored.task,
        ownerId: stored.ownerId,
      } as const satisfies ChannelChildWorkOwnership;
    }
    const record = yield* store
      .findByDestinationThread(callerThreadId)
      .pipe(Effect.mapError((error) => toError("Unable to read child-work records.", error)));
    if (record !== undefined) {
      return { _tag: "child", record } as const satisfies ChannelChildWorkOwnership;
    }
    return { _tag: "not_channel_owned" } as const satisfies ChannelChildWorkOwnership;
  });

  const admit = Effect.fn("ChannelChildWork.admit")(function* (input: {
    readonly callerThreadId: ThreadId;
    readonly surface: ChannelChildWorkSurface;
    readonly prompt: string;
    readonly destinationKey: string;
    readonly destinationHint?: string | undefined;
    readonly clientRequestId?: string | undefined;
  }) {
    const ownership = yield* ownershipForCaller(input.callerThreadId);
    if (ownership._tag === "not_channel_owned") {
      return { _tag: "not_channel_owned" } as const satisfies ChannelChildWorkAdmission;
    }
    if (ownership._tag === "child") {
      return yield* new ChannelChildWorkError({
        reason: "depth_exceeded",
        detail:
          "This thread is itself recorded child work of a channel task and cannot launch its own" +
          " subagents or threads. Return findings to the coordinating worker instead.",
      });
    }
    // A terminal task's worker still answering a late turn launches nothing new. A cancel
    // racing this check is resolved by the stop traversal (reserved records release) and by
    // reconcile, so the admission never outlives its owner.
    if (isChannelTaskTerminal(ownership.task.status)) {
      return yield* new ChannelChildWorkError({
        reason: "owner_terminal",
        detail:
          "This work is " +
          ownership.task.status +
          ", so it no longer launches subagents or threads.",
      });
    }
    const promptDigest = childWorkPromptDigestFor(input.prompt);
    const requestKey =
      input.clientRequestId ??
      childWorkKeylessRequestKeyFor({
        surface: input.surface,
        callerThreadId: input.callerThreadId,
        destinationKey: input.destinationKey,
        promptDigest,
      });
    const now = yield* nowIso;
    const record: ChannelChildWorkRecord = {
      childWorkId: childWorkIdFor(ownership.task.taskId, ownership.task.generation, requestKey),
      ownerId: ownership.ownerId,
      taskId: ownership.task.taskId,
      generation: ownership.task.generation,
      surface: input.surface,
      callerThreadId: input.callerThreadId,
      requestKey,
      promptDigest,
      ...(input.destinationHint === undefined ? {} : { destinationHint: input.destinationHint }),
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    const result = yield* store
      .admitReserved(record, CHANNEL_CHILD_WORK_MAX_ACTIVE)
      .pipe(Effect.mapError((error) => toError("Unable to record child work.", error)));
    if (result._tag === "at_capacity") {
      return yield* new ChannelChildWorkError({
        reason: "at_capacity",
        detail:
          "This work already has " +
          String(CHANNEL_CHILD_WORK_MAX_ACTIVE) +
          " active subagents or threads. Let one finish, or stop it, before launching more.",
      });
    }
    if (result._tag === "existing") {
      return {
        _tag: "existing",
        record: result.record,
        requestKey,
      } as const satisfies ChannelChildWorkAdmission;
    }
    return { _tag: "admitted", record, requestKey } as const satisfies ChannelChildWorkAdmission;
  });

  /** Compare-and-set; false when another writer moved the record first or the write failed. */
  const transition = (
    record: ChannelChildWorkRecord,
    from: ReadonlyArray<ChannelChildWorkState>,
    to: ChannelChildWorkState,
    destination?: ChannelChildWorkDestination,
  ): Effect.Effect<boolean> =>
    nowIso.pipe(
      Effect.flatMap((now) =>
        store.transition({
          taskId: record.taskId,
          childWorkId: record.childWorkId,
          from,
          to,
          ...(destination === undefined ? {} : { destination }),
          now,
        }),
      ),
      Effect.map((next) => next !== undefined),
      Effect.catch((error) =>
        Effect.logWarning("child-work transition failed", {
          childWorkId: record.childWorkId,
          to,
          detail: error.detail,
        }).pipe(Effect.as(false)),
      ),
    );

  // The marker goes up before the record shows launched, so no reader sees a launched record
  // whose launch looks finished; acquisition is uninterruptible, so the finalizer always runs.
  const claimLaunch = (record: ChannelChildWorkRecord, destination: ChannelChildWorkDestination) =>
    Effect.acquireRelease(
      enterLaunch(record).pipe(
        Effect.andThen(transition(record, ["reserved"], "launched", destination)),
        Effect.tap((claimed) => (claimed ? Effect.void : leaveLaunch(record))),
      ),
      (claimed) => (claimed ? leaveLaunch(record) : Effect.void),
    );

  const markBound = (record: ChannelChildWorkRecord, destination?: ChannelChildWorkDestination) =>
    transition(record, ["reserved", "launched"], "bound", destination).pipe(Effect.asVoid);

  const markTerminal = (record: ChannelChildWorkRecord, to: "completed" | "failed" | "cancelled") =>
    transition(record, ["launched", "bound", "unknown"], to).pipe(Effect.asVoid);

  const markReleased = (record: ChannelChildWorkRecord) =>
    transition(record, ["reserved", "launched", "unknown"], "released").pipe(Effect.asVoid);

  const releaseReserved = (record: ChannelChildWorkRecord) =>
    transition(record, ["reserved"], "released").pipe(Effect.asVoid);

  const markUnknown = (record: ChannelChildWorkRecord) =>
    transition(record, ["launched", "bound"], "unknown").pipe(Effect.asVoid);

  // Same liveness the dispatcher's stop applies: a run that has not ended, a finished run
  // whose provider still works in the background, or a cloud task in flight. Settling a
  // refused stop against any of those would abandon live provider work.
  const childThreadLive = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"], {
        turnItemStatuses: ["pending", "running", "waiting"],
      })
      .pipe(
        Effect.map((records) => {
          const runs = records.runs;
          const latestRun = runs.findLast((run) => run.status !== "queued");
          const background =
            latestRun !== undefined &&
            derivePendingBackgroundWork({
              latestRun,
              providerThreads: records.providerThreads,
              turnItems: records.turnItems,
              activeProviderThreadId: records.thread.activeProviderThreadId,
              runs,
            }).length > 0;
          const cloud = records.providerThreads.some(
            (thread) =>
              thread.cloudTask?.status === "running" || thread.cloudTask?.status === "submitting",
          );
          return runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) || background || cloud;
        }),
        // An unreadable thread may still be alive; keep the stop retrying instead of settling.
        Effect.orElseSucceed(() => true),
      );

  const cancelForTask = Effect.fn("ChannelChildWork.cancelForTask")(function* (input: {
    readonly taskId: ChannelTaskId;
    readonly generation: number;
    readonly stopEventId: ChannelTaskEventId;
    readonly attempt: number;
    readonly reason: string;
  }) {
    const records = yield* store
      .listForTask(input.taskId)
      .pipe(Effect.mapError((error) => toError("Unable to list the task's child work.", error)));
    const attemptKey = input.attempt === 0 ? undefined : "attempt-" + input.attempt;
    // Every record gets its pass even when an earlier one must retry, so one stuck child never
    // starves the stop of the others.
    let pending = false;
    let attemptAdvanced = false;
    for (const record of records) {
      if (record.generation !== input.generation || !isChannelChildWorkActive(record.state))
        continue;
      // Never launched: capacity returns, and a launch that has not claimed it yet refuses to
      // run. A claim that won this race leaves the record launched for the next pass to stop.
      // A reservation inserted after this pass is released by reconcile once the owner is
      // terminal.
      if (record.state === "reserved") {
        if (!(yield* transition(record, ["reserved"], "released"))) pending = true;
        continue;
      }
      // Delegates stop with the worker's own cascade; reconcile settles their records.
      if (record.surface === "delegate_local" || record.surface === "delegate_remote") continue;
      const threadId = record.destination?.threadId;
      // A remote-binding child has no local thread to stop; reconcile (and the destination's
      // resolve-or-fence hook) settles it.
      if (threadId === undefined) continue;
      // A launch still running can yet create its thread, so a stop now would find nothing and
      // settle too early. The launch ends bound (the next pass stops it) or released.
      if (record.state === "launched" && isLaunching(record)) {
        pending = true;
        continue;
      }
      const stop = yield* threads
        .dispatch({
          type: "thread.stop",
          commandId: childWorkStopCommandIdFor(record.childWorkId, attemptKey),
          threadId,
          stopDelegatedTasks: true,
          reason: input.reason,
        })
        .pipe(Effect.result);
      if (stop._tag === "Success") {
        if (!(yield* transition(record, ["launched", "bound", "unknown"], "cancelled")))
          pending = true;
        continue;
      }
      if (isThreadMissing(stop.failure)) {
        // A launch that ended without creating its thread ran nothing, so its slot returns; a
        // thread that existed and is gone now was deleted.
        const settled =
          record.state === "launched"
            ? transition(record, ["launched"], "released")
            : transition(record, ["bound", "unknown"], "cancelled");
        if (!(yield* settled)) pending = true;
        continue;
      }
      const tag = (stop.failure as { readonly _tag?: string })._tag;
      const refused =
        tag === "OrchestratorCommandRejectedError" ||
        tag === "OrchestratorCommandPreviouslyRejectedError";
      if (!refused) {
        pending = true;
        continue;
      }
      if (yield* childThreadLive(threadId)) {
        if (!attemptAdvanced) {
          yield* ledger
            .advanceStopAttempt({
              eventId: input.stopEventId,
              from: input.attempt,
              now: yield* nowIso,
            })
            .pipe(
              Effect.mapError((error) => toError("Unable to advance the stop attempt.", error)),
            );
          attemptAdvanced = true;
        }
        pending = true;
        continue;
      }
      if (!(yield* transition(record, ["launched", "bound", "unknown"], "cancelled")))
        pending = true;
    }
    return pending ? ("retry" as const) : ("settled" as const);
  });

  /** The owning task is gone, terminal, or a newer generation: its reservations may release. */
  const owningTaskSettled = Effect.fnUntraced(function* (record: ChannelChildWorkRecord) {
    const stored = yield* ledger.getTask(record.taskId).pipe(Effect.mapError(() => undefined));
    const task = stored?.task;
    return (
      task === undefined ||
      isChannelTaskTerminal(task.status) ||
      task.generation !== record.generation
    );
  });

  const reconcileReserved = Effect.fnUntraced(function* (record: ChannelChildWorkRecord) {
    const settled = yield* owningTaskSettled(record);
    if (!settled) return false;
    return yield* transition(record, ["reserved"], "released");
  });

  const reconcileLocal = Effect.fnUntraced(function* (
    record: ChannelChildWorkRecord,
    threadId: ThreadId,
  ) {
    // The marker is read before the thread: a launch that ends after this check has already
    // committed or abandoned its thread, and its bind wins the compare-and-set below.
    const launchEnded = record.state === "launched" && !isLaunching(record);
    const read = yield* threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.result);
    if (read._tag === "Failure") {
      // A launch that ended without creating its thread (it failed, or the server restarted
      // mid-launch) ran nothing. Any other unreadable thread keeps capacity rather than guess.
      if (launchEnded && isThreadMissing(read.failure))
        return yield* transition(record, ["launched"], "released");
      return false;
    }
    const runs = read.success.runs ?? [];
    if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return false;
    const latest = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (latest === undefined) {
      // Bound work whose thread vanished never landed; work still starting keeps its slot.
      if (record.state === "unknown") return yield* transition(record, ["unknown"], "released");
      return false;
    }
    if (!isTerminalRunStatus(latest.status)) return false;
    return yield* transition(
      record,
      ["launched", "bound", "unknown"],
      recordStateForRun(latest.status),
    );
  });

  const reconcileRemote = Effect.fnUntraced(function* (
    record: ChannelChildWorkRecord,
    correlationId: string,
  ) {
    // Read before the dispatch row, for the same reason as reconcileLocal.
    const launchEnded = record.state === "launched" && !isLaunching(record);
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM remote_dispatches WHERE correlation_id = ${correlationId}
    `.pipe(Effect.mapError(() => undefined));
    if (rows === undefined) return false;
    if (rows[0] === undefined) {
      // The launch inserts its row before any remote write, so one still running keeps its
      // slot and one that ended without a row sent nothing.
      if (!launchEnded) return false;
      return yield* transition(record, ["launched"], "released");
    }
    const state = rows[0].state;
    if (state === "running" || state === "idle") {
      if (record.state !== "bound")
        return yield* transition(record, ["launched", "unknown"], "bound");
      return false;
    }
    if (state === "settled")
      return yield* transition(record, ["launched", "bound", "unknown"], "completed");
    if (state === "cancelled")
      return yield* transition(record, ["launched", "bound", "unknown"], "cancelled");
    if (state === "lost") {
      // The outcome is uncertain until the coordinator's resolve pass settles the row with the
      // destination: rebound (running) or fenced (cancelled).
      if (record.state !== "unknown")
        return yield* transition(record, ["launched", "bound"], "unknown");
    }
    return false;
  });

  const reconcile = Effect.gen(function* () {
    const active = yield* store
      .listActive()
      .pipe(Effect.mapError((error) => toError("Unable to list active child work.", error)));
    let settled = 0;
    for (const record of active) {
      const changed = yield* Effect.gen(function* () {
        if (record.state === "reserved") return yield* reconcileReserved(record);
        const destination = record.destination;
        if (destination?.threadId !== undefined)
          return yield* reconcileLocal(record, destination.threadId);
        if (destination?.correlationId !== undefined) {
          return yield* reconcileRemote(record, destination.correlationId);
        }
        return false;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("child-work reconcile failed", {
            childWorkId: record.childWorkId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (changed) settled += 1;
    }
    return settled;
  }).pipe(Effect.withSpan("ChannelChildWork.reconcile"));

  return ChannelChildWork.of({
    ownershipForCaller,
    admit,
    claimLaunch,
    markBound,
    markTerminal,
    markReleased,
    releaseReserved,
    markUnknown,
    reconcile,
    cancelForTask,
  });
});

export const layer = Layer.effect(ChannelChildWork, make);
