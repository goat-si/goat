import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  CHANNEL_BOT_THREADS_HISTORY_LIMIT,
  ChannelChildWorkId,
  ChannelInputId,
  WsChannelRpcGroup,
  ChannelTaskId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyStatement,
} from "./channelBotThreadHistory.ts";
import { taskIdFor } from "./channelIds.ts";
import * as TaskViews from "./channelTaskViews.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import {
  botThreadId,
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";
import {
  NOW,
  at,
  name,
  insertTask,
  setStatus,
  launch,
  childRecord,
  setup,
  provide,
  history,
  type TaskRow,
  taskIds,
  walk,
  newestFirst,
} from "./testkit/botThreadHistory.fixture.ts";

describe("ChannelBotThreads history", () => {
  it.effect("bounds lookup task and coding titles without changing the stored task", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("title-lookup", { status: "running", createdAt: at(1) });
        yield* launch("title-lookup", "long-child", "thread_launch", 1);
        const sql = yield* SqlClient.SqlClient;
        const title = "a".repeat(199) + " " + "b".repeat(4800);
        const codingTitle = "x".repeat(199) + "😀tail";
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.title', ${title}) WHERE task_id = 'title-lookup'`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread:long-child', 'project:repo', ${codingTitle}, 'codex', 'full-access', 'default', ${at(1)}, ${at(1)}, '{}')`;
        const service = yield* BotThreads.ChannelBotThreads;
        const input = { taskId: ChannelTaskId.make("title-lookup"), botId: BotId.make("main") };
        const known = yield* service.getBotTask(input, owner);
        assert.strictEqual(known.task.state, "known");
        if (known.task.state === "known") {
          assert.strictEqual(known.task.row.task.title, "a".repeat(199));
          assert.strictEqual(known.task.row.task.titleTruncated, true);
        }
        const rpc = WsChannelRpcGroup.requests.get("channel.getBotTask") as
          | Extract<
              RpcGroup.Rpcs<typeof WsChannelRpcGroup>,
              { readonly _tag: "channel.getBotTask" }
            >
          | undefined;
        if (rpc === undefined) throw new Error("missing lookup RPC");
        const codec = Schema.toCodecJson(rpc.successSchema);
        const encoded = yield* Schema.encodeEffect(codec)(known);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        assert.deepStrictEqual(decoded, known);
        assert.strictEqual(known.codingRows[0]?.title, "x".repeat(199) + "😀");
        assert.strictEqual(known.codingRows[0]?.titleTruncated, true);
        const ledger = yield* ChannelLedger.ChannelLedger;
        assert.strictEqual((yield* ledger.getTask(input.taskId))?.task.title, title);
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${TaskViews.taskViewKey(ownerId, input.taskId)}, '{', ${at(1)})`;
        const unavailable = yield* service.getBotTask(input, owner);
        assert.strictEqual(unavailable.task.state, "unavailable");
        if (unavailable.task.state === "unavailable") {
          assert.strictEqual(unavailable.task.task.title, "a".repeat(199));
          assert.strictEqual(unavailable.task.task.titleTruncated, true);
        }
      }),
    ),
  );
  it.effect("excludes non-GOAT conversations and turn tasks from search", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("needle-work", { status: "completed", createdAt: at(1) });
        yield* insertTask("needle-turn", { status: "completed", createdAt: at(2), kind: "turn" });
        const sql = yield* SqlClient.SqlClient;
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.deepStrictEqual(
          first.tasks.map((task) => String(task.taskId)),
          ["needle-work"],
        );
        yield* sql`UPDATE channel_conversations SET kind = 'slack' WHERE conversation_id = 'conv:bot'`;
        const lookup = yield* Effect.flip(
          service.getBotTask(
            { taskId: ChannelTaskId.make("needle-work"), botId: BotId.make("main") },
            owner,
          ),
        );
        assert.strictEqual(lookup.reason, "not_found");
        const second = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.deepStrictEqual(second.tasks, []);
      }),
    ),
  );

  it.effect("matches ASCII without case and keeps non-ASCII case distinct", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("Hello-Ä", { status: "completed", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const ascii = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "hELLo" },
          owner,
        );
        const nonAscii = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "ä" },
          owner,
        );
        assert.deepStrictEqual(
          ascii.tasks.map((task) => String(task.taskId)),
          ["Hello-Ä"],
        );
        assert.deepStrictEqual(nonAscii.tasks, []);
      }),
    ),
  );
  it.effect("returns persistence failure when a lookup database read fails", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("sql-failure", { status: "running", createdAt: at(1) });
        const sql = yield* SqlClient.SqlClient;
        const service = yield* BotThreads.ChannelBotThreads;
        yield* service.searchBotTasks({ botId: BotId.make("main"), query: "init" }, owner);
        yield* sql`ALTER TABLE channel_tasks RENAME TO channel_tasks_unavailable`;
        const byId = yield* Effect.flip(
          service.getBotTask(
            { taskId: ChannelTaskId.make("sql-failure"), botId: BotId.make("main") },
            owner,
          ),
        );
        const search = yield* Effect.flip(
          service.searchBotTasks({ botId: BotId.make("main"), query: "sql" }, owner),
        );
        assert.strictEqual(byId.reason, "persistence_failed");
        assert.strictEqual(search.reason, "persistence_failed");
      }),
    ),
  );

  it.effect("keeps creation order stable when an unvisited task is updated", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("match-a", { status: "running", createdAt: at(1) });
        yield* insertTask("match-b", { status: "running", createdAt: at(2) });
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "match", limit: 1 },
          owner,
        );
        yield* setStatus("match-b", "completed", true);
        const next = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "match", cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(
          [...first.tasks, ...next.tasks].map((task) => String(task.taskId)),
          ["match-a", "match-b"],
        );
      }),
    ),
  );
  it.effect("gives a missing task view the known default", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("default-view", { status: "running", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.getBotTask(
          { taskId: ChannelTaskId.make("default-view"), botId: BotId.make("main") },
          owner,
        );
        assert.strictEqual(result.task.state, "known");
        if (result.task.state === "known") {
          assert.isNull(result.task.row.view.pinnedAt);
          assert.isNull(result.task.row.view.doneAt);
          assert.isNull(result.task.row.view.readThrough);
        }
        assert.strictEqual(result.partial, false);
      }),
    ),
  );

  it.effect("keeps malformed lookahead out of the current search page", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const service = yield* BotThreads.ChannelBotThreads;
        yield* service.searchBotTasks({ botId: BotId.make("main"), query: "needle" }, owner);
        for (let index = 0; index < 501; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = '{' WHERE task_id = ${name(500)}`;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.isUndefined(first.partial);
        assert.isString(first.nextCursor);
        const next = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.strictEqual(next.partial, true);
      }),
    ),
  );
  it.effect("bounds the combined launches returned by bot task lookup", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("busy-lookup", { status: "running", createdAt: at(40) });
        for (let index = 0; index < 21; index++)
          yield* launch(
            "busy-lookup",
            `lookup-${index}`,
            index % 2 ? "ssh_thread_launch" : "thread_launch",
            index,
          );
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.getBotTask(
          { taskId: ChannelTaskId.make("busy-lookup"), botId: BotId.make("main") },
          owner,
        );
        assert.strictEqual(result.launchesTruncated, true);
        assert.strictEqual(result.codingRows.length + result.remoteWork.length, 20);
        assert.notProperty(result, "instruction");
      }),
    ),
  );

  it.effect("rejects search cursors for a different query, bot or owner", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("match-one", { status: "completed", createdAt: at(1) });
        yield* insertTask("match-two", { status: "completed", createdAt: at(2) });
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "match", limit: 1 },
          owner,
        );
        assert.isString(first.nextCursor);
        for (const [botId, query, requestOwner, cursor] of [
          ["main", "other", owner, first.nextCursor],
          ["other", "match", owner, first.nextCursor],
          ["main", "match", { ...owner, ownerId: "another-owner" }, first.nextCursor],
          ["main", "match", owner, "v1.@@@"],
        ] as const) {
          const error = yield* Effect.flip(
            service.searchBotTasks(
              { botId: BotId.make(botId), query, cursor: cursor ?? "" },
              requestOwner,
            ),
          );
          assert.strictEqual(error.reason, "invalid_input");
        }
      }),
    ),
  );
  it.effect("marks malformed processed search candidates partial", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const service = yield* BotThreads.ChannelBotThreads;
        yield* service.searchBotTasks({ botId: BotId.make("main"), query: "nothing" }, owner);
        yield* insertTask("broken", { status: "completed", createdAt: at(1) });
        yield* insertTask("missing-title", { status: "completed", createdAt: at(2) });
        yield* insertTask("needle", { status: "completed", createdAt: at(3) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = '{' WHERE task_id = 'broken'`;
        yield* sql`UPDATE channel_tasks SET task_json = json_remove(task_json, '$.title') WHERE task_id = 'missing-title'`;
        const result = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.strictEqual(result.partial, true);
        assert.deepStrictEqual(
          result.tasks.map((task) => String(task.taskId)),
          ["needle"],
        );
      }),
    ),
  );

  it.effect("does not process malformed candidates beyond a filled result limit", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const service = yield* BotThreads.ChannelBotThreads;
        yield* service.searchBotTasks({ botId: BotId.make("main"), query: "needle" }, owner);
        yield* insertTask("needle", { status: "completed", createdAt: at(1) });
        yield* insertTask("broken", { status: "completed", createdAt: at(2) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = '{' WHERE task_id = 'broken'`;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1 },
          owner,
        );
        assert.isUndefined(first.partial);
        assert.isString(first.nextCursor);
        const next = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.strictEqual(next.partial, true);
      }),
    ),
  );

  it.effect("truncates search titles at a trimmed Unicode code point boundary", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("long-title", { status: "completed", createdAt: at(1) });
        const sql = yield* SqlClient.SqlClient;
        const title = "a".repeat(199) + " " + "emoji😀needle";
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.title', ${title}) WHERE task_id = 'long-title'`;
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.strictEqual(result.tasks[0]?.title, "a".repeat(199));
        assert.strictEqual(result.tasks[0]?.titleTruncated, true);
      }),
    ),
  );
  it.effect("searches a stored title only up to its first NUL character", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("nul-title", { status: "completed", createdAt: at(1) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.title', ${"abc\0def"}) WHERE task_id = 'nul-title'`;
        const service = yield* BotThreads.ChannelBotThreads;
        const before = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "abc" },
          owner,
        );
        const after = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "def" },
          owner,
        );
        assert.deepStrictEqual(
          before.tasks.map((task) => String(task.taskId)),
          ["nul-title"],
        );
        assert.deepStrictEqual(after.tasks, []);
      }),
    ),
  );

  it.effect("marks an unreadable task view unavailable without inventing unread state", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("bad-view", { status: "running", createdAt: at(1) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${TaskViews.taskViewKey(ownerId, ChannelTaskId.make("bad-view"))}, '{', ${at(1)})`;
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.getBotTask(
          { taskId: ChannelTaskId.make("bad-view"), botId: BotId.make("main") },
          owner,
        );
        assert.strictEqual(result.task.state, "unavailable");
        assert.strictEqual(result.partial, true);
        assert.notProperty(result.task, "view");
        assert.notProperty(result.task, "unread");
      }),
    ),
  );

  it.effect("continues search after 500 nonmatching candidates", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 501; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        yield* insertTask("needle", { status: "completed", createdAt: at(501) });
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.deepStrictEqual(first.tasks, []);
        assert.isString(first.nextCursor);
        const second = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(
          second.tasks.map((task) => String(task.taskId)),
          ["needle"],
        );
      }),
    ),
  );
  it.effect("does not reveal a task to another owner or bot", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("scoped", { status: "running", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const taskId = ChannelTaskId.make("scoped");
        for (const [id, botId, requestOwner] of [
          [taskId, BotId.make("other"), owner],
          [taskId, BotId.make("main"), { ...owner, ownerId: "other-owner" }],
          [ChannelTaskId.make("missing"), BotId.make("main"), owner],
        ] as const) {
          const error = yield* Effect.flip(service.getBotTask({ taskId: id, botId }, requestOwner));
          assert.strictEqual(error.reason, "not_found");
        }
      }),
    ),
  );

  it.effect("searches literal title characters within the selected bot", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("literal%_\\value", { status: "completed", createdAt: at(1) });
        yield* insertTask("literal-other-value", { status: "completed", createdAt: at(2) });
        yield* insertTask("other%_\\value", {
          status: "completed",
          createdAt: at(3),
          botId: "other",
        });
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "%_\\" },
          owner,
        );
        assert.deepStrictEqual(
          result.tasks.map((task) => String(task.taskId)),
          ["literal%_\\value"],
        );
      }),
    ),
  );

  it.effect("looks up an owner and bot scoped task without exposing its instruction", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("lookup", { status: "running", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.getBotTask(
          { taskId: ChannelTaskId.make("lookup"), botId: BotId.make("main") },
          owner,
        );
        assert.strictEqual(result.task.state, "known");
        assert.notProperty(result, "instruction");
      }),
    ),
  );

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
        assert.deepStrictEqual(
          listed.flatMap((row) => (row.task_json === null ? [] : [row.task_id])).toSorted(),
          ["bound", "remote-released"],
        );
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

  it.effect("ends the walk at a task id the cursor decoder refuses though the cursor fits", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const long = "a".repeat(201);
        for (let index = 0; index < 49; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        yield* insertTask(long, { status: "completed", createdAt: at(49) });
        yield* insertTask("after", { status: "completed", createdAt: at(60) });
        assert.isBelow(
          encodeHistoryCursor({ ownerId, botId: "main" }, { createdAt: at(49), taskId: long })
            .length,
          512,
        );
        const page = yield* history();
        assert.strictEqual(taskIds([page]).at(-1), long);
        assert.isUndefined(page.history?.nextCursor);
        assert.isTrue(page.history?.endedEarly);
      }),
    ),
  );

  it.effect("lists a launch only once its thread exists, never one whose claim was refused", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const children = yield* ChildStore.ChannelChildWorkStore;
        const sql = yield* SqlClient.SqlClient;
        const reserve = (taskId: string, surface: "thread_launch" | "ssh_thread_launch") =>
          children.admitReserved(
            {
              ownerId,
              taskId: ChannelTaskId.make(taskId),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: "k-" + taskId,
              promptDigest: "digest",
              state: "reserved",
              createdAt: at(1),
              updatedAt: at(1),
              childWorkId: ChannelChildWorkId.make("cw-" + taskId),
              surface,
            },
            4,
          );
        const move = (
          taskId: string,
          from: "reserved" | "launched" | "bound",
          to: "launched" | "bound" | "completed" | "released",
          destination?: { threadId?: string; host?: string; correlationId?: string },
        ) => {
          const { threadId, ...rest } = destination ?? {};
          return children.transition({
            taskId: ChannelTaskId.make(taskId),
            childWorkId: ChannelChildWorkId.make("cw-" + taskId),
            from: [from],
            to,
            ...(destination === undefined
              ? {}
              : {
                  destination: {
                    ...rest,
                    ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
                  },
                }),
            now: at(0),
          });
        };
        for (const id of ["refused", "created", "remote-created", "in-flight"])
          yield* insertTask(id, { status: "running", createdAt: at(1), kind: "turn" });
        yield* insertTask("work-refused", { status: "running", createdAt: at(2) });
        // ThreadLaunchMcpService claims the local id, then a refused permission check releases it.
        for (const id of ["refused", "work-refused"]) {
          yield* reserve(id, "thread_launch");
          yield* move(id, "reserved", "launched", { threadId: "thread:" + id });
          yield* move(id, "launched", "released");
        }
        yield* reserve("created", "thread_launch");
        yield* move("created", "reserved", "launched", { threadId: "thread:created" });
        yield* move("created", "launched", "bound", { threadId: "thread:created" });
        yield* move("created", "bound", "completed");
        // A remote thread acknowledged by its destination stays listed after a later release.
        yield* reserve("remote-created", "ssh_thread_launch");
        yield* move("remote-created", "reserved", "launched", { correlationId: "c", host: "box" });
        yield* move("remote-created", "launched", "bound", {
          correlationId: "c",
          host: "box",
          threadId: "remote:created",
        });
        yield* move("remote-created", "bound", "released");
        // Claimed and not yet confirmed: out until the launch binds.
        yield* reserve("in-flight", "thread_launch");
        yield* move("in-flight", "reserved", "launched", { threadId: "thread:in-flight" });
        const listedTurns = () =>
          historyStatement(sql, { ownerId, botId: "main", after: undefined, limit: 51 }).pipe(
            Effect.map((rows) =>
              rows.flatMap((row) => (row.task_json === null ? [] : [row.task_id])).toSorted(),
            ),
          );
        assert.deepStrictEqual(yield* listedTurns(), ["created", "remote-created", "work-refused"]);
        const page = yield* history();
        assert.deepStrictEqual(
          page.rows.map((row) =>
            row.kind === "coding" ? String(row.threadId) : String(row.task.taskId),
          ),
          ["thread:created", "work-refused"],
        );
        assert.deepStrictEqual(
          (page.remoteWork ?? []).map((item) => String(item.taskId)),
          ["remote-created"],
        );
        yield* move("in-flight", "launched", "bound", { threadId: "thread:in-flight" });
        assert.deepStrictEqual(yield* listedTurns(), [
          "created",
          "in-flight",
          "remote-created",
          "work-refused",
        ]);
      }),
    ),
  );

  it.effect("checks a cursor before answering for a bot that does not exist", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const service = yield* BotThreads.ChannelBotThreads;
        const nobody = BotId.make("nobody");
        const error = yield* Effect.flip(service.list(owner, nobody, { cursor: "v1.@@@" }));
        assert.strictEqual(error.reason, "invalid_input");
        const foreign = encodeHistoryCursor(
          { ownerId, botId: "main" },
          { createdAt: at(0), taskId: "task-000" },
        );
        assert.strictEqual(
          (yield* Effect.flip(service.list(owner, nobody, { cursor: foreign }))).reason,
          "invalid_input",
        );
        const own = encodeHistoryCursor(
          { ownerId, botId: "nobody" },
          { createdAt: at(0), taskId: "task-000" },
        );
        assert.deepStrictEqual(yield* service.list(owner, nobody, { cursor: own }), {
          rows: [],
          mainMessageCount: 0,
          history: {},
        });
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
