import { assert, describe, it } from "@effect/vitest";
import { BotId, ChannelTaskId, type ChannelListBotThreadsResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as TaskViews from "./channelTaskViews.ts";
import { searchStatement } from "./channelBotTaskSearch.ts";
import {
  CHANNEL_BOT_THREADS_HISTORY_EXAMINED,
  quietMessagesStatement,
  historyStatement,
  launchesStatement,
} from "./channelBotThreadHistory.ts";
import { owner, ownerId } from "./testkit/ChannelHarness.ts";
import {
  at,
  name,
  insertTask,
  launch,
  childRecord,
  setup,
  provide,
  history,
  taskIds,
  walk,
} from "./testkit/botThreadHistory.fixture.ts";

describe("ChannelBotThreads history limits", () => {
  it.effect("continues after a full search page without skipping later matches", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 4; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.title', 'needle') WHERE task_id IN (${name(0)}, ${name(3)})`;
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1 },
          owner,
        );
        assert.deepStrictEqual(
          first.tasks.map((task) => String(task.taskId)),
          [name(0)],
        );
        assert.isString(first.nextCursor);
        const second = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1, cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(
          second.tasks.map((task) => String(task.taskId)),
          [name(3)],
        );
        assert.isUndefined(second.nextCursor);
      }),
    ),
  );
  it.effect("permits an empty continuation after a full final match page", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("needle", { status: "completed", createdAt: at(0) });
        yield* insertTask("other", { status: "completed", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1 },
          owner,
        );
        assert.isString(first.nextCursor);
        const second = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1, cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(second.tasks, []);
        assert.isUndefined(second.nextCursor);
      }),
    ),
  );
  it.effect("continues after 500 sparse candidates and finds the 550th", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 600; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.title', 'needle') WHERE task_id = ${name(549)}`;
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle" },
          owner,
        );
        assert.deepStrictEqual(first.tasks, []);
        assert.isUndefined(first.partial);
        assert.isString(first.nextCursor);
        const cursor = JSON.parse(
          Buffer.from((first.nextCursor ?? "").slice(3), "base64url").toString("utf8"),
        );
        assert.strictEqual(cursor[3], at(499));
        assert.strictEqual(cursor[4], name(499));
        const second = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(
          second.tasks.map((task) => String(task.taskId)),
          [name(549)],
        );
      }),
    ),
  );
  it.effect("treats a mismatched stored task view as unavailable", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("mismatch-view", { status: "running", createdAt: at(1) });
        const sql = yield* SqlClient.SqlClient;
        const taskId = ChannelTaskId.make("mismatch-view");
        const view = JSON.stringify({
          taskId: "other",
          pinnedAt: null,
          doneAt: null,
          readThrough: null,
        });
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (${TaskViews.taskViewKey(ownerId, taskId)}, ${view}, ${at(1)})`;
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.getBotTask({ taskId, botId: BotId.make("main") }, owner);
        assert.strictEqual(result.task.state, "unavailable");
        assert.strictEqual(result.partial, true);
        assert.notProperty(result.task, "view");
      }),
    ),
  );
  it.effect("returns at most 50 search matches and keeps creation-time ties stable", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 52; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(1) });
        const service = yield* BotThreads.ChannelBotThreads;
        const first = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "task", limit: 50 },
          owner,
        );
        assert.lengthOf(first.tasks, 50);
        assert.isString(first.nextCursor);
        const last = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "task", limit: 50, cursor: first.nextCursor ?? "" },
          owner,
        );
        assert.deepStrictEqual(
          [...first.tasks, ...last.tasks].map((task) => String(task.taskId)),
          Array.from({ length: 52 }, (_, index) => name(51 - index)),
        );
        assert.isUndefined(last.nextCursor);
      }),
    ),
  );
  it.effect("rejects a search query longer than 256 UTF-8 bytes", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const service = yield* BotThreads.ChannelBotThreads;
        const error = yield* Effect.flip(
          service.searchBotTasks({ botId: BotId.make("main"), query: "😀".repeat(65) }, owner),
        );
        assert.strictEqual(error.reason, "invalid_input");
      }),
    ),
  );
  it.effect("materializes a bounded indexed search before matching conversations", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 510; index++)
          yield* insertTask(name(index), { status: "completed", createdAt: at(index) });
        const sql = yield* SqlClient.SqlClient;
        for (const after of [undefined, { createdAt: at(250), taskId: name(250) }]) {
          const statement = searchStatement(
            sql,
            { ownerId, botId: "main", query: "needle" },
            after,
          );
          const plan = (yield* sql<{
            readonly detail: string;
          }>`EXPLAIN QUERY PLAN ${statement}`).map((row) => row.detail);
          yield* Effect.logInfo(
            (after === undefined ? "SEARCH FIRST PAGE PLAN\n" : "SEARCH CONTINUATION PLAN\n") +
              plan.join("\n"),
          );
          assert.match(
            plan.join("\n"),
            /SEARCH channel_tasks USING INDEX channel_tasks_owner_bot_created \(owner_id=\? AND bot_id=\?/,
          );
          assert.notInclude(plan.join("\n"), "SCAN channel_tasks");
          if (after !== undefined) assert.include(plan.join("\n"), "(created_at,task_id)<(?,?)");
          assert.match(plan.join("\n"), /MATERIALIZE candidates/);
          assert.match(plan.join("\n"), /SEARCH c USING INDEX/);
        }
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
          const statement = historyStatement(sql, {
            ownerId,
            botId: "main",
            after,
            limit: CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1,
          });
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
          if (after !== undefined) assert.include(text, "(created_at,task_id)<(?,?)", text);
        }
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

  it.effect("seeks each turn's launches from their index under skewed statistics", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        // 6,000 tasks, every third a turn and every fifth another bot's.
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5999)
          INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
            generation, task_json, created_at, updated_at, bot_id)
          SELECT printf('task-%04d', i), ${ownerId}, 'conv:bot', 'completed', 1, 1,
            CASE WHEN i % 3 = 0 THEN json_object('kind', 'turn') ELSE '{}' END,
            strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-12', printf('-%d minutes', i)),
            strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-12', printf('-%d minutes', i)),
            CASE WHEN i % 5 = 0 THEN 'other' ELSE 'main' END FROM n`;
        // 5,000 launches with threads, all on one turn.
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
          INSERT INTO channel_runtime_state (key, value_json, updated_at)
          SELECT printf('child-work:task-0003:cw-%04d', i),
            json_object('childWorkId', printf('cw-%04d', i), 'ownerId', ${ownerId},
              'taskId', 'task-0003', 'surface', 'thread_launch', 'state', 'completed',
              'createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-12', printf('-%d seconds', i)),
              'destination', json_object('threadId', printf('thread:%04d', i))),
            '2026-10-12T00:00:00.000Z' FROM n`;
        yield* sql`ANALYZE`;
        const planOf = (
          statement: ReturnType<typeof historyStatement> | ReturnType<typeof launchesStatement>,
        ) =>
          sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN ${statement}`.pipe(
            Effect.map((rows) => rows.map((row) => row.detail)),
          );
        for (const after of [undefined, { createdAt: at(3000), taskId: "task-3000" }]) {
          const plan = yield* planOf(
            historyStatement(sql, {
              ownerId,
              botId: "main",
              after,
              limit: CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1,
            }),
          );
          const text = plan.join("\n");
          assert.match(text, /SEARCH t USING INDEX channel_tasks_owner_bot_created/, text);
          assert.include(plan, "SEARCH s USING INDEX channel_child_work_launches (<expr>=?)", text);
          assert.notMatch(text, /SCAN s\b/, text);
          assert.notInclude(text, "TEMP B-TREE", text);
        }
        for (const taskId of ["task-0003", "task-0006"]) {
          const plan = yield* planOf(launchesStatement(sql, { ownerId, taskId, limit: 21 }));
          const text = plan.join("\n");
          assert.include(plan, "SEARCH s USING INDEX channel_child_work_launches (<expr>=?)", text);
          assert.notInclude(text, "TEMP B-TREE", text);
        }
      }),
    ),
  );

  it.effect("examines a bounded number of tasks per page and walks on to an older task once", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        // More chat turns without a launch than one page examines, all newer than one task.
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n
            WHERE i < ${CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 9})
          INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
            generation, task_json, created_at, updated_at, bot_id)
          SELECT printf('turn-%04d', i), ${ownerId}, 'conv:bot', 'completed', 1, 1,
            json_object('kind', 'turn'),
            strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-12', printf('-%d seconds', i)),
            strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-12', printf('-%d seconds', i)), 'main' FROM n`;
        yield* insertTask("older", { status: "completed", createdAt: at(1000) });
        const first = yield* history();
        assert.deepStrictEqual(first.rows, []);
        assert.isString(first.history?.nextCursor);
        const pages = yield* walk();
        assert.lengthOf(pages, 2);
        assert.deepStrictEqual(taskIds(pages), ["older"]);
        assert.isUndefined(pages.at(-1)?.history?.nextCursor);
      }),
    ),
  );

  it.effect("breaks ties in creation time by task id at the examined-task boundary", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const last = CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1;
        // Same creation time throughout; newest first is tie-<last> down to tie-0000.
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i + 1 FROM n WHERE i < ${last})
          INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
            generation, task_json, created_at, updated_at, bot_id)
          SELECT printf('tie-%04d', i), ${ownerId}, 'conv:bot', 'completed', 1, 1,
            json_object('kind', 'turn'), ${at(5)}, ${at(5)}, 'main' FROM n`;
        // The last task the first page examines, and the two just past it.
        for (const id of ["tie-0002", "tie-0001", "tie-0000"])
          yield* insertTask(id, { status: "completed", createdAt: at(5) });
        const pages = yield* walk();
        assert.deepStrictEqual(taskIds(pages.slice(0, 1)), ["tie-0002"]);
        assert.deepStrictEqual(taskIds(pages), ["tie-0002", "tie-0001", "tie-0000"]);
        assert.lengthOf(pages, 2);
      }),
    ),
  );

  it.effect("seeks one index range inside a large creation-time tie", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
          INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
            generation, task_json, created_at, updated_at, bot_id)
          SELECT printf('tie-%04d', i), ${ownerId}, 'conv:bot', 'completed', 1, 1,
            json_object('kind', 'turn'), ${at(5)}, ${at(5)}, 'main' FROM n`;
        yield* sql`ANALYZE`;
        const statement = historyStatement(sql, {
          ownerId,
          botId: "main",
          after: { createdAt: at(5), taskId: "tie-1000" },
          limit: CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1,
        });
        const plan = (yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN ${statement}`).map(
          (row) => row.detail,
        );
        // One range on the index's four columns: the seek starts at the cursor, inside the tie.
        assert.include(
          plan,
          "SEARCH t USING INDEX channel_tasks_owner_bot_created (owner_id=? AND bot_id=? AND (created_at,task_id)<(?,?))",
          plan.join("\n"),
        );
        const rows = yield* statement;
        assert.strictEqual(rows[0]?.task_id, "tie-0999");
        assert.lengthOf(rows, CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1);
      }),
    ),
  );

  it.effect("flags a task's launches as truncated when its 21st launch cannot be read", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask("busy", { status: "running", createdAt: at(1) });
        for (let index = 0; index < 20; index++)
          yield* launch("busy", `busy-${index}`, "thread_launch", 50 - index);
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
          'child-work:busy:old-bad', ${JSON.stringify({
            ownerId,
            taskId: "busy",
            surface: "thread_launch",
            state: "completed",
            createdAt: at(100),
            destination: { threadId: "thread:old-bad" },
          })}, ${at(100)})`;
        const page = yield* history();
        assert.lengthOf(
          page.rows.filter((row) => row.kind === "coding"),
          20,
        );
        assert.deepStrictEqual(page.history?.launchesTruncated, [ChannelTaskId.make("busy")]);
      }),
    ),
  );

  it.effect("uses the empty view for a task view it cannot read and marks the page partial", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask("work", { status: "running", createdAt: at(1) });
        yield* insertTask("second", { status: "running", createdAt: at(2) });
        // One view the schema refuses, and one stored under another task's key.
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES
          (${TaskViews.taskViewKey(ownerId, ChannelTaskId.make("work"))}, '{"taskId":"work"}', ${at(0)}),
          (${TaskViews.taskViewKey(ownerId, ChannelTaskId.make("second"))},
            ${JSON.stringify({ taskId: "other", pinnedAt: at(0), doneAt: null, readThrough: null })},
            ${at(0)})`;
        const page = yield* history();
        assert.deepStrictEqual(
          page.rows.map((row) =>
            row.kind === "task"
              ? `${row.task.taskId} ${row.view.taskId} ${row.view.pinnedAt} ${row.view.doneAt} ${row.view.readThrough}`
              : "",
          ),
          ["work work null null null", "second second null null null"],
        );
        assert.isTrue(page.history?.partial);
        // The current list still fails closed on the same views, as on dev.
        const service = yield* BotThreads.ChannelBotThreads;
        assert.strictEqual((yield* Effect.flip(service.list(owner))).reason, "persistence_failed");
      }),
    ),
  );

  it.effect("marks a page partial when it skips a task it cannot read", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask("work", { status: "running", createdAt: at(1) });
        assert.isUndefined((yield* history()).history?.partial);
        yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
            generation, task_json, created_at, updated_at, bot_id)
          VALUES ('broken', ${ownerId}, 'conv:bot', 'running', 1, 1, '{"kind":"work"}', ${at(2)},
            ${at(2)}, 'main')`;
        const page = yield* history();
        assert.deepStrictEqual(taskIds([page]), ["work"]);
        assert.isTrue(page.history?.partial);
      }),
    ),
  );

  it.effect("skips a launch it cannot read, lists the rest and marks the page partial", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask("work", { status: "running", createdAt: at(1) });
        yield* launch("work", "good", "thread_launch", 5);
        assert.isUndefined((yield* history()).history?.partial);
        // Valid JSON the child-work schema refuses: it has no childWorkId or callerThreadId.
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
          'child-work:work:bad', ${JSON.stringify({
            ownerId,
            taskId: "work",
            surface: "thread_launch",
            state: "completed",
            createdAt: at(1),
            destination: { threadId: "thread:bad" },
          })}, ${at(1)})`;
        const page = yield* history();
        assert.deepStrictEqual(
          page.rows.map((row) =>
            row.kind === "coding" ? String(row.threadId) : String(row.task.taskId),
          ),
          ["work", "thread:good"],
        );
        assert.isTrue(page.history?.partial);
      }),
    ),
  );

  it.effect("answers a typed failure when the launch index is missing", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask("work", { status: "running", createdAt: at(1) });
        yield* sql`DROP INDEX channel_child_work_launches`;
        const error = yield* Effect.flip(history());
        assert.strictEqual(error.reason, "persistence_failed");
      }),
    ),
  );

  it.effect(
    "counts a history row's main messages up to 10, as the exact count decides, and leaves the bot count to the current list",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          const sql = yield* SqlClient.SqlClient;
          yield* insertTask("quiet", { status: "completed", createdAt: at(100) });
          yield* insertTask("buried", { status: "completed", createdAt: at(300) });
          yield* sql`INSERT INTO channel_bindings (binding_id, conversation_id, connection_id,
            reply_address_json, last_activity_at)
          VALUES ('binding:1', 'conv:bot', 'goat', '{}', ${at(0)})`;
          const input = (id: string, acceptedAt: string, taskId?: string) =>
            sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id,
              idempotency_key, content_hash, conversation_id, binding_id, message_json, state,
              accepted_at)
            VALUES (${id}, ${ownerId}, 'goat', 'goat', ${id}, 'hash', 'conv:bot', 'binding:1',
              ${JSON.stringify({ intent: "message", ...(taskId === undefined ? {} : { taskId }) })},
              'accepted', ${acceptedAt})`;
          // "buried" went quiet, then its own task chatter filled the window before main messages.
          for (let index = 0; index < 60; index++)
            yield* input(`task-msg-${index}`, at(250 - index), "buried");
          // Main messages with other entries between them: task replies, agent posts, rejections.
          for (let index = 0; index < 12; index++) {
            yield* input(`main-${index}`, at(50 - index));
            yield* input(`between-${index}`, at(49.5 - index), "quiet");
          }
          yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id,
              idempotency_key, content_hash, conversation_id, binding_id, message_json, state,
              accepted_at)
            VALUES ('rejected', ${ownerId}, 'goat', 'goat', 'rejected', 'hash', 'conv:bot',
              'binding:1', '{"intent":"message"}', 'rejected', ${at(40)}),
              ('agent', ${ownerId}, 'goat', 'goat', 'agent', 'hash', 'conv:bot', 'binding:1',
              '{"intent":"message","actor":{"senderThreadId":"thread:worker"}}', 'accepted',
              ${at(40)})`;
          const service = yield* BotThreads.ChannelBotThreads;
          const count = (page: ChannelListBotThreadsResult, taskId: string) =>
            page.rows.flatMap((row) =>
              row.kind === "task" && row.task.taskId === taskId ? [row.mainMessagesSinceQuiet] : [],
            );
          const current = yield* service.list(owner);
          const page = yield* history();
          assert.deepStrictEqual(count(current, "quiet"), [12]);
          assert.deepStrictEqual(count(current, "buried"), [12]);
          // Stopping at 10 gives every ">= 10" decision the exact count would give.
          for (const taskId of ["quiet", "buried"]) {
            const exact = count(current, taskId)[0] ?? -1;
            const capped = count(page, taskId)[0] ?? -1;
            assert.strictEqual(capped, Math.min(exact, 10), taskId);
            assert.strictEqual(capped >= 10, exact >= 10, taskId);
          }
          const plan = (yield* sql<{
            readonly detail: string;
          }>`EXPLAIN QUERY PLAN ${quietMessagesStatement(sql, {
            ownerId,
            inputs: JSON.stringify([
              { taskId: "quiet", conversationId: "conv:bot", quiet: at(100) },
            ]),
          })}`).map((row) => row.detail);
          assert.include(
            plan,
            "SEARCH i USING INDEX channel_inbox_main_messages (owner_id=? AND conversation_id=? AND accepted_at>?)",
            plan.join("\n"),
          );
          assert.strictEqual(current.mainMessageCount, 12);
          assert.strictEqual(page.mainMessageCount, 0);
        }),
      ),
  );
});
