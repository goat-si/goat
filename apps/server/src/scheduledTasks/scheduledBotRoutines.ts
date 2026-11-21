import {
  AuthEnvironmentScope,
  IsoDateTime,
  ProjectId,
  ThreadId,
  type CommandId,
  type ScheduledTask,
  type ScheduledTaskError,
  type ScheduledTaskId,
  type ScheduledTaskUpsertSchedule,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { fenceWorkTriggerRollback } from "../persistence/reconcileGoatMigrationIds.ts";
import { filterRoutineOwnWork } from "../channels/channelRoutineOwnWork.ts";
import type { PendingWebhookTask } from "./webhookDedupe.ts";
import { WebhookDeliverySkipped } from "./webhookTriggerTypes.ts";
import type { WebhookRequest } from "./webhookTemplate.ts";
import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import { taskError } from "./scheduledTaskError.ts";
export { ROUTINE_MESSAGE_PREFIX } from "./ScheduledTaskRuns.ts";

/** The person who set up a routine in a GOAT Bot conversation; its firings speak for them. */
export const RoutineOwner = Schema.Struct({
  principalId: Schema.String,
  grantedScopes: Schema.Array(AuthEnvironmentScope),
  sessionId: Schema.optional(Schema.String),
  routineMode: Schema.optional(Schema.Literal("work")),
  bindingRevision: Schema.optional(Schema.Int),
});
export type RoutineOwner = typeof RoutineOwner.Type;

/** What one firing hands the bot, frozen at admission so recovery repeats it exactly. */
export const RoutineInputPayload = Schema.Struct({
  ...RoutineOwner.fields,
  threadId: ThreadId,
  text: Schema.String,
  receivedAt: IsoDateTime,
  projectId: Schema.optional(ProjectId),
  webhookDeliveryId: Schema.optional(Schema.String),
  taskCreatedAt: Schema.optional(IsoDateTime),
});
export type RoutineInputPayload = typeof RoutineInputPayload.Type;

const OwnerJson = Schema.fromJsonString(RoutineOwner);
const PayloadJson = Schema.fromJsonString(RoutineInputPayload);
const decodeOwner = Schema.decodeUnknownOption(OwnerJson);
const encodeOwner = Schema.encodeSync(OwnerJson);
export const decodeRoutinePayload = Schema.decodeUnknownEffect(PayloadJson);
const encodePayload = Schema.encodeSync(PayloadJson);

/** The stored owner that binds a routine to GOAT Bot for good; none when absent or unreadable. */
export const routineOwnerOf = (ownerJson: string | null | undefined) =>
  Option.flatMap(Option.fromNullishOr(ownerJson), decodeOwner);

export const routineBindingRevision = (ownerJson: string | null | undefined) =>
  Option.getOrUndefined(routineOwnerOf(ownerJson))?.bindingRevision;

export const BOT_ROUTINE_NEEDS_OWNER =
  "Set this routine up again from GOAT Bot or Settings: it has no person to run as.";

export const makeScheduledBotRoutines = Effect.fn("ScheduledBotRoutines.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Required: without it every bot thread looks ordinary and its routines would send directly.
  const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
  const isBotThread = (threadId: string | null) =>
    threadId === null
      ? Effect.succeed(false)
      : directory
          .isBotThread(ThreadId.make(threadId))
          .pipe(
            Effect.mapError((cause) => taskError("Could not read GOAT Bot threads.", { cause })),
          );

  const requireWorkOwner = (taskId: ScheduledTaskId, owner: RoutineOwner | undefined) =>
    owner?.sessionId !== undefined &&
    owner.grantedScopes.includes("settings:write") &&
    owner.grantedScopes.includes("orchestration:operate")
      ? Effect.succeed(owner)
      : Effect.fail(
          taskError("Only a person with settings access can manage a GOAT Bot work trigger.", {
            taskId,
          }),
        );

  const checkUpsert = Effect.fn("ScheduledBotRoutines.checkUpsert")(function* (
    input: {
      readonly taskId: ScheduledTaskId;
      readonly threadId: string | null;
      readonly schedule: ScheduledTaskUpsertSchedule;
      readonly routineMode: ScheduledTask["routineMode"];
    },
    owner: RoutineOwner | undefined,
    existing: ScheduledTask | null,
  ) {
    const work = input.routineMode === "work";
    if (work || existing?.routineMode === "work") {
      const person = yield* requireWorkOwner(input.taskId, owner);
      if (existing?.routineMode === "work") {
        const current = yield* kind(existing);
        if (current.type !== "linkable" || current.owner.principalId !== person.principalId)
          return yield* taskError(
            "The person who set up this trigger must save changes to its grant.",
            { taskId: input.taskId },
          );
      }
      if (!work || input.schedule.type !== "webhook" || input.schedule.signature == null)
        return yield* taskError("A work trigger needs a signed webhook schedule.", {
          taskId: input.taskId,
        });
      if (!(yield* isBotThread(input.threadId)))
        return yield* taskError("A work trigger must belong to a GOAT Bot conversation.", {
          taskId: input.taskId,
        });
      return { ...person, routineMode: "work" as const };
    }
    if (owner === undefined && existing?.goatBotRoutine)
      return yield* taskError("Only a person can edit a GOAT Bot routine.", {
        taskId: input.taskId,
      });
    const keepsBinding =
      input.threadId !== null && existing?.goatBotRoutine && existing.threadId === input.threadId;
    if (!keepsBinding && !(yield* isBotThread(input.threadId))) return null;
    if (input.schedule.type === "webhook")
      return yield* taskError("A GOAT Bot routine runs on a schedule, not a webhook.", {
        taskId: input.taskId,
      });
    if (owner === undefined)
      return yield* taskError("Only a person can set up a routine in a GOAT Bot conversation.", {
        taskId: input.taskId,
      });
    return { principalId: owner.principalId, grantedScopes: owner.grantedScopes };
  });

  const checkEnable = Effect.fn("ScheduledBotRoutines.checkEnable")(function* (
    task: ScheduledTask,
    enabled: boolean,
    owner?: RoutineOwner,
  ) {
    if (task.routineMode !== "work") return;
    yield* requireWorkOwner(task.id, owner);
    if (
      enabled &&
      (task.schedule.type !== "webhook" ||
        task.schedule.signature === null ||
        !task.webhook?.hasSecret)
    )
      return yield* taskError("A webhook signature check needs a signing secret.", {
        taskId: task.id,
      });
  });

  const saveOwner = (taskId: ScheduledTaskId, owner: RoutineOwner | null) =>
    sql`UPDATE scheduled_tasks SET owner_json = ${owner === null ? null : encodeOwner(owner)}
      WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        taskError("Could not save the routine's owner.", { taskId, cause }),
      ),
    );

  const binding = Effect.fn("ScheduledBotRoutines.binding")(function* (taskId: ScheduledTaskId) {
    const [row] = yield* sql<{
      readonly owner_json: string | null;
      readonly project_id: string;
      readonly thread_id: string | null;
    }>`SELECT owner_json, project_id, thread_id FROM scheduled_tasks WHERE task_id = ${taskId}`;
    return row === undefined
      ? undefined
      : { ...row, revision: routineBindingRevision(row.owner_json) };
  });

  /** The task row and its owner commit together, so a crash never leaves a bot routine unowned. */
  const saveWithOwner = <A>(
    save: Effect.Effect<A, ScheduledTaskError>,
    task: ScheduledTask,
    owner: RoutineOwner | null,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = owner?.routineMode === "work" ? yield* binding(task.id) : undefined;
          const revision =
            previous?.project_id === task.projectId && previous.thread_id === task.threadId
              ? (previous.revision ?? 0)
              : (previous?.revision ?? 0) + 1;
          const result = yield* save;
          if (owner?.routineMode === "work")
            yield* fenceWorkTriggerRollback().pipe(Effect.provideService(SqlClient.SqlClient, sql));
          yield* saveOwner(
            task.id,
            owner?.routineMode === "work" ? { ...owner, bindingRevision: revision } : owner,
          );
          return result;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(taskError("Could not save the routine.", { taskId: task.id, cause })),
        }),
      );

  /**
   * none: an ordinary task; unowned: a bot routine that cannot run; linkable: the channel path.
   * A stored owner marks the binding for good: a bot thread replaced since stays answer-only, and
   * the gateway refuses it if no bot takes that thread any more.
   */
  const kind = Effect.fn("ScheduledBotRoutines.kind")(function* (task: ScheduledTask) {
    const rows = yield* sql<{ readonly owner_json: string | null }>`
      SELECT owner_json FROM scheduled_tasks WHERE task_id = ${task.id}`.pipe(
      Effect.mapError((cause) => taskError("Could not read the routine's owner.", { cause })),
    );
    const owner = routineOwnerOf(rows[0]?.owner_json);
    if (Option.isSome(owner)) return { type: "linkable", owner: owner.value } as const;
    if (rows[0]?.owner_json != null) return { type: "unowned" } as const;
    return (yield* isBotThread(task.threadId))
      ? ({ type: "unowned" } as const)
      : ({ type: "none" } as const);
  });

  /** Runs inside the admission transaction, so no admitted bot firing lacks its input. */
  const link = (input: {
    readonly task: ScheduledTask;
    readonly owner: RoutineOwner;
    readonly firingId: CommandId;
    readonly at: string;
    readonly webhook?: { readonly deliveryId: string; readonly prompt: string };
  }) =>
    sql`INSERT INTO scheduled_task_channel_inputs (firing_id, task_id, payload_json, state, created_at)
      VALUES (${input.firingId}, ${input.task.id}, ${encodePayload({
        ...input.owner,
        threadId: ThreadId.make(input.task.threadId ?? ""),
        text: input.webhook?.prompt ?? input.task.prompt,
        ...(input.task.routineMode === "work" && input.webhook !== undefined
          ? {
              projectId: input.task.projectId,
              webhookDeliveryId: input.webhook.deliveryId,
              taskCreatedAt: input.task.createdAt,
            }
          : {}),
        receivedAt: input.at,
      })}, 'pending', ${input.at})
      ON CONFLICT (firing_id) DO NOTHING`.pipe(Effect.asVoid);

  const ownWorkFilter = Effect.fn("ScheduledBotRoutines.ownWorkFilter")(
    function* (task: ScheduledTask, request: WebhookRequest) {
      if (task.routineMode !== "work" || task.schedule.type !== "webhook") return undefined;
      const bot = task.threadId === null ? undefined : yield* directory.botForThread(task.threadId);
      if (bot === undefined) return "Filtered: the GOAT Bot conversation is unavailable.";
      return yield* filterRoutineOwnWork({
        request,
        ...bot,
        allowChecksWithoutPullRequest: task.schedule.allowChecksWithoutPullRequest === true,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    },
    Effect.mapError((cause) => taskError("Could not check webhook work provenance.", { cause })),
  );
  const outstanding = Effect.fn("ScheduledBotRoutines.outstanding")(function* (
    taskId: ScheduledTaskId,
  ) {
    const [row] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
      FROM scheduled_task_channel_inputs WHERE state <> 'settled' AND task_id = ${taskId}`;
    return row?.count ?? 0;
  });
  const handedOff = Effect.fn("ScheduledBotRoutines.handedOff")(function* (deliveryId: string) {
    const rows = yield* sql`SELECT 1 FROM scheduled_task_runs r JOIN scheduled_task_channel_inputs l
      ON l.firing_id = r.firing_id WHERE r.webhook_delivery_id = ${deliveryId}`;
    return rows.length > 0;
  });
  const verifyAdmission = Effect.fn("ScheduledBotRoutines.verifyAdmission")(function* (
    task: PendingWebhookTask,
    deliveryId: string | undefined,
    routine: Effect.Success<ReturnType<typeof kind>>,
  ) {
    if (
      deliveryId === undefined ||
      routine.type !== "linkable" ||
      routine.owner.routineMode !== "work"
    )
      return yield* taskError("A bot work trigger needs a verified webhook.", { taskId: task.id });
    const current = yield* binding(task.id);
    if (
      current?.revision !== task.bindingRevision ||
      current?.project_id !== task.projectId ||
      current?.thread_id !== task.threadId
    )
      return yield* new WebhookDeliverySkipped({
        reason: "The task was replaced before this delivery ran.",
      });
    const rows = yield* sql`SELECT 1 FROM scheduled_task_webhook_deliveries
      WHERE task_id = ${task.id} AND delivery_id = ${deliveryId} AND signature_verified = 1`;
    if (rows.length !== 1)
      return yield* taskError("A bot work trigger needs a verified webhook.", { taskId: task.id });
  });

  return {
    checkUpsert,
    checkEnable,
    requireWorkOwner,
    saveWithOwner,
    kind,
    link,
    ownWorkFilter,
    outstanding,
    handedOff,
    verifyAdmission,
  };
});
