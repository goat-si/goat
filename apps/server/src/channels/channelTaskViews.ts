// @effect-diagnostics-next-line nodeBuiltinImport:off -- View events need a durable id independent of task versions.
import * as NodeCrypto from "node:crypto";
import {
  ChannelBotTaskActivityEntry,
  ChannelGatewayError,
  NonNegativeInt,
  type ChannelSnoozeBotTaskInput,
  type ChannelUnsnoozeBotTaskInput,
  ChannelTaskView,
  type ChannelTaskId,
  type ChannelUpdateTaskViewInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

import * as ChannelLedger from "./ChannelLedger.ts";

const isGatewayError = Schema.is(ChannelGatewayError);
const StoredView = Schema.Struct({
  ...ChannelTaskView.fields,
  snoozedStatusVersion: Schema.optionalKey(NonNegativeInt),
});
type StoredView = typeof StoredView.Type;
export const decodeTaskView = Schema.decodeUnknownSync(Schema.fromJsonString(StoredView));
const encode = Schema.encodeSync(Schema.fromJsonString(StoredView));
const encodeActivity = Schema.encodeSync(Schema.fromJsonString(ChannelBotTaskActivityEntry));

export const visibleTaskView = (
  { snoozedStatusVersion, snoozedUntil, ...view }: StoredView,
  statusVersion: number,
  now: number,
): ChannelTaskView =>
  snoozedStatusVersion === statusVersion &&
  snoozedUntil !== undefined &&
  Date.parse(snoozedUntil) > now
    ? { ...view, snoozedUntil }
    : view;
export const taskViewKeyPrefix = (ownerId: string) =>
  "task-view:" + encodeURIComponent(ownerId) + ":";
export const taskViewKey = (ownerId: string, taskId: ChannelTaskId) =>
  taskViewKeyPrefix(ownerId) + encodeURIComponent(taskId);
function snoozeDeadline(input: ChannelSnoozeBotTaskInput, now: DateTime.Utc) {
  if ("until" in input) return Date.parse(input.until);
  if (input.preset === "hour") return DateTime.toEpochMillis(DateTime.addDuration(now, 3_600_000));
  const zoned = DateTime.makeZoned(now, { timeZone: input.timeZone ?? "UTC" });
  if (Option.isNone(zoned)) return NaN;
  const weekday = DateTime.toParts(zoned.value).weekDay;
  const days = input.preset === "tomorrow" ? 1 : (8 - weekday) % 7 || 7;
  const wake = DateTime.setParts(DateTime.add(zoned.value, { days }), {
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return DateTime.toEpochMillis(wake);
}

const persistenceFailed = () => new ChannelGatewayError({ reason: "persistence_failed" });

export class ChannelTaskViews extends Context.Service<
  ChannelTaskViews,
  {
    readonly get: (
      taskId: ChannelTaskId,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly snooze: (
      input: ChannelSnoozeBotTaskInput | ChannelUnsnoozeBotTaskInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly update: (
      input: ChannelUpdateTaskViewInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
  }
>()("goat/channels/channelTaskViews") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const read = Effect.fn("ChannelTaskViews.read")(function* (
    taskId: ChannelTaskId,
    ownerId: string,
  ) {
    const rows = yield* sql<{
      readonly value_json: string;
    }>`SELECT value_json FROM channel_runtime_state WHERE key = ${taskViewKey(ownerId, taskId)}`;
    const view = yield* Effect.try(() =>
      rows[0] === undefined
        ? { taskId, pinnedAt: null, doneAt: null, readThrough: null }
        : decodeTaskView(rows[0].value_json),
    );
    if (view.taskId !== taskId) return yield* persistenceFailed();
    return view;
  });
  const get = Effect.fn("ChannelTaskViews.get")(function* (
    taskId: ChannelTaskId,
    owner: ChannelConnectionOwner,
  ) {
    return yield* Effect.gen(function* () {
      const [task] = yield* sql<{ readonly status_version: number }>`
        SELECT status_version FROM channel_tasks WHERE task_id = ${taskId} AND owner_id = ${owner.ownerId}
      `;
      const view = yield* read(taskId, owner.ownerId);
      return visibleTaskView(
        view,
        task?.status_version ?? -1,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
    }).pipe(Effect.mapError(persistenceFailed));
  });
  const update = Effect.fn("ChannelTaskViews.update")(function* (
    input: ChannelUpdateTaskViewInput,
    owner: ChannelConnectionOwner,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const tasks = yield* sql<{
            readonly owner_id: string;
            readonly status_version: number;
          }>`SELECT owner_id, status_version FROM channel_tasks WHERE task_id = ${input.taskId}`;
          if (tasks[0]?.owner_id !== owner.ownerId)
            return yield* new ChannelGatewayError({ reason: "task_not_found" });
          const view = yield* read(input.taskId, owner.ownerId);
          const next: StoredView = {
            ...view,
            pinnedAt:
              input.pinned === undefined
                ? view.pinnedAt
                : input.pinned
                  ? (view.pinnedAt ?? now)
                  : null,
            doneAt:
              input.done === undefined ? view.doneAt : input.done ? (view.doneAt ?? now) : null,
            readThrough:
              input.readThrough === undefined ||
              (view.readThrough !== null &&
                Date.parse(view.readThrough) >= Date.parse(input.readThrough))
                ? view.readThrough
                : input.readThrough,
          };
          yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${taskViewKey(owner.ownerId, input.taskId)}, ${encode(next)}, ${now}) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
          return visibleTaskView(next, tasks[0].status_version, Date.parse(now));
        }),
      )
      .pipe(Effect.mapError((error) => (isGatewayError(error) ? error : persistenceFailed())));
  });
  const snooze = Effect.fn("ChannelTaskViews.snooze")(function* (
    input: ChannelSnoozeBotTaskInput | ChannelUnsnoozeBotTaskInput,
    owner: ChannelConnectionOwner,
  ) {
    const clock = yield* DateTime.now;
    const now = DateTime.formatIso(clock);
    const nowMs = DateTime.toEpochMillis(clock);
    const untilMs = "until" in input || "preset" in input ? snoozeDeadline(input, clock) : null;
    // Match the longest client preset, including a daylight saving change.
    if (
      untilMs !== null &&
      (!Number.isFinite(untilMs) || untilMs <= nowMs || untilMs > nowMs + 8 * 86_400_000)
    )
      return yield* new ChannelGatewayError({ reason: "invalid_input" });
    const until = untilMs === null ? undefined : DateTime.formatIso(DateTime.makeUnsafe(untilMs));
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [task] = yield* sql<{ readonly status_version: number }>`
        SELECT t.status_version FROM channel_tasks t
        JOIN channel_conversations c ON c.conversation_id = t.conversation_id
        WHERE t.task_id = ${input.taskId} AND t.bot_id = ${input.botId}
          AND t.owner_id = ${owner.ownerId} AND c.owner_id = ${owner.ownerId} AND c.kind = 'goat'
      `;
          if (task === undefined)
            return yield* new ChannelGatewayError({ reason: "task_not_found" });
          const view = yield* read(input.taskId, owner.ownerId);
          const visible = visibleTaskView(view, task.status_version, nowMs);
          if (visible.snoozedUntil === until) return { view: visible, changed: false };
          const { snoozedUntil: _previous, ...rest } = visible;
          const stored =
            until === undefined
              ? rest
              : {
                  ...rest,
                  snoozedUntil: until,
                  snoozedStatusVersion: task.status_version,
                };
          yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${taskViewKey(owner.ownerId, input.taskId)}, ${encode(stored)}, ${now})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
          const id = "view:" + NodeCrypto.randomUUID();
          const entry: ChannelBotTaskActivityEntry =
            until === undefined
              ? { id, type: "unsnoozed", actor: "person", at: now }
              : { id, type: "snoozed", actor: "person", at: now, until };
          // View actions share the ledger's sequence while leaving the worker's task version alone.
          yield* sql`INSERT INTO channel_task_events (event_id, task_id, task_version, type, event_json, occurred_at)
            SELECT ${id}, ${input.taskId}, COALESCE(MIN(task_version), 0) - 1,
              ${"task.view." + entry.type}, ${encodeActivity(entry)}, ${now}
            FROM channel_task_events WHERE task_id = ${input.taskId} AND task_version < 0`;
          return { view: visibleTaskView(stored, task.status_version, nowMs), changed: true };
        }),
      )
      .pipe(Effect.mapError((error) => (isGatewayError(error) ? error : persistenceFailed())));
    if (result.changed) yield* ledger.announceTaskChanges([owner.ownerId]);
    return result.view;
  });
  return ChannelTaskViews.of({ get, update, snooze });
});
export const layer = Layer.effect(ChannelTaskViews, make);
