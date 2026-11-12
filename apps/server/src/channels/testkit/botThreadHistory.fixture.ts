import { assert } from "@effect/vitest";
import {
  ChannelChildWorkId,
  ChannelTaskId,
  ThreadId,
  type BotThreadRow,
  type ChannelListBotThreadsResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "../ChannelBotThreads.ts";
import * as TaskViews from "../channelTaskViews.ts";
import * as ChildStore from "../channelChildWorkStore.ts";
import {
  botThreadId,
  environmentId,
  makeHarness,
  owner,
  ownerId,
  setupBot,
} from "./ChannelHarness.ts";
export const NOW = Date.parse("2026-10-12T00:00:00.000Z");
export const at = (minutesAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - minutesAgo * 60_000));
export const name = (index: number) => `task-${String(index).padStart(3, "0")}`;

export const insertTask = (
  id: string,
  options: {
    readonly status: string;
    readonly createdAt: string;
    readonly kind?: "turn";
    readonly botId?: string;
    readonly conversationId?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const terminal = ["completed", "failed", "cancelled"].includes(options.status);
    const data = JSON.stringify({
      taskId: id,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      conversationId: options.conversationId ?? "conv:bot",
      originBindingId: "binding:1",
      originInputId: "input:1",
      originAddress: { kind: "goat", environmentId, threadId: botThreadId },
      requester: {
        ownerId,
        principalId: "owner",
        displayName: "Owner",
        originKind: "goat",
        runtimeModeCeiling: "full-access",
        grantedScopes: [],
      },
      title: id,
      instruction: "",
      status: options.status,
      version: 1,
      generation: 1,
      openQuestions: [],
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
      ...(terminal ? { completedAt: options.createdAt } : {}),
    });
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at, bot_id) VALUES (${id}, ${ownerId}, ${options.conversationId ?? "conv:bot"}, ${options.status}, 1, 1, ${data}, ${options.createdAt}, ${options.createdAt}, ${options.botId ?? "main"})`;
  });

/** What the ledger writes on a transition: status, task_json and updated_at, never created_at. */
export const setStatus = (id: string, status: string, completed: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const when = at(0);
    yield* sql`UPDATE channel_tasks SET status = ${status}, updated_at = ${when},
      task_json = ${completed ? sql`json_set(task_json, '$.status', ${status}, '$.updatedAt', ${when}, '$.completedAt', ${when})` : sql`json_remove(json_set(task_json, '$.status', ${status}, '$.updatedAt', ${when}), '$.completedAt')`}
      WHERE task_id = ${id}`;
  });

export const launch = (
  taskId: string,
  childWorkId: string,
  surface: "thread_launch" | "ssh_thread_launch",
  createdMinutesAgo: number,
) =>
  Effect.gen(function* () {
    const children = yield* ChildStore.ChannelChildWorkStore;
    return yield* children.admitReserved(
      {
        ownerId,
        taskId: ChannelTaskId.make(taskId),
        generation: 1,
        callerThreadId: botThreadId,
        requestKey: childWorkId,
        promptDigest: "digest",
        state: "completed" as const,
        createdAt: at(createdMinutesAgo),
        updatedAt: at(createdMinutesAgo),
        childWorkId: ChannelChildWorkId.make(childWorkId),
        surface,
        destination:
          surface === "thread_launch"
            ? { threadId: ThreadId.make(`thread:${childWorkId}`) }
            : { threadId: ThreadId.make(`remote:${childWorkId}`), host: "box" },
      },
      100,
    );
  });

/** A child record as the store keeps it, in any state and with or without a destination. */
export const childRecord = (
  taskId: string,
  childWorkId: string,
  record: { readonly surface: string; readonly state: string; readonly destination?: object },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const value = JSON.stringify({
      childWorkId,
      ownerId,
      taskId,
      generation: 1,
      callerThreadId: botThreadId,
      requestKey: childWorkId,
      promptDigest: "digest",
      createdAt: at(1),
      updatedAt: at(1),
      ...record,
    });
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
      VALUES (${"child-work:" + taskId + ":" + childWorkId}, ${value}, ${at(1)})
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`;
  });

export const setup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  yield* setupBot;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${at(0)})`;
});

export const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      BotThreads.layer.pipe(
        Layer.provideMerge(TaskViews.layer),
        Layer.provideMerge(makeHarness().layer),
      ),
    ),
  );

export const history = (cursor?: string) =>
  Effect.gen(function* () {
    const service = yield* BotThreads.ChannelBotThreads;
    return yield* service.list(owner, undefined, cursor === undefined ? {} : { cursor });
  });

export type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
export const taskIds = (pages: ReadonlyArray<ChannelListBotThreadsResult>) =>
  pages.flatMap((page) =>
    page.rows.flatMap((row) => (row.kind === "task" ? [String(row.task.taskId)] : [])),
  );

/** Walks every page; between pages it runs the given change once, before the page it names. */
export const walk = (changes: ReadonlyMap<number, Effect.Effect<void>> = new Map()) =>
  Effect.gen(function* () {
    const pages: ChannelListBotThreadsResult[] = [yield* history()];
    let cursor = pages[0]?.history?.nextCursor;
    while (cursor !== undefined) {
      assert.isBelow(pages.length, 100, "the walk ends");
      const change = changes.get(pages.length);
      if (change !== undefined) yield* change;
      const page: ChannelListBotThreadsResult = yield* history(cursor);
      pages.push(page);
      cursor = page.history?.nextCursor;
    }
    return pages;
  });

export const newestFirst = (count: number) =>
  Array.from({ length: count }, (_, index) => name(index));
