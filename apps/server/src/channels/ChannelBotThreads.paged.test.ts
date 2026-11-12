import { assert, describe, it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  ChannelTaskId,
  ThreadId,
  type BotThreadRow,
  type ChannelBotThreadsPage,
  type ChannelListBotThreadsResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import { finishedWorkStatement } from "./channelBotThreadPages.ts";
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

const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const at = (hoursAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - hoursAgo * 3_600_000));
const RECENT = 24;
const OLD = 24 * 5;

const insertTask = (
  id: string,
  options: {
    readonly status: string;
    readonly updatedAt: string;
    readonly completedAt?: string;
    readonly kind?: "turn";
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const terminal = ["completed", "failed", "cancelled"].includes(options.status);
    const completedAt = options.completedAt ?? (terminal ? options.updatedAt : undefined);
    const data = JSON.stringify({
      taskId: id,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      conversationId: "conv:bot",
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
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
    });
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at) VALUES (${id}, ${ownerId}, 'conv:bot', ${options.status}, 1, 1, ${data}, ${options.updatedAt}, ${options.updatedAt})`;
  });

/** What the ledger writes when a task ends: status, completedAt and updatedAt together. */
const finishTask = (id: string, when: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_tasks SET status = 'completed', updated_at = ${when},
      task_json = json_set(task_json, '$.status', 'completed', '$.completedAt', ${when}, '$.updatedAt', ${when})
      WHERE task_id = ${id}`;
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

const list = (page: ChannelBotThreadsPage) =>
  Effect.gen(function* () {
    const service = yield* BotThreads.ChannelBotThreads;
    return yield* service.list(owner, undefined, page);
  });

/** The first page and every earlier page after it, read in order. */
const walk = Effect.gen(function* () {
  const pages: ChannelListBotThreadsResult[] = [yield* list({ kind: "first" })];
  let cursor = pages[0]?.page?.earlierCursor;
  while (cursor !== undefined) {
    assert.isBelow(pages.length, 100, "the walk ends");
    const next = yield* list({ kind: "earlier", cursor });
    pages.push(next);
    cursor = next.page?.earlierCursor;
  }
  return pages;
});

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
const taskRows = (pages: ReadonlyArray<ChannelListBotThreadsResult>) =>
  pages.flatMap((page) => page.rows.filter((row): row is TaskRow => row.kind === "task"));
const taskIds = (pages: ReadonlyArray<ChannelListBotThreadsResult>) =>
  taskRows(pages).map((row) => String(row.task.taskId));
const assertEachOnce = (ids: ReadonlyArray<string>, expected: ReadonlyArray<string>) => {
  assert.strictEqual(new Set(ids).size, ids.length, "no task is listed twice");
  assert.deepStrictEqual([...ids].sort(), [...expected].sort());
};

describe("ChannelBotThreads paged read", () => {
  it.effect("lists every task exactly once across the first page and the earlier pages", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const all: string[] = [];
        for (let index = 0; index < 30; index++) {
          yield* insertTask(`running-${index}`, { status: "running", updatedAt: at(1) });
          all.push(`running-${index}`);
        }
        // 90 recent finished tasks cannot all fit beside 30 running ones; 75 older ones follow.
        for (let index = 0; index < 165; index++) {
          const id = `done-${String(index).padStart(3, "0")}`;
          // Pairs share a finish time, so the task id has to break the tie.
          yield* insertTask(id, {
            status: index % 7 === 0 ? "failed" : "completed",
            updatedAt: at(index < 90 ? 2 + Math.floor(index / 2) : OLD + index),
          });
          all.push(id);
        }
        const pages = yield* walk;
        assertEachOnce(taskIds(pages), all);
        assert.lengthOf(taskRows(pages.slice(0, 1)), 100);
        for (const page of pages.slice(1)) assert.isAtMost(page.rows.length, 50);
        assert.isFalse(pages[0]?.page?.activeTruncated);
        assert.isFalse(pages[0]?.page?.pinnedTruncated);
        // Finished work runs newest first through the pages.
        const finished = taskRows(pages)
          .filter((row) => row.task.status !== "running")
          .map((row) => row.task.completedAt ?? "");
        assert.deepStrictEqual(finished, [...finished].sort().reverse());
      }),
    ),
  );

  it.effect("gives pinned tasks their own cap beside the first page's 100", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const views = yield* TaskViews.ChannelTaskViews;
        for (let index = 0; index < 101; index++) {
          yield* insertTask(`pinned-${index}`, { status: "completed", updatedAt: at(OLD + index) });
          yield* views.update(
            { taskId: ChannelTaskId.make(`pinned-${index}`), pinned: true },
            owner,
          );
        }
        for (let index = 0; index < 100; index++)
          yield* insertTask(`running-${index}`, { status: "running", updatedAt: at(1) });
        const first = yield* list({ kind: "first" });
        const ids = taskIds([first]);
        assert.lengthOf(
          ids.filter((id) => id.startsWith("pinned-")),
          100,
        );
        assert.lengthOf(
          ids.filter((id) => id.startsWith("running-")),
          100,
        );
        assert.isFalse(ids.includes("pinned-100"), "the oldest pinned task is past the cap");
        assert.isTrue(first.page?.pinnedTruncated);
        assert.isFalse(first.page?.activeTruncated);
        assert.isUndefined(first.page?.earlierCursor);
      }),
    ),
  );

  it.effect("flags running work past the first page's cap and still pages the finished work", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 101; index++)
          yield* insertTask(`running-${index}`, { status: "running", updatedAt: at(1) });
        yield* insertTask("done-recent", { status: "completed", updatedAt: at(RECENT) });
        yield* insertTask("done-old", { status: "completed", updatedAt: at(OLD) });
        const pages = yield* walk;
        assert.isTrue(pages[0]?.page?.activeTruncated);
        assert.lengthOf(taskIds(pages.slice(0, 1)), 100);
        assert.deepStrictEqual(taskIds(pages.slice(1)), ["done-recent", "done-old"]);
      }),
    ),
  );

  it.effect("skips and repeats nothing when a task finishes between pages", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const all: string[] = [];
        for (let index = 0; index < 120; index++) {
          const id = `done-${String(index).padStart(3, "0")}`;
          yield* insertTask(id, { status: "completed", updatedAt: at(OLD + index) });
          all.push(id);
        }
        yield* insertTask("running", { status: "running", updatedAt: at(1) });
        all.push("running");
        const first = yield* list({ kind: "first" });
        yield* finishTask("running", at(0));
        const rest: ChannelListBotThreadsResult[] = [];
        let cursor = first.page?.earlierCursor;
        while (cursor !== undefined) {
          const next = yield* list({ kind: "earlier", cursor });
          rest.push(next);
          cursor = next.page?.earlierCursor;
        }
        // The client reads the first page again when work changes.
        const again = yield* list({ kind: "first" });
        assertEachOnce(taskIds([again, ...rest]), all);
        assert.isTrue(taskIds([again]).includes("running"));
      }),
    ),
  );

  it.effect("skips and repeats nothing when a task is pinned or unpinned between pages", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const all: string[] = [];
        for (let index = 0; index < 120; index++) {
          const id = `done-${String(index).padStart(3, "0")}`;
          yield* insertTask(id, { status: "completed", updatedAt: at(OLD + index) });
          all.push(id);
        }
        const views = yield* TaskViews.ChannelTaskViews;
        const first = yield* list({ kind: "first" });
        const cursor = first.page?.earlierCursor;
        assert.isDefined(cursor);
        const before = yield* list({ kind: "earlier", cursor: cursor ?? "" });
        const target = taskIds([before])[10] ?? "";
        yield* views.update({ taskId: ChannelTaskId.make(target), pinned: true }, owner);
        const pinnedWalk = yield* walk;
        assertEachOnce(taskIds(pinnedWalk), all);
        assert.isTrue(
          taskIds(pinnedWalk.slice(0, 1)).includes(target),
          "a pinned task is on the first page",
        );
        const after = yield* list({ kind: "earlier", cursor: cursor ?? "" });
        assert.deepStrictEqual(
          taskIds([after]),
          [...taskIds([before]).filter((id) => id !== target), "done-050"],
          "the old cursor still continues right after the first page",
        );
        yield* views.update({ taskId: ChannelTaskId.make(target), pinned: false }, owner);
        const unpinnedWalk = yield* walk;
        assertEachOnce(taskIds(unpinnedWalk), all);
        assert.deepStrictEqual(taskIds(unpinnedWalk.slice(1, 2)), taskIds([before]));
      }),
    ),
  );

  it.effect("keeps a page's rows when one is marked done or read, and shows the new marks", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 60; index++)
          yield* insertTask(`done-${String(index).padStart(3, "0")}`, {
            status: "completed",
            updatedAt: at(OLD + index),
          });
        const views = yield* TaskViews.ChannelTaskViews;
        const first = yield* list({ kind: "first" });
        const cursor = first.page?.earlierCursor ?? "";
        const before = yield* list({ kind: "earlier", cursor });
        const target = taskRows([before])[3];
        assert.isDefined(target);
        assert.isTrue(target?.unread);
        const taskId = target?.task.taskId ?? ChannelTaskId.make("");
        yield* views.update({ taskId, done: true }, owner);
        yield* views.update({ taskId, readThrough: target?.lastActivityAt ?? "" }, owner);
        const after = yield* list({ kind: "earlier", cursor });
        assert.deepStrictEqual(taskIds([after]), taskIds([before]));
        const row = taskRows([after]).find((candidate) => candidate.task.taskId === taskId);
        assert.deepStrictEqual(row?.view, yield* views.get(taskId, owner));
        assert.isNotNull(row?.view.doneAt);
        assert.isFalse(row?.unread);
      }),
    ),
  );

  it.effect("counts unread over every page, not the rows one page holds", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const views = yield* TaskViews.ChannelTaskViews;
        for (let index = 0; index < 140; index++) {
          const id = ChannelTaskId.make(`done-${String(index).padStart(3, "0")}`);
          yield* insertTask(id, {
            status: "completed",
            updatedAt: at(index < 20 ? RECENT : OLD + index),
          });
          if (index % 3 === 0)
            yield* views.update({ taskId: id, readThrough: at(OLD + index) }, owner);
          if (index % 10 === 0) yield* views.update({ taskId: id, pinned: true }, owner);
        }
        yield* insertTask("running", { status: "running", updatedAt: at(1) });
        const pages = yield* walk;
        const unread = taskRows(pages).filter((row) => row.unread).length;
        assert.isAbove(unread, 50);
        assert.strictEqual(pages[0]?.page?.unreadCount, unread);
      }),
    ),
  );

  it.effect("lists a finished turn's launched threads as threads, without the turn", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const children = yield* ChildStore.ChannelChildWorkStore;
        for (const [taskId, hoursAgo] of [
          ["turn:recent", RECENT],
          ["turn:old", OLD],
          ["turn:quiet", RECENT],
        ] as const) {
          yield* insertTask(taskId, { status: "running", updatedAt: at(hoursAgo), kind: "turn" });
        }
        const launch = (
          taskId: string,
          id: string,
          surface: "thread_launch" | "ssh_thread_launch",
          destination: object,
        ) =>
          children.admitReserved(
            {
              ownerId,
              taskId: ChannelTaskId.make(taskId),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: id,
              promptDigest: "digest",
              state: "completed" as const,
              createdAt: at(OLD),
              updatedAt: at(OLD),
              childWorkId: ChannelChildWorkId.make(id),
              surface,
              destination,
            },
            100,
          );
        yield* launch("turn:recent", "local", "thread_launch", {
          threadId: ThreadId.make("thread:recent"),
        });
        yield* launch("turn:old", "remote", "ssh_thread_launch", {
          threadId: ThreadId.make("thread:remote"),
          host: "box",
        });
        yield* launch("turn:old", "old-local", "thread_launch", {
          threadId: ThreadId.make("thread:old"),
        });
        for (const [taskId, hoursAgo] of [
          ["turn:recent", RECENT],
          ["turn:old", OLD],
          ["turn:quiet", RECENT],
        ] as const)
          yield* finishTask(taskId, at(hoursAgo));
        const pages = yield* walk;
        assert.deepStrictEqual(taskIds(pages), [], "a turn's answer is in the chat");
        const coding = pages.flatMap((page) =>
          page.rows.flatMap((row) => (row.kind === "coding" ? [[row.taskId, row.threadId]] : [])),
        );
        assert.deepStrictEqual(coding, [
          ["turn:recent", "thread:recent"],
          ["turn:old", "thread:old"],
        ]);
        assert.deepStrictEqual(
          pages[0]?.rows.map((row) => (row.kind === "coding" ? String(row.threadId) : row.kind)),
          ["thread:recent"],
          "the recent turn's thread is on the first page",
        );
        assert.deepStrictEqual(
          pages.flatMap((page) => (page.remoteWork ?? []).map((item) => item.childWorkId)),
          ["remote"],
        );
      }),
    ),
  );

  it.effect("keeps a finished task in place when it is updated after it finished", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const all: string[] = [];
        for (let index = 0; index < 120; index++) {
          const id = `done-${String(index).padStart(3, "0")}`;
          yield* insertTask(id, { status: "completed", updatedAt: at(OLD + index) });
          all.push(id);
        }
        const before = yield* walk;
        // An observation of a finished task's worker moves updatedAt and leaves completedAt.
        yield* sql`UPDATE channel_tasks SET updated_at = ${at(0)},
          task_json = json_set(task_json, '$.updatedAt', ${at(0)}) WHERE task_id = 'done-070'`;
        const after = yield* walk;
        assertEachOnce(taskIds(after), all);
        assert.deepStrictEqual(
          after.map((page) => taskIds([page])),
          before.map((page) => taskIds([page])),
        );
      }),
    ),
  );

  it.effect("moves a task retried between pages from finished work to the first page", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const all: string[] = [];
        for (let index = 0; index < 120; index++) {
          const id = `done-${String(index).padStart(3, "0")}`;
          yield* insertTask(id, { status: "completed", updatedAt: at(OLD + index) });
          all.push(id);
        }
        const first = yield* list({ kind: "first" });
        const cursor = first.page?.earlierCursor ?? "";
        // A retry runs the task again and removes its completedAt.
        yield* sql`UPDATE channel_tasks SET status = 'running', updated_at = ${at(0)},
          task_json = json_remove(json_set(task_json, '$.status', 'running', '$.updatedAt', ${at(0)}), '$.completedAt')
          WHERE task_id = 'done-020'`;
        const rest: ChannelListBotThreadsResult[] = [];
        let next: string | undefined = cursor;
        while (next !== undefined) {
          const page: ChannelListBotThreadsResult = yield* list({ kind: "earlier", cursor: next });
          rest.push(page);
          next = page.page?.earlierCursor;
        }
        const again = yield* list({ kind: "first" });
        assertEachOnce(taskIds([again, ...rest]), all);
        assert.deepStrictEqual(taskIds([again]), ["done-020"]);
      }),
    ),
  );

  it.effect("lists a pinned task that is running once, among the pinned", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const views = yield* TaskViews.ChannelTaskViews;
        yield* insertTask("running", { status: "running", updatedAt: at(1) });
        yield* insertTask("other", { status: "running", updatedAt: at(2) });
        yield* views.update({ taskId: ChannelTaskId.make("running"), pinned: true }, owner);
        const pages = yield* walk;
        assertEachOnce(taskIds(pages), ["running", "other"]);
        assert.strictEqual(pages[0]?.page?.unreadCount, 2);
      }),
    ),
  );

  it.effect("moves a turn from its task row to its threads when its launched work ends", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const children = yield* ChildStore.ChannelChildWorkStore;
        for (let index = 0; index < 60; index++)
          yield* insertTask(`done-${String(index).padStart(3, "0")}`, {
            status: "completed",
            updatedAt: at(OLD + index),
          });
        yield* insertTask("turn", { status: "running", updatedAt: at(OLD + 30), kind: "turn" });
        yield* children.admitReserved(
          {
            ownerId,
            taskId: ChannelTaskId.make("turn"),
            generation: 1,
            callerThreadId: botThreadId,
            requestKey: "launch",
            promptDigest: "digest",
            state: "bound" as const,
            createdAt: at(OLD + 30),
            updatedAt: at(OLD + 30),
            childWorkId: ChannelChildWorkId.make("launch"),
            surface: "thread_launch",
            destination: { threadId: ThreadId.make("thread:turn") },
          },
          100,
        );
        yield* finishTask("turn", at(OLD + 30));
        const coding = (pages: ReadonlyArray<ChannelListBotThreadsResult>) =>
          pages.flatMap((page) =>
            page.rows.flatMap((row) => (row.kind === "coding" ? [String(row.threadId)] : [])),
          );
        const live = yield* walk;
        assert.isTrue(
          taskIds(live.slice(0, 1)).includes("turn"),
          "a running launch shows its turn",
        );
        yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.state', 'completed')
          WHERE key >= 'child-work:turn:' AND key < 'child-work:turn;'`;
        const ended = yield* walk;
        assert.isFalse(taskIds(ended).includes("turn"));
        assert.deepStrictEqual(coding(ended), ["thread:turn"]);
        assert.deepStrictEqual(
          coding(ended.slice(0, 1)),
          [],
          "its thread is with work that ended then",
        );
      }),
    ),
  );

  it.effect("flags live turns past the running cap and still counts every one unread", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const children = yield* ChildStore.ChannelChildWorkStore;
        for (let index = 0; index < 101; index++) {
          const taskId = `turn-${String(index).padStart(3, "0")}`;
          yield* insertTask(taskId, { status: "running", updatedAt: at(1), kind: "turn" });
          yield* children.admitReserved(
            {
              ownerId,
              taskId: ChannelTaskId.make(taskId),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: "launch",
              promptDigest: "digest",
              state: "bound" as const,
              createdAt: at(1),
              updatedAt: at(1),
              childWorkId: ChannelChildWorkId.make(`launch-${index}`),
              surface: "thread_launch",
              destination: { threadId: ThreadId.make(`thread:${index}`) },
            },
            100,
          );
        }
        const first = yield* list({ kind: "first" });
        assert.lengthOf(taskIds([first]), 100);
        assert.isTrue(first.page?.activeTruncated);
        assert.strictEqual(first.page?.unreadCount, 101);
      }),
    ),
  );

  it.effect("answers a malformed cursor as invalid input", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (const cursor of ["no-separator", "not-a-time|task", "|task"]) {
          const error = yield* Effect.flip(list({ kind: "earlier", cursor }));
          assert.strictEqual(error.reason, "invalid_input");
        }
      }),
    ),
  );

  it.effect("reads finished work from its index in order, without sorting", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        for (let index = 0; index < 300; index++) {
          yield* insertTask(`task-${index}`, {
            status: index % 4 === 0 ? "running" : "completed",
            updatedAt: at(index),
            ...(index % 3 === 0 ? { kind: "turn" as const } : {}),
          });
        }
        const sql = yield* SqlClient.SqlClient;
        for (const after of [undefined, { finish: at(100), taskId: "task-100" }]) {
          const statement = finishedWorkStatement(sql, {
            ownerId,
            botId: "main",
            pinned: ["task-5"],
            after,
            limit: 51,
          });
          const plan = (yield* sql<{
            readonly detail: string;
          }>`EXPLAIN QUERY PLAN ${statement}`).map((row) => row.detail);
          assert.isTrue(
            plan.some((detail) => detail.includes("USING INDEX channel_tasks_owner_bot_finished")),
            plan.join("\n"),
          );
          assert.isFalse(
            plan.some((detail) => detail.includes("TEMP B-TREE")),
            plan.join("\n"),
          );
          if (after !== undefined)
            assert.isTrue(
              plan.some((detail) => detail.includes("<expr><?")),
              plan.join("\n"),
            );
        }
      }),
    ),
  );
});
