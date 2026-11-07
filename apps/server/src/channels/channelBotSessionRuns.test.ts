import { assert, it } from "@effect/vitest";
import {
  ChannelTaskId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { sessionTaskRuns } from "./channelBotSessionRuns.ts";

const thread = ThreadId.make("goat-bot-session:runs");
const taskA = { taskId: ChannelTaskId.make("task:a"), generation: 0 };
const taskB = { taskId: ChannelTaskId.make("task:b"), generation: 0 };

const run = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(id),
    ordinal,
    userMessageId: MessageId.make("message:" + id),
    status,
    restartContinuationOfRunId: null,
  }) as unknown as OrchestrationV2Run;

it.effect("a child's completion wake run belongs to the task whose run started the child", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [message, task] of [
      ["message:a", taskA],
      ["message:b", taskB],
    ] as const) {
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${thread}, ${message}, ${task.taskId}, 0, 'task', '2026-10-29T00:00:00.000Z')`;
    }
    // A finished waiting on its child, B took the session, and A's wake waits as its own run.
    const records = {
      runs: [
        run("a", 1, "completed"),
        run("b", 2, "running"),
        run("wake", 3, "queued"),
        run("stray", 4, "queued"),
      ],
      messages: [
        { id: "message:wake", delegatedCompletion: { parentRunId: RunId.make("a") } },
        { id: "message:stray", delegatedCompletion: { parentRunId: RunId.make("unknown") } },
      ],
    };
    const ids = (runs: ReadonlyArray<OrchestrationV2Run>) => runs.map((owned) => owned.id);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskA)), ["a", "wake"]);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskB)), ["b"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

/** The id LaunchWatch gives the wake it sends a launcher when a thread it launched ends a run. */
const wakeId = (launcher: string, host: string, launched: string) =>
  "message:launch-watch:" +
  [launcher, host, launched].map(encodeURIComponent).join(":") +
  ":run:run:" +
  launched +
  ":1";

it.effect("a launched thread's end wake belongs to the task whose run launched that thread", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [message, task] of [
      ["message:a", taskA],
      ["message:b", taskB],
    ] as const) {
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${thread}, ${message}, ${task.taskId}, 0, 'task', '2026-10-29T00:00:00.000Z')`;
    }
    const launched = (child: string, surface: string, callerRunId: string, destination = child) =>
      sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
        ${"child-work:" + taskA.taskId + ":" + child},
        ${JSON.stringify({
          ownerId: "owner",
          taskId: taskA.taskId,
          childWorkId: child,
          generation: 0,
          callerThreadId: thread,
          callerRunId,
          requestKey: child,
          promptDigest: "digest",
          surface,
          destination: { threadId: "thread:" + destination },
          state: "completed",
          createdAt: "2026-10-29T00:00:00.000Z",
          updatedAt: "2026-10-29T00:00:00.000Z",
        })},
        '2026-10-29T00:00:00.000Z')`;
    yield* launched("probe", "thread_launch", "a");
    yield* launched("helper", "delegate_local", "a");
    // Two launches recorded for one thread: the wake cannot say which run it continues.
    yield* launched("twin-1", "thread_launch", "a", "twin");
    yield* launched("twin-2", "thread_launch", "b", "twin");
    const wakeRun = (id: string, ordinal: number, messageId: string) =>
      ({
        ...run(id, ordinal, "running"),
        userMessageId: MessageId.make(messageId),
      }) as OrchestrationV2Run;
    const records = {
      runs: [
        run("a", 1, "completed"),
        run("b", 2, "completed"),
        wakeRun("wake", 3, wakeId(thread, "", "thread:probe")),
        wakeRun("other-launcher", 4, wakeId("goat-bot-session:other", "", "thread:probe")),
        wakeRun("remote", 5, wakeId(thread, "mini", "thread:probe")),
        wakeRun("unrecorded", 6, wakeId(thread, "", "thread:elsewhere")),
        wakeRun("subagent", 7, wakeId(thread, "", "thread:helper")),
        wakeRun("ambiguous", 8, wakeId(thread, "", "thread:twin")),
        wakeRun(
          "question",
          9,
          "message:launch-watch:" +
            [thread, "", "thread:probe"].map(encodeURIComponent).join(":") +
            ":question:run:thread:probe:1:q1",
        ),
      ],
      messages: [],
    };
    const ids = (runs: ReadonlyArray<OrchestrationV2Run>) => runs.map((owned) => owned.id);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskA)), [
      "a",
      "wake",
      "question",
    ]);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskB)), ["b"]);
    assert.deepStrictEqual(
      ids(yield* sessionTaskRuns(sql, thread, records, { ...taskA, generation: 1 })),
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("a background command's notification run belongs to the task whose run started it", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [message, task] of [
      ["message:a", taskA],
      ["message:b", taskB],
    ] as const) {
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${thread}, ${message}, ${task.taskId}, 0, 'task', '2026-10-29T00:00:00.000Z')`;
    }
    // A started a command and finished; B ran and failed; the command's end woke the session.
    const records = {
      runs: [run("a", 1, "completed"), run("b", 2, "failed"), run("notice", 3, "completed")],
      messages: [{ id: "message:notice", notification: { aboutRunId: RunId.make("a") } }],
    };
    const ids = (runs: ReadonlyArray<OrchestrationV2Run>) => runs.map((owned) => owned.id);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskA)), [
      "a",
      "notice",
    ]);
    assert.deepStrictEqual(ids(yield* sessionTaskRuns(sql, thread, records, taskB)), ["b"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
