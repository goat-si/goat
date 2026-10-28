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
