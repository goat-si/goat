import {
  ChannelGatewayError,
  ChannelTaskView,
  type ChannelTaskId,
  type ChannelDeliveryId,
  type ChannelUpdateTaskViewInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

const isGatewayError = Schema.is(ChannelGatewayError);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskView));
const encode = Schema.encodeSync(Schema.fromJsonString(ChannelTaskView));
export const taskViewKey = (ownerId: string, taskId: ChannelTaskId) =>
  "task-view:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(taskId);
export const messageMarkKey = (ownerId: string, taskId: ChannelTaskId) =>
  "task-message-mark:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(taskId);
const markSchema = Schema.Struct({ at: Schema.String, recent: Schema.Array(Schema.String) });
const MARK_RECENT_LIMIT = 256;
const decodeMark = Schema.decodeUnknownSync(Schema.fromJsonString(markSchema));
const encodeMark = Schema.encodeSync(Schema.fromJsonString(markSchema));
export const readMessageMark = (json: string) => {
  try {
    const mark = decodeMark(json);
    return Number.isFinite(Date.parse(mark.at)) ? mark : undefined;
  } catch {
    return undefined;
  }
};
const persistenceFailed = () => new ChannelGatewayError({ reason: "persistence_failed" });

export class ChannelTaskViews extends Context.Service<
  ChannelTaskViews,
  {
    readonly get: (
      taskId: ChannelTaskId,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly update: (
      input: ChannelUpdateTaskViewInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly raiseMessageMark: (
      taskId: ChannelTaskId,
      ownerId: string,
      deliveryId: ChannelDeliveryId,
    ) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("goat/channels/channelTaskViews") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
        : decode(rows[0].value_json),
    );
    if (view.taskId !== taskId) return yield* persistenceFailed();
    return view;
  });
  const get = Effect.fn("ChannelTaskViews.get")(function* (
    taskId: ChannelTaskId,
    owner: ChannelConnectionOwner,
  ) {
    return yield* read(taskId, owner.ownerId).pipe(Effect.mapError(persistenceFailed));
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
          }>`SELECT owner_id FROM channel_tasks WHERE task_id = ${input.taskId}`;
          if (tasks[0]?.owner_id !== owner.ownerId)
            return yield* new ChannelGatewayError({ reason: "task_not_found" });
          const view = yield* read(input.taskId, owner.ownerId);
          const next: ChannelTaskView = {
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
          return next;
        }),
      )
      .pipe(Effect.mapError((error) => (isGatewayError(error) ? error : persistenceFailed())));
  });
  const raiseMessageMark = Effect.fn("ChannelTaskViews.raiseMessageMark")(function* (
    taskId: ChannelTaskId,
    ownerId: string,
    deliveryId: ChannelDeliveryId,
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // An unreadable view must not hold back the message; it counts as never read.
          const view = yield* read(taskId, ownerId).pipe(
            Effect.orElseSucceed(() => ({ readThrough: null })),
          );
          const key = messageMarkKey(ownerId, taskId);
          const rows = yield* sql<{
            readonly value_json: string;
          }>`SELECT value_json FROM channel_runtime_state WHERE key = ${key}`;
          const mark = rows[0] === undefined ? undefined : readMessageMark(rows[0].value_json);
          if (mark?.recent.includes(deliveryId)) return;
          // A raised delivery stays known while its outbox row can still be retried.
          const recent = mark?.recent ?? [];
          const finished =
            recent.length === 0
              ? []
              : yield* sql<{ readonly delivery_id: string }>`SELECT delivery_id FROM channel_outbox
                  WHERE delivery_id IN ${sql.in(recent)} AND state NOT IN ('pending', 'delivering')`;
          const done = new Set(finished.map((item) => item.delivery_id));
          // Read here, under the mark's own write, so no task write can slip between it and the mark.
          const task = yield* sql<{
            readonly updated_at: string;
          }>`SELECT updated_at FROM channel_tasks WHERE task_id = ${taskId}`;
          const now = DateTime.formatIso(yield* DateTime.now);
          const readAt = view.readThrough === null ? NaN : Date.parse(view.readThrough);
          const shown = task[0] === undefined ? NaN : Date.parse(task[0].updated_at);
          const next = DateTime.formatIso(
            DateTime.makeUnsafe(
              Math.max(
                Date.parse(now),
                mark === undefined ? 0 : Date.parse(mark.at) + 1,
                Number.isFinite(readAt) ? readAt + 1 : 0,
                Number.isFinite(shown) ? shown + 1 : 0,
              ),
            ),
          );
          const value = encodeMark({
            at: next,
            recent: [deliveryId, ...recent.filter((id) => !done.has(id))].slice(
              0,
              MARK_RECENT_LIMIT,
            ),
          });
          yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${key}, ${value}, ${now}) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
        }),
      )
      .pipe(Effect.mapError(persistenceFailed));
  });
  return ChannelTaskViews.of({ get, update, raiseMessageMark });
});
export const layer = Layer.effect(ChannelTaskViews, make);
