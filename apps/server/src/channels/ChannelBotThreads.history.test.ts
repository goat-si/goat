import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  CHANNEL_BOT_THREADS_HISTORY_LIMIT,
  ChannelChildWorkId,
  ChannelInputId,
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
import * as BotThreads from "./ChannelBotThreads.ts";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyStatement,
  launchesStatement,
} from "./channelBotThreadHistory.ts";
import { taskIdFor } from "./channelIds.ts";
import * as TaskViews from "./channelTaskViews.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  botThreadId,
  environmentId,
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const at = (minutesAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - minutesAgo * 60_000));
const name = (index: number) => `task-${String(index).padStart(3, "0")}`;

const insertTask = (
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
const setStatus = (id: string, status: string, completed: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const when = at(0);
    yield* sql`UPDATE channel_tasks SET status = ${status}, updated_at = ${when},
      task_json = ${completed ? sql`json_set(task_json, '$.status', ${status}, '$.updatedAt', ${when}, '$.completedAt', ${when})` : sql`json_remove(json_set(task_json, '$.status', ${status}, '$.updatedAt', ${when}), '$.completedAt')`}
      WHERE task_id = ${id}`;
  });

const launch = (
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
const childRecord = (
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

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  yield* setupBot;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${at(0)})`;
});

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      BotThreads.layer.pipe(
        Layer.provideMerge(TaskViews.layer),
        Layer.provideMerge(makeHarness().layer),
      ),
    ),
  );

const history = (cursor?: string) =>
  Effect.gen(function* () {
    const service = yield* BotThreads.ChannelBotThreads;
    return yield* service.list(owner, undefined, cursor === undefined ? {} : { cursor });
  });

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
const taskIds = (pages: ReadonlyArray<ChannelListBotThreadsResult>) =>
  pages.flatMap((page) =>
    page.rows.flatMap((row) => (row.kind === "task" ? [String(row.task.taskId)] : [])),
  );

/** Walks every page; between pages it runs the given change once, before the page it names. */
const walk = (changes: ReadonlyMap<number, Effect.Effect<void>> = new Map()) =>
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

const newestFirst = (count: number) => Array.from({ length: count }, (_, index) => name(index));

describe("ChannelBotThreads history", () => {
  it.effect("walks every task once, in creation order, while tasks change between pages", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const views = yield* TaskViews.ChannelTaskViews;
        for (let index = 0; index < 160; index++)
          yield* insertTask(name(index), {
            status: index % 3 === 0 ? "running" : "completed",
            createdAt: at(index),
          });
        yield* views.update({ taskId: ChannelTaskId.make(name(120)), pinned: true }, owner);
        const id = (index: number) => ChannelTaskId.make(name(index));
        const sql = yield* SqlClient.SqlClient;
        const pages = yield* walk(
          new Map([
            [
              1,
              Effect.gen(function* () {
                yield* setStatus(name(60), "completed", true);
                yield* views.update({ taskId: id(70), pinned: true }, owner);
                yield* views.update({ taskId: id(120), pinned: false }, owner);
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
            ],
            [
              2,
              Effect.gen(function* () {
                yield* views.update({ taskId: id(110), readThrough: at(0) }, owner);
                yield* views.update({ taskId: id(111), done: true }, owner);
                yield* setStatus(name(130), "running", false);
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
            ],
          ]),
        );
        assert.deepStrictEqual(taskIds(pages), newestFirst(160));
        for (const page of pages)
          assert.isAtMost(page.rows.length, CHANNEL_BOT_THREADS_HISTORY_LIMIT);
        const row = (index: number) =>
          pages
            .flatMap((page) => page.rows)
            .find(
              (item): item is TaskRow => item.kind === "task" && item.task.taskId === name(index),
            );
        assert.isNotNull(row(70)?.view.pinnedAt, "a change before its page shows on its row");
        assert.isFalse(row(110)?.unread);
        assert.isNotNull(row(111)?.view.doneAt);
        assert.strictEqual(row(130)?.task.status, "running");
      }),
    ),
  );

  it.effect("reaches more than 100 pinned and more than 100 running tasks", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const views = yield* TaskViews.ChannelTaskViews;
        for (let index = 0; index < 220; index++) {
          yield* insertTask(name(index), {
            status: index < 110 ? "running" : "completed",
            createdAt: at(index),
          });
          if (index >= 110)
            yield* views.update({ taskId: ChannelTaskId.make(name(index)), pinned: true }, owner);
        }
        assert.deepStrictEqual(taskIds(yield* walk()), newestFirst(220));
      }),
    ),
  );

  it.effect("breaks ties in creation time by task id across a page boundary", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 60; index++)
          yield* insertTask(name(index), {
            status: "completed",
            createdAt: at(index < 47 ? index : 47),
          });
        const pages = yield* walk();
        assert.lengthOf(pages, 2);
        assert.deepStrictEqual(taskIds(pages), [
          ...newestFirst(47),
          ...Array.from({ length: 13 }, (_, index) => name(59 - index)),
        ]);
      }),
    ),
  );

  it.effect("shows the same view and unread on a history row as on the current list", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const views = yield* TaskViews.ChannelTaskViews;
        yield* insertTask("plain", { status: "running", createdAt: at(1) });
        yield* insertTask("read", { status: "running", createdAt: at(2) });
        yield* insertTask("odd", { status: "running", createdAt: at(3) });
        yield* views.update(
          { taskId: ChannelTaskId.make("read"), readThrough: at(0), pinned: true },
          owner,
        );
        // A read time that does not parse: the row rule compares nothing, so it reads as read.
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
          ${TaskViews.taskViewKey(ownerId, ChannelTaskId.make("odd"))},
          ${JSON.stringify({ taskId: "odd", pinnedAt: null, doneAt: null, readThrough: "not-a-time" })}, ${at(0)})`;
        const service = yield* BotThreads.ChannelBotThreads;
        const current = yield* service.list(owner);
        const page = yield* history();
        assert.notProperty(current, "history");
        assert.deepStrictEqual(page.rows, current.rows);
        assert.isFalse(
          page.rows.some((row) => row.kind === "task" && row.task.taskId === "odd" && row.unread),
        );
      }),
    ),
  );

  it.effect("lists 20 launches of a task and says when it has more", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("busy", { status: "running", createdAt: at(1) });
        yield* insertTask("calm", { status: "running", createdAt: at(2) });
        for (let index = 0; index < 21; index++)
          yield* launch("busy", `busy-${index}`, "thread_launch", 100 - index);
        for (let index = 0; index < 20; index++)
          yield* launch("calm", `calm-${index}`, "thread_launch", 100 - index);
        const page = yield* history();
        const coding = (taskId: string) =>
          page.rows
            .filter((row) => row.kind === "coding" && row.taskId === taskId)
            .map((row) => (row.kind === "coding" ? String(row.threadId) : ""));
        assert.lengthOf(coding("busy"), 20);
        assert.notInclude(coding("busy"), "thread:busy-0", "the oldest launch is the one left out");
        assert.lengthOf(coding("calm"), 20);
        assert.deepStrictEqual(page.history?.launchesTruncated, [ChannelTaskId.make("busy")]);
      }),
    ),
  );

  it.effect("lists a bot turn only by the threads it launched", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 55; index++) {
          yield* insertTask(`turn-${index}`, {
            status: "running",
            createdAt: at(index),
            kind: "turn",
          });
          yield* launch(
            `turn-${index}`,
            `launch-${index}`,
            index % 2 === 0 ? "thread_launch" : "ssh_thread_launch",
            index,
          );
          yield* setStatus(`turn-${index}`, "completed", true);
        }
        yield* insertTask("turn-quiet", { status: "completed", createdAt: at(1), kind: "turn" });
        const pages = yield* walk();
        assert.lengthOf(pages, 2, "a page counts the turns that launched work, so none is empty");
        assert.deepStrictEqual(taskIds(pages), []);
        const listed = pages.flatMap((page) => [
          ...page.rows.flatMap((row) => (row.kind === "coding" ? [String(row.taskId)] : [])),
          ...(page.remoteWork ?? []).map((item) => String(item.taskId)),
        ]);
        assert.deepStrictEqual(
          listed.toSorted(),
          Array.from({ length: 55 }, (_, index) => `turn-${index}`).toSorted(),
        );
      }),
    ),
  );

  it.effect(
    "answers the current list without a history key, and a missing bot with an empty page",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          const service = yield* BotThreads.ChannelBotThreads;
          assert.notProperty(yield* service.list(owner), "history");
          assert.notProperty(yield* service.list(owner, BotId.make("main")), "history");
          assert.deepStrictEqual(yield* service.list(owner, BotId.make("nobody"), {}), {
            rows: [],
            mainMessageCount: 0,
            history: {},
          });
        }),
      ),
  );

  it.effect("refuses a cursor that is not this server's for this owner and bot", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 60; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        const cursor = (yield* history()).history?.nextCursor ?? "";
        assert.isAtMost(cursor.length, 512);
        const [, body = ""] = cursor.split(".");
        const json = Buffer.from(body, "base64url").toString("utf8");
        const reencoded = (value: unknown) =>
          "v1." + Buffer.from(JSON.stringify(value)).toString("base64url");
        const parts = JSON.parse(json) as unknown[];
        for (const bad of [
          "no-version",
          "v2." + body,
          "v1.@@@",
          reencoded(parts.slice(0, 3)),
          reencoded([parts[0], parts[1], "", parts[3]]),
          "v1." + Buffer.from(json.replace(",", ", ")).toString("base64url"),
          encodeHistoryCursor(
            { ownerId: "someone-else", botId: "main" },
            { createdAt: at(0), taskId: name(0) },
          ),
          encodeHistoryCursor(
            { ownerId, botId: "another-bot" },
            { createdAt: at(0), taskId: name(0) },
          ),
        ]) {
          const error = yield* Effect.flip(history(bad));
          assert.strictEqual(error.reason, "invalid_input", bad);
        }
        const long = { ownerId, botId: "b".repeat(200) };
        const longCursor = encodeHistoryCursor(long, { createdAt: at(0), taskId: "t".repeat(200) });
        assert.isAtMost(longCursor.length, 512);
        assert.deepStrictEqual(yield* decodeHistoryCursor(long, longCursor), {
          createdAt: at(0),
          taskId: "t".repeat(200),
        });
      }),
    ),
  );

  it.effect("reads a page from its index in order, without sorting", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 3000; index++)
          yield* insertTask(name(index), {
            status: index % 4 === 0 ? "running" : "completed",
            createdAt: at(index),
            ...(index % 3 === 0 ? { kind: "turn" as const } : {}),
            ...(index % 5 === 0 ? { botId: "other" } : {}),
          });
        const sql = yield* SqlClient.SqlClient;
        for (const after of [undefined, { createdAt: at(1500), taskId: name(1500) }]) {
          const statement = historyStatement(sql, { ownerId, botId: "main", after, limit: 51 });
          const plan = (yield* sql<{
            readonly detail: string;
          }>`EXPLAIN QUERY PLAN ${statement}`).map((row) => row.detail);
          const text = plan.join("\n");
          assert.match(
            text,
            /SEARCH t USING INDEX channel_tasks_owner_bot_created \(owner_id=\? AND bot_id=\?/,
            text,
          );
          assert.notInclude(text, "TEMP B-TREE", text);
          if (after !== undefined) assert.include(text, "created_at<?", text);
        }
      }),
    ),
  );
  it.effect("counts a turn only once one of its launches has a thread to open", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (const id of ["reserved", "released", "remote-released", "bound"])
          yield* insertTask(id, { status: "completed", createdAt: at(1), kind: "turn" });
        yield* childRecord("reserved", "a", { surface: "thread_launch", state: "reserved" });
        yield* childRecord("released", "b", { surface: "ssh_thread_launch", state: "reserved" });
        yield* childRecord("released", "b", {
          surface: "ssh_thread_launch",
          state: "released",
          destination: { host: "box" },
        });
        // A launch that got its remote thread stays listed after it is released.
        yield* childRecord("remote-released", "c", {
          surface: "ssh_thread_launch",
          state: "released",
          destination: { host: "box", threadId: "remote:c" },
        });
        yield* childRecord("bound", "d", {
          surface: "thread_launch",
          state: "bound",
          destination: { threadId: "thread:d" },
        });
        const page = yield* history();
        assert.deepStrictEqual(
          page.rows.map((row) => (row.kind === "coding" ? String(row.taskId) : row.kind)),
          ["bound"],
        );
        assert.deepStrictEqual(
          (page.remoteWork ?? []).map((item) => String(item.taskId)),
          ["remote-released"],
        );
        assert.isUndefined(page.history?.nextCursor);
        const sql = yield* SqlClient.SqlClient;
        const listed = yield* historyStatement(sql, {
          ownerId,
          botId: "main",
          after: undefined,
          limit: 51,
        });
        assert.deepStrictEqual(listed.map((row) => row.task_id).toSorted(), [
          "bound",
          "remote-released",
        ]);
      }),
    ),
  );

  it.effect("seeks a task's newest launches from their index, without sorting", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("busy", { status: "running", createdAt: at(1) });
        for (let index = 0; index < 5000; index++)
          yield* childRecord("busy", `launch-${String(index).padStart(4, "0")}`, {
            surface: index % 2 === 0 ? "thread_launch" : "delegate_local",
            state: "completed",
            destination: { threadId: `thread:${index}` },
          });
        const sql = yield* SqlClient.SqlClient;
        const plan = (yield* sql<{
          readonly detail: string;
        }>`EXPLAIN QUERY PLAN ${launchesStatement(sql, { ownerId, taskId: "busy", limit: 21 })}`).map(
          (row) => row.detail,
        );
        const text = plan.join("\n");
        assert.include(text, "USING INDEX channel_child_work_launches", text);
        assert.notInclude(text, "TEMP B-TREE", text);
      }),
    ),
  );

  it.effect("ends the walk with a flag instead of a cursor it would refuse", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const long = "🐐".repeat(100);
        for (let index = 0; index < 50; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        yield* insertTask(long, { status: "completed", createdAt: at(49) });
        yield* insertTask("after", { status: "completed", createdAt: at(60) });
        const page = yield* history();
        assert.strictEqual(taskIds([page]).at(-1), long);
        assert.isUndefined(page.history?.nextCursor);
        assert.isTrue(page.history?.endedEarly);
        // Ids GOAT generates always fit: a stable digest of the input, whatever its length.
        const generated = taskIdFor(ChannelInputId.make("x".repeat(5000)), 999);
        const cursor = encodeHistoryCursor(
          { ownerId: "o".repeat(500), botId: "b".repeat(500) },
          { createdAt: at(0), taskId: generated },
        );
        assert.isAtMost(cursor.length, 512);
      }),
    ),
  );

  it.effect("keeps a task retried through the retry service in its place between pages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW - 60 * 60_000);
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: tidy the docs", "history-retry"), rpcContext);
      yield* runtime.drain;
      const started = yield* onlyTask;
      harness.world.setStatus(started.worker!.threadId, 1, "failed");
      yield* runtime.drain;
      const failed = yield* onlyTask;
      assert.strictEqual(failed.status, "failed");
      yield* TestClock.setTime(NOW);
      for (let index = 0; index < 60; index++)
        yield* insertTask(name(index), {
          status: "completed",
          createdAt: at(index),
          conversationId: failed.conversationId,
        });
      const service = yield* BotThreads.ChannelBotThreads;
      const first = yield* history();
      const retried = yield* service.retry(
        { taskId: failed.taskId, clientRequestId: "history-retry" },
        owner,
      );
      assert.notStrictEqual(retried.status, "refused");
      const second = yield* history(first.history?.nextCursor);
      assert.deepStrictEqual(taskIds([first, second]), [...newestFirst(60), failed.taskId]);
      const row = second.rows.find(
        (item): item is TaskRow => item.kind === "task" && item.task.taskId === failed.taskId,
      );
      assert.notStrictEqual(row?.task.status, "failed", "the row shows the new attempt");
      assert.isUndefined(second.history?.nextCursor);
    }).pipe(Effect.provide(harness.layer));
  });
});
