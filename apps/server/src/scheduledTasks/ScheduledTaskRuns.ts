import {
  CommandId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ScheduledTaskError,
  ScheduledTaskRun,
  OrchestrationV2RunJson,
  OrchestrationV2ConversationMessageJson,
  ScheduledTaskSchedule,
  type ScheduledTask,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { nextScheduledRunAt } from "./Schedule.ts";

export type FiringTerminalObserver = (input: {
  readonly taskId: ScheduledTaskId;
  readonly firingIds: ReadonlyArray<CommandId>;
  readonly runId: RunId;
  readonly status: Extract<
    ScheduledTaskRun["status"],
    "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back"
  >;
  readonly terminationCause: OrchestrationV2Run["terminationCause"];
}) => Effect.Effect<void, ScheduledTaskError>;

export class ScheduledTaskRuns extends Context.Service<
  ScheduledTaskRuns,
  {
    readonly begin: (input: {
      readonly task: ScheduledTask;
      readonly firingId: CommandId;
      readonly messageId: MessageId;
      readonly requestedAt: string;
      readonly triggerKind: "scheduled" | "manual" | "webhook";
      readonly webhookDeliveryId: string | null;
    }) => Effect.Effect<
      { readonly created: boolean; readonly dispatch: boolean },
      ScheduledTaskError
    >;
    readonly finishDispatch: (input: {
      readonly firingId: CommandId;
      readonly acceptedRun: OrchestrationV2Run | null;
      readonly at: string;
      readonly dispatchEvidence: "rejected" | "unresolved";
    }) => Effect.Effect<ScheduledTaskRun, ScheduledTaskError>;
    readonly resolveAttribution: (input: {
      readonly firingId: CommandId;
      readonly acceptedRun?: OrchestrationV2Run | null;
    }) => Effect.Effect<
      {
        readonly messageId: MessageId;
        readonly run: OrchestrationV2Run | null;
        readonly sequence: number;
      },
      ScheduledTaskError
    >;
    readonly deliveryReceipt: (
      deliveryId: string,
    ) => Effect.Effect<ScheduledTaskRun | null, ScheduledTaskError>;
    readonly deliveryDispatch: (
      deliveryId: string,
    ) => Effect.Effect<"accepted" | "failed" | "unknown", ScheduledTaskError>;
    readonly record: (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<boolean, ScheduledTaskError>;
    readonly reconcile: Effect.Effect<void, ScheduledTaskError>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly publish: Effect.Effect<void>;
  }
>()("goat/scheduledTasks/ScheduledTaskRuns") {}

interface Row {
  readonly firing_id: string;
  readonly task_id: string;
  readonly task_created_at: string;
  readonly message_id: string;
  readonly trigger_kind: "scheduled" | "manual" | "webhook";
  readonly admitted_next_run_at: string | null;
  readonly admitted_schedule_digest: string;
  readonly admitted_enabled: number;
  readonly webhook_delivery_id: string | null;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly dispatch_status: string;
  readonly status: string;
  readonly requested_at: string;
  readonly dispatch_bookkept_at: string | null;
  readonly completed_at: string | null;
  readonly last_sequence: number;
  readonly snapshot_json: string;
  readonly attempt: number;
}
const codec = Schema.fromJsonString(ScheduledTaskRun);
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(ScheduledTaskSchedule));
const decodeSchedule = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskSchedule));
const terminal = new Set<ScheduledTaskRun["status"]>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
function scheduledStatus(status: OrchestrationV2Run["status"]): ScheduledTaskRun["status"] {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "queued";
    case "running":
    case "waiting":
      return "running";
    default:
      return status;
  }
}
function legacyStatus(status: ScheduledTaskRun["status"]): ScheduledTask["lastRunStatus"] {
  return status === "completed" ? "succeeded" : terminal.has(status) ? "failed" : "running";
}
function safeError(run: ScheduledTaskRun): string | null {
  if (run.dispatchStatus === "failed") return "The scheduled run could not be dispatched.";
  if (run.status === "unknown") return "The scheduled run outcome could not be recovered.";
  return terminal.has(run.status) && run.status !== "completed" ? run.status : null;
}
const isScheduledTaskError = Schema.is(ScheduledTaskError);
const failure = (message: string) => (cause: unknown) =>
  isScheduledTaskError(cause) ? cause : new ScheduledTaskError({ message, cause });

