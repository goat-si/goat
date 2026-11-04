import { assert, describe, it } from "@effect/vitest";
import { ChannelChildWorkId, ChannelTaskId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as TaskViews from "./channelTaskViews.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import {
  botThreadId,
  environmentId,
  makeHarness,
  owner,
  ownerId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const time = "2026-10-12T00:00:00.000Z";
const old = "2026-10-01T00:00:00.000Z";
const insertTask = (id: string, taskOwner: string, status: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const data = JSON.stringify({
      taskId: id,
      conversationId: "conv:bot",
      originBindingId: "binding:1",
      originInputId: "input:1",
      originAddress: { kind: "goat", environmentId, threadId: botThreadId },
      requester: {
        ownerId: taskOwner,
        principalId: "owner",
        displayName: "Owner",
        originKind: "goat",
        runtimeModeCeiling: "full-access",
        grantedScopes: [],
      },
      title: id,
      instruction: "",
      status,
      version: 1,
      generation: 1,
      openQuestions: [],
      createdAt: updatedAt,
      updatedAt,
      ...(status === "completed" ? { completedAt: updatedAt } : {}),
    });
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at) VALUES (${id}, ${taskOwner}, 'conv:bot', ${status}, 1, 1, ${data}, ${updatedAt}, ${updatedAt})`;
  });

describe("ChannelBotThreads", () => {
  it.effect(
    "scopes tasks, retains pinned old work, and deduplicates resolvable coding rows",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(1791763200000);
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        yield* insertTask("task:active", ownerId, "running", time);
        yield* insertTask("task:turn", ownerId, "running", time);
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.kind', 'turn') WHERE task_id = 'task:turn'`;
        yield* insertTask("task:old", ownerId, "completed", old);
        yield* insertTask("task:pinned", ownerId, "completed", old);
        yield* insertTask("task:foreign", "foreign", "running", time);
        for (let index = 0; index < 101; index++) {
          yield* insertTask(
            `task:stale-${index}`,
            ownerId,
            "completed",
            "2026-10-02T00:00:00.000Z",
          );
        }
        const views = yield* TaskViews.ChannelTaskViews;
        yield* views.update({ taskId: ChannelTaskId.make("task:pinned"), pinned: true }, owner);
        yield* sql`INSERT INTO channel_bindings (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at) VALUES ('binding:1', 'conv:bot', 'goat', '{}', ${time})`;
        for (const [id, message] of [
          ["main", { intent: "message", actor: {} }],
          ["task", { intent: "message", taskId: "task:active", actor: {} }],
          ["agent", { intent: "message", actor: { senderThreadId: "thread:worker" } }],
          ["report", { intent: "report", actor: {} }],
        ] as const) {
          const encoded = JSON.stringify(message);
          yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id, idempotency_key, content_hash, conversation_id, binding_id, message_json, state, accepted_at) VALUES (${id}, ${ownerId}, 'goat', 'goat', ${id}, 'hash', 'conv:bot', 'binding:1', ${encoded}, 'accepted', '2026-10-12T01:00:00.000Z')`;
        }
        const children = yield* ChildStore.ChannelChildWorkStore;
        const base = {
          ownerId,
          taskId: ChannelTaskId.make("task:active"),
          generation: 1,
          callerThreadId: botThreadId,
          requestKey: "key",
          promptDigest: "digest",
          state: "bound" as const,
          createdAt: time,
          updatedAt: time,
        };
        for (const [id, surface, destination] of [
          ["one", "thread_launch", { threadId: ThreadId.make("thread:child") }],
          ["two", "thread_launch", { threadId: ThreadId.make("thread:child") }],
          [
            "remote",
            "ssh_thread_launch",
            { threadId: ThreadId.make("thread:remote"), host: "remote" },
          ],
          ["missing", "thread_launch", {}],
        ] as const) {
          yield* children.admitReserved(
            { ...base, childWorkId: ChannelChildWorkId.make(id), surface, destination },
            100,
          );
        }
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.list(owner);
        assert.deepStrictEqual(
          result.rows
            .filter((row) => row.kind === "task")
            .map((row) => row.task.taskId)
            .sort(),
          ["task:active", "task:pinned"],
        );
        assert.strictEqual(result.mainMessageCount, 1);
        const active = result.rows.find(
          (row) => row.kind === "task" && row.task.taskId === "task:active",
        );
        assert.strictEqual(active?.kind === "task" && active.mainMessagesSinceQuiet, 1);
        assert.strictEqual(active?.kind === "task" && active.unread, true);
        const coding = result.rows.filter((row) => row.kind === "coding");
        assert.lengthOf(coding, 1);
        assert.strictEqual(coding[0]?.threadId, "thread:child");
        assert.strictEqual(coding[0]?.environmentId, environmentId);
        const key =
          "task-view:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent("task:pinned");
        yield* sql`UPDATE channel_runtime_state SET value_json = 'broken' WHERE key = ${key}`;
        assert.strictEqual((yield* Effect.flip(service.list(owner))).reason, "persistence_failed");
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );
  it.effect("limits the task list to 100", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
      for (let index = 0; index < 102; index++) {
        yield* insertTask(`task:active-${index}`, ownerId, "running", time);
      }
      const service = yield* BotThreads.ChannelBotThreads;
      const result = yield* service.list(owner);
      assert.lengthOf(result.rows, 100);
    }).pipe(
      Effect.provide(
        BotThreads.layer.pipe(
          Layer.provideMerge(TaskViews.layer),
          Layer.provideMerge(harness.layer),
        ),
      ),
    );
  });
});
