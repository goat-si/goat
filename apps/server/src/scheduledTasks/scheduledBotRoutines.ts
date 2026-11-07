import {
  AuthEnvironmentScope,
  IsoDateTime,
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
import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import { taskError } from "./scheduledTaskError.ts";
export { ROUTINE_MESSAGE_PREFIX } from "./ScheduledTaskRuns.ts";

/** The person who set up a routine in a GOAT Bot conversation; its firings speak for them. */
export const RoutineOwner = Schema.Struct({
  principalId: Schema.String,
  grantedScopes: Schema.Array(AuthEnvironmentScope),
});
export type RoutineOwner = typeof RoutineOwner.Type;

/** What one firing hands the bot, frozen at admission so recovery repeats it exactly. */
export const RoutineInputPayload = Schema.Struct({
  ...RoutineOwner.fields,
  threadId: ThreadId,
  text: Schema.String,
  receivedAt: IsoDateTime,
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

  /** A routine in a bot conversation needs the person who set it up and a timer schedule. */
  const checkUpsert = Effect.fn("ScheduledBotRoutines.checkUpsert")(function* (
    input: {
      readonly taskId: ScheduledTaskId;
      readonly threadId: string | null;
      readonly schedule: ScheduledTaskUpsertSchedule;
    },
    owner: RoutineOwner | undefined,
  ) {
    // Saving a routine without moving it keeps its bot binding, even if that thread was replaced.
    const bound = yield* sql<{ readonly thread_id: string | null }>`
      SELECT thread_id FROM scheduled_tasks WHERE task_id = ${input.taskId} AND owner_json IS NOT NULL`.pipe(
      Effect.mapError((cause) => taskError("Could not read the routine's owner.", { cause })),
    );
    const keepsBinding = input.threadId !== null && bound[0]?.thread_id === input.threadId;
    if (!keepsBinding && !(yield* isBotThread(input.threadId))) return null;
    if (input.schedule.type === "webhook")
      return yield* taskError("A GOAT Bot routine runs on a schedule, not a webhook.", {
        taskId: input.taskId,
      });
    if (owner === undefined)
      return yield* taskError("Only a person can set up a routine in a GOAT Bot conversation.", {
        taskId: input.taskId,
      });
    return owner;
  });

  const saveOwner = (taskId: ScheduledTaskId, owner: RoutineOwner | null) =>
    sql`UPDATE scheduled_tasks SET owner_json = ${owner === null ? null : encodeOwner(owner)}
      WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        taskError("Could not save the routine's owner.", { taskId, cause }),
      ),
    );

  /** The task row and its owner commit together, so a crash never leaves a bot routine unowned. */
  const saveWithOwner = <A>(
    save: Effect.Effect<A, ScheduledTaskError>,
    taskId: ScheduledTaskId,
    owner: RoutineOwner | null,
  ) =>
    sql.withTransaction(save.pipe(Effect.andThen(saveOwner(taskId, owner)))).pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(taskError("Could not save the routine.", { taskId, cause })),
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
  }) =>
    sql`INSERT INTO scheduled_task_channel_inputs (firing_id, task_id, payload_json, state, created_at)
      VALUES (${input.firingId}, ${input.task.id}, ${encodePayload({
        ...input.owner,
        threadId: ThreadId.make(input.task.threadId ?? ""),
        text: input.task.prompt,
        receivedAt: input.at,
      })}, 'pending', ${input.at})
      ON CONFLICT (firing_id) DO NOTHING`.pipe(Effect.asVoid);

  return { checkUpsert, saveWithOwner, kind, link };
});