export const make = Effect.fn("ScheduledTaskRuns.make")(function* (
  options: { readonly onFiringTerminal?: FiringTerminalObserver } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const onFiringTerminal = options.onFiringTerminal ?? (() => Effect.void);
  const readSnapshot = Effect.fn("ScheduledTaskRuns.readSnapshot")(function* (row: Row) {
    const snapshot = yield* decode(row.snapshot_json);
    const validIds =
      snapshot.dispatchStatus === "accepted"
        ? snapshot.threadId !== null && snapshot.runId !== null
        : snapshot.dispatchStatus === "unknown"
          ? snapshot.runId === null
          : snapshot.threadId === null && snapshot.runId === null;
    const validStatus =
      snapshot.dispatchStatus === "accepted"
        ? snapshot.status !== "dispatching" && snapshot.status !== "unknown"
        : snapshot.dispatchStatus === "failed"
          ? snapshot.status === "failed"
          : snapshot.status === snapshot.dispatchStatus;
    if (
      !validIds ||
      !validStatus ||
      snapshot.firingId !== row.firing_id ||
      snapshot.runId !== row.run_id ||
      snapshot.threadId !== row.thread_id ||
      snapshot.status !== row.status ||
      snapshot.dispatchStatus !== row.dispatch_status ||
      snapshot.requestedAt !== row.requested_at ||
      snapshot.completedAt !== row.completed_at
    ) {
      return yield* new ScheduledTaskError({ message: "Invalid scheduled firing receipt." });
    }
    return snapshot;
  });
  const readRow = Effect.fn("ScheduledTaskRuns.readRow")(function* (id: CommandId) {
    const rows = yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE firing_id=${id}`;
    if (!rows[0]) return yield* new ScheduledTaskError({ message: "Scheduled firing not found." });
    yield* readSnapshot(rows[0]);
    return rows[0];
  });
  const resolve = Effect.fn("ScheduledTaskRuns.resolveAttribution")(function* (
    row: Row,
    hint?: OrchestrationV2Run | null,
  ) {
    const messages = yield* sql<{
      readonly thread_id: string;
      readonly run_id: string | null;
      readonly payload_json: string;
    }>`SELECT thread_id,run_id,payload_json FROM orchestration_v2_projection_messages WHERE message_id=${row.message_id}`;
    const message = messages[0] ? yield* decodeMessage(messages[0].payload_json) : null;
    if (
      message !== null &&
      (message.scheduledTaskId !== row.task_id ||
        message.id !== row.message_id ||
        message.threadId !== messages[0]?.thread_id ||
        message.runId !== messages[0]?.run_id)
    ) {
      return yield* new ScheduledTaskError({ message: "Invalid scheduled message attribution." });
    }
    const runId = message?.runId ?? row.run_id ?? hint?.id ?? null;
    const threadId = message?.threadId ?? row.thread_id ?? hint?.threadId ?? null;
    let run: OrchestrationV2Run | null = null;
    if (runId !== null && threadId !== null) {
      const rows = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${runId} AND thread_id=${threadId}`;
      if (rows[0]) {
        run = yield* decodeRun(rows[0].payload_json);
        if (
          run.id !== runId ||
          run.threadId !== threadId ||
          (message === null && row.run_id === null && run.userMessageId !== row.message_id)
        ) {
          return yield* new ScheduledTaskError({ message: "Invalid scheduled run attribution." });
        }
      } else if (message?.runId != null) {
        return yield* new ScheduledTaskError({ message: "Scheduled message run is missing." });
      }
    }
    const metadata = yield* sql<{
      readonly last_sequence: number;
    }>`SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'`;
    return {
      messageId: MessageId.make(row.message_id),
      hasMessage: message !== null,
      run,
      sequence: Math.max(row.last_sequence, metadata[0]?.last_sequence ?? 0),
    };
  });
  const resolveAttribution: ScheduledTaskRuns["Service"]["resolveAttribution"] = Effect.fn(
    "ScheduledTaskRuns.resolveAttribution",
  )(
    function* (input) {
      return yield* resolve(yield* readRow(input.firingId), input.acceptedRun);
    },
    Effect.mapError(failure("Could not resolve scheduled firing.")),
  );

  const prune = Effect.fn("ScheduledTaskRuns.prune")(function* (
    row: Pick<Row, "task_id" | "task_created_at">,
  ) {
    yield* sql`DELETE FROM scheduled_task_runs
      WHERE task_id=${row.task_id} AND task_created_at=${row.task_created_at} AND dispatch_bookkept_at IS NOT NULL
      AND dispatch_status <> 'dispatching' AND status IN ('completed','failed','interrupted','cancelled','rolled_back')
      AND firing_id IS NOT (SELECT last_firing_id FROM scheduled_tasks WHERE task_id=${row.task_id})
      AND NOT EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p WHERE p.delivery_id=scheduled_task_runs.webhook_delivery_id)
      AND NOT (dispatch_status='failed' AND webhook_delivery_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM scheduled_task_webhook_deliveries d WHERE d.delivery_id=scheduled_task_runs.webhook_delivery_id))`;
    yield* sql`DELETE FROM scheduled_task_runs WHERE task_id=${row.task_id} AND task_created_at=${row.task_created_at}
      AND status='unknown' AND dispatch_bookkept_at IS NOT NULL
      AND firing_id IS NOT (SELECT last_firing_id FROM scheduled_tasks WHERE task_id=${row.task_id})
      AND NOT EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p WHERE p.delivery_id=scheduled_task_runs.webhook_delivery_id)
      AND firing_id NOT IN (SELECT firing_id FROM scheduled_task_runs WHERE task_id=${row.task_id}
        AND task_created_at=${row.task_created_at} AND status='unknown' AND dispatch_bookkept_at IS NOT NULL
        ORDER BY requested_at DESC,firing_id DESC LIMIT 5)`;
  });

  const begin: ScheduledTaskRuns["Service"]["begin"] = Effect.fn("ScheduledTaskRuns.begin")(
    function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const tasks = yield* sql<{
            readonly created_at: string;
            readonly next_run_at: string | null;
            readonly schedule_json: string;
            readonly enabled: number;
          }>`SELECT created_at,next_run_at,schedule_json,enabled FROM scheduled_tasks WHERE task_id=${input.task.id}`;
          const task = tasks[0];
          if (
            !task ||
            task.created_at !== input.task.createdAt ||
            task.next_run_at !== input.task.nextRunAt ||
            task.enabled !== Number(input.task.enabled)
          )
            return yield* new ScheduledTaskError({
              message: "Schedule task changed before admission.",
            });
          const decodedSchedule = yield* decodeSchedule(task.schedule_json);
          const supplied = yield* encodeSchedule(input.task.schedule);
          const canonical = yield* encodeSchedule(decodedSchedule);
          if (
            supplied !== canonical ||
            (input.triggerKind === "scheduled" && task.next_run_at === null)
          ) {
            return yield* new ScheduledTaskError({
              message: "Schedule task changed before admission.",
            });
          }
          const existing =
            (yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE firing_id=${input.firingId}`)[0];
          if (
            existing &&
            (existing.task_id !== input.task.id ||
              existing.task_created_at !== input.task.createdAt ||
              existing.message_id !== input.messageId ||
              existing.webhook_delivery_id !== input.webhookDeliveryId)
          ) {
            return yield* new ScheduledTaskError({
              message: "Scheduled firing identity does not match task.",
            });
          }
          if (existing) {
            const previous = yield* readSnapshot(existing);
            const durable = yield* resolve(existing);
            if (
              input.triggerKind !== "webhook" ||
              previous.dispatchStatus !== "failed" ||
              durable.run !== null ||
              durable.hasMessage
            )
              return { created: false, dispatch: false };
          }
          const busy =
            yield* sql`SELECT 1 FROM scheduled_task_runs WHERE task_id=${input.task.id} AND task_created_at=${input.task.createdAt} AND firing_id<>${input.firingId} AND (dispatch_bookkept_at IS NULL OR dispatch_status='dispatching')`;
          if (busy.length)
            return yield* new ScheduledTaskError({
              message: "Schedule task is already running.",
            });
          const snapshot: ScheduledTaskRun = {
            firingId: input.firingId,
            dispatchStatus: "dispatching",
            status: "dispatching",
            threadId: null,
            runId: null,
            requestedAt: input.requestedAt,
            dispatchedAt: null,
            startedAt: null,
            completedAt: null,
          };
          const json = yield* encode(snapshot);
          if (existing) {
            yield* sql`UPDATE scheduled_task_runs SET dispatch_status='dispatching',status='dispatching',thread_id=NULL,run_id=NULL,
          requested_at=${input.requestedAt},completed_at=NULL,dispatch_bookkept_at=NULL,last_sequence=0,snapshot_json=${json},attempt=attempt+1,
          admitted_next_run_at=${task.next_run_at},admitted_schedule_digest=${task.schedule_json},admitted_enabled=${task.enabled}
          WHERE firing_id=${input.firingId}`;
          } else {
            yield* sql`INSERT INTO scheduled_task_runs (firing_id,task_id,task_created_at,message_id,trigger_kind,admitted_next_run_at,admitted_schedule_digest,admitted_enabled,webhook_delivery_id,dispatch_status,status,requested_at,snapshot_json)
          VALUES (${input.firingId},${input.task.id},${input.task.createdAt},${input.messageId},${input.triggerKind},${task.next_run_at},${task.schedule_json},${task.enabled},${input.webhookDeliveryId},'dispatching','dispatching',${input.requestedAt},${json})`;
          }
          yield* sql`UPDATE scheduled_tasks SET last_firing_id=${input.firingId},last_run_at=${input.requestedAt},last_run_status='running',last_run_error=NULL,
        last_run_webhook_delivery_id=${input.webhookDeliveryId},updated_at=${input.requestedAt},run_count=run_count+1 WHERE task_id=${input.task.id} AND created_at=${input.task.createdAt}`;
          yield* prune({ task_id: input.task.id, task_created_at: input.task.createdAt });
          return { created: !existing, dispatch: true };
        }),
      );
    },
    Effect.mapError(failure("Could not admit scheduled firing.")),
  );

  // EventSink owns the batch span; this reducer also runs within finishDispatch's transaction.
  const writeResolvedSnapshots = Effect.fnUntraced(function* (
    inputs: ReadonlyArray<{
      readonly row: Row;
      readonly run: OrchestrationV2Run | null;
      readonly sequence: number;
      readonly at: string;
      readonly hasMessage?: boolean;
      readonly evidence: "rejected" | "unresolved";
    }>,
  ) {
    let visible = false;
    const newlyTerminal = new Map<
      string,
      {
        readonly row: Row;
        readonly run: OrchestrationV2Run;
        readonly status: FiringTerminalObserver extends (input: infer I) => unknown
          ? I extends { status: infer S }
            ? S
            : never
          : never;
      }
    >();
    for (const { row, run, sequence, at, evidence, hasMessage } of inputs) {
      const before = yield* readSnapshot(row);
      let next = before;
      if (run !== null) {
        const status = scheduledStatus(run.status);
        const rebound = before.runId !== null && before.runId !== run.id;
        if (
          rebound ||
          before.dispatchStatus !== "accepted" ||
          !terminal.has(before.status) ||
          status === "rolled_back" ||
          status === before.status
        ) {
          next = {
            ...before,
            dispatchStatus: "accepted",
            status,
            threadId: run.threadId,
            runId: run.id,
            dispatchedAt: before.dispatchedAt ?? DateTime.formatIso(run.requestedAt),
            startedAt:
              run.startedAt === null
                ? rebound
                  ? null
                  : before.startedAt
                : DateTime.formatIso(run.startedAt),
            completedAt: terminal.has(status)
              ? run.completedAt === null
                ? ((before.dispatchStatus === "accepted" ? before.completedAt : null) ?? at)
                : DateTime.formatIso(run.completedAt)
              : rebound || before.dispatchStatus !== "accepted"
                ? null
                : before.completedAt,
          };
        }
      } else if (
        before.dispatchStatus !== "accepted" &&
        (before.dispatchStatus !== "failed" || hasMessage === true)
      ) {
        next = {
          ...before,
          dispatchStatus: evidence === "rejected" ? "failed" : "unknown",
          status: evidence === "rejected" ? "failed" : "unknown",
          completedAt: evidence === "rejected" ? at : null,
        };
      }
      const json = yield* encode(next);
      const changed = json !== row.snapshot_json;
      if (!changed && sequence <= row.last_sequence) continue;
      const updated =
        yield* sql`UPDATE scheduled_task_runs SET thread_id=${next.threadId},run_id=${next.runId},dispatch_status=${next.dispatchStatus},
        status=${next.status},completed_at=${next.completedAt},snapshot_json=${json},last_sequence=${Math.max(sequence, row.last_sequence)}
        WHERE firing_id=${row.firing_id} AND task_created_at=${row.task_created_at} AND last_sequence=${row.last_sequence}
        AND EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id=${row.task_id} AND created_at=${row.task_created_at}) RETURNING firing_id`;
      if (!updated.length)
        return yield* new ScheduledTaskError({
          message: "Scheduled firing changed during observation.",
        });
      if (!changed) continue;
      const current =
        yield* sql`UPDATE scheduled_tasks SET last_run_status=${legacyStatus(next.status)},last_run_error=${safeError(next)},updated_at=${at}
        WHERE task_id=${row.task_id} AND created_at=${row.task_created_at} AND last_firing_id=${row.firing_id} RETURNING task_id`;
      visible ||= current.length > 0;
      if (
        run &&
        next.dispatchStatus === "accepted" &&
        (before.runId !== next.runId || before.status !== next.status)
      ) {
        switch (next.status) {
          case "completed":
          case "failed":
          case "interrupted":
          case "cancelled":
          case "rolled_back":
            newlyTerminal.set(`${row.task_id}:${run.id}`, { row, run, status: next.status });
        }
      }
    }
    for (const { row, run, status } of newlyTerminal.values()) {
      const applicable =
        yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE task_id=${row.task_id} AND task_created_at=${row.task_created_at} AND run_id=${run.id} AND dispatch_status='accepted'`;
      yield* onFiringTerminal({
        taskId: ScheduledTaskId.make(row.task_id),
        firingIds: applicable.map((receipt) => CommandId.make(receipt.firing_id)),
        runId: run.id,
        status,
        terminationCause: run.terminationCause,
      });
    }
    return visible;
  });

  const advanceOccurrence = Effect.fn("ScheduledTaskRuns.advanceOccurrence")(function* (
    row: Row,
    at: string,
  ) {
    if (row.dispatch_bookkept_at === null) {
      const tasks = yield* sql<{
        readonly schedule_json: string;
        readonly enabled: number;
      }>`SELECT schedule_json,enabled FROM scheduled_tasks WHERE task_id=${row.task_id} AND created_at=${row.task_created_at}`;
      if (tasks[0]) {
        const schedule = yield* decodeSchedule(tasks[0].schedule_json);
        const from = yield* DateTime.withCurrentZoneLocal(
          DateTime.setZoneCurrent(DateTime.makeUnsafe(at)),
        );
        let next: string | null = null;
        if (tasks[0].enabled === 1) {
          try {
            const value = nextScheduledRunAt(schedule, from);
            if (value !== null && Number.isFinite(DateTime.toEpochMillis(value)))
              next = DateTime.formatIso(DateTime.toUtc(value));
          } catch {
            next = null;
          }
        }
        yield* sql`UPDATE scheduled_tasks SET next_run_at=${next} WHERE task_id=${row.task_id} AND created_at=${row.task_created_at}
            AND last_firing_id=${row.firing_id} AND next_run_at IS ${row.admitted_next_run_at}
            AND schedule_json=${row.admitted_schedule_digest} AND enabled=${row.admitted_enabled}`;
      }
      yield* sql`UPDATE scheduled_task_runs SET dispatch_bookkept_at=${at} WHERE firing_id=${row.firing_id} AND task_created_at=${row.task_created_at} AND dispatch_bookkept_at IS NULL`;
    }
  });

  const finishDispatch: ScheduledTaskRuns["Service"]["finishDispatch"] = Effect.fn(
    "ScheduledTaskRuns.finishDispatch",
  )(
    function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* readRow(input.firingId);
          const resolved = yield* resolve(row, input.acceptedRun);
          yield* writeResolvedSnapshots([
            {
              row,
              ...resolved,
              at: input.at,
              evidence: resolved.hasMessage ? "unresolved" : input.dispatchEvidence,
            },
          ]);
          yield* advanceOccurrence(row, input.at);
          const snapshot = yield* readSnapshot(yield* readRow(input.firingId));
          yield* prune(row);
          return snapshot;
        }),
      );
    },
    Effect.mapError(failure("Could not finish scheduled dispatch.")),
  );

  const deliveryReceipt: ScheduledTaskRuns["Service"]["deliveryReceipt"] = Effect.fn(
    "ScheduledTaskRuns.deliveryReceipt",
  )(
    function* (deliveryId) {
      const rows =
        yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE webhook_delivery_id=${deliveryId}`;
      return rows[0] ? yield* readSnapshot(rows[0]) : null;
    },
    Effect.mapError(failure("Could not read scheduled delivery receipt.")),
  );
  const deliveryDispatch: ScheduledTaskRuns["Service"]["deliveryDispatch"] = Effect.fn(
    "ScheduledTaskRuns.deliveryDispatch",
  )(
    function* (deliveryId) {
      const rows =
        yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE webhook_delivery_id=${deliveryId}`;
      if (!rows[0]) return "unknown" as const;
      const snapshot = yield* readSnapshot(rows[0]);
      const resolved = yield* resolve(rows[0]);
      if (resolved.run !== null || snapshot.dispatchStatus === "accepted")
        return "accepted" as const;
      return snapshot.dispatchStatus === "failed" && !resolved.hasMessage
        ? ("failed" as const)
        : ("unknown" as const);
    },
    Effect.mapError(failure("Could not resolve scheduled delivery dispatch.")),
  );

  // Final projections are available only after EventSink has applied the entire batch.
  const record: ScheduledTaskRuns["Service"]["record"] = Effect.fnUntraced(
    function* (events) {
      const candidates = new Map<string, Row>();
      for (const { event } of events) {
        let rows: ReadonlyArray<Row> = [];
        if (event.type === "run.created" || event.type === "run.updated") {
          rows = yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE run_id=${event.payload.id}
          UNION SELECT * FROM scheduled_task_runs WHERE message_id=${event.payload.userMessageId}`;
        } else if (
          event.type === "message.updated" &&
          event.payload.scheduledTaskId !== undefined
        ) {
          rows =
            yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE message_id=${event.payload.id}`;
        }
        for (const row of rows) candidates.set(row.firing_id, row);
      }
      const observations = [];
      for (const row of candidates.values()) {
        const resolved = yield* resolve(row);
        if (resolved.sequence <= row.last_sequence || resolved.run === null) continue;
        const observation = events.findLast(
          ({ event }) =>
            (event.type === "run.updated" || event.type === "run.created") &&
            event.payload.id === resolved.run?.id,
        );
        const at = observation
          ? DateTime.formatIso(observation.event.occurredAt)
          : DateTime.formatIso(yield* DateTime.now);
        observations.push({ row, ...resolved, at, evidence: "unresolved" as const });
      }
      const changed = yield* writeResolvedSnapshots(observations);
      for (const row of candidates.values()) yield* prune(row);
      return changed;
    },
    Effect.mapError(failure("Could not record scheduled run outcome.")),
  );
  const reconcile = Effect.gen(function* () {
    let after = "";
    while (true) {
      const rows = yield* sql<Row>`SELECT * FROM scheduled_task_runs WHERE firing_id>${after}
        AND (dispatch_bookkept_at IS NULL OR status IN ('dispatching','queued','running','unknown')) ORDER BY firing_id LIMIT 100`;
      if (!rows.length) break;
      for (const row of rows)
        yield* finishDispatch({
          firingId: CommandId.make(row.firing_id),
          acceptedRun: null,
          at: DateTime.formatIso(yield* DateTime.now),
          dispatchEvidence: "unresolved",
        });
      after = rows[rows.length - 1]?.firing_id ?? after;
    }
  }).pipe(Effect.mapError(failure("Could not reconcile scheduled firings.")));
  return ScheduledTaskRuns.of({
    begin,
    finishDispatch,
    resolveAttribution,
    deliveryReceipt,
    deliveryDispatch,
    record,
    reconcile,
    subscribeChanges: PubSub.subscribe(changes),
    publish: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
  });
});
export const layer = Layer.effect(ScheduledTaskRuns, make());
