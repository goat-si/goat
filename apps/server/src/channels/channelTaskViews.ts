import {
  ChannelGatewayError,
  ChannelTaskView,
  type ChannelTaskId,
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
  return ChannelTaskViews.of({ get, update });
});
export const layer = Layer.effect(ChannelTaskViews, make);
