import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TaskViews from "./channelTaskViews.ts";
import { makeHarness, owner, ownerId } from "./testkit/ChannelHarness.ts";

const taskId = ChannelTaskId.make("task:view-test");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
    VALUES ('view-conversation', ${ownerId}, 'goat', 'view', 'view', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at)
    VALUES (${taskId}, ${ownerId}, 'view-conversation', 'running', 1, 1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});

describe("channel task views", () => {
  it.effect(
    "merges pin and done, never moves the read cursor backwards, and refuses another owner",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seed;
        const views = yield* TaskViews.ChannelTaskViews;
        const first = yield* views.update(
          { taskId, pinned: true, readThrough: "2026-01-03T00:00:00.000Z" },
          owner,
        );
        const second = yield* views.update(
          { taskId, done: true, readThrough: "2026-01-02T00:00:00.000Z" },
          owner,
        );
        assert.isNotNull(first.pinnedAt);
        assert.strictEqual(second.pinnedAt, first.pinnedAt);
        assert.isNotNull(second.doneAt);
        assert.strictEqual(second.readThrough, first.readThrough);
        const denied = yield* Effect.flip(
          views.update({ taskId, pinned: false }, { ...owner, ownerId: "other" }),
        );
        assert.strictEqual(denied.reason, "task_not_found");
      }).pipe(Effect.provide(TaskViews.layer.pipe(Layer.provideMerge(harness.layer))));
    },
  );
  it.effect("corrupt view data fails with persistence_failed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seed;
      const views = yield* TaskViews.ChannelTaskViews;
      yield* views.update({ taskId, pinned: true }, owner);
      const sql = yield* SqlClient.SqlClient;
      const key = "task-view:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(taskId);
      yield* sql`UPDATE channel_runtime_state SET value_json = 'broken' WHERE key = ${key}`;
      const error = yield* Effect.flip(views.get(taskId, owner));
      assert.strictEqual(error.reason, "persistence_failed");
    }).pipe(Effect.provide(TaskViews.layer.pipe(Layer.provideMerge(harness.layer))));
  });
});
