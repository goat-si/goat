import { assert, describe, it } from "@effect/vitest";
import { BotId, ChannelTaskId, type BotThreadRow } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotThreads from "./ChannelBotThreads.ts";
import { environmentId, owner } from "./testkit/ChannelHarness.ts";
import { warnings } from "./testkit/botThreadUnread.fixture.ts";
import {
  at,
  childRecord,
  history,
  insertTask,
  provide,
  setup,
} from "./testkit/botThreadHistory.fixture.ts";

type State = "open" | "merged" | "closed";
const repository = "goat-si/goat";
const url = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
const link = (
  number: number,
  options: { readonly state?: State; readonly repo?: string; readonly dismissed?: true } = {},
) => ({
  host: "github.com",
  repository: options.repo ?? repository,
  number,
  url: url(options.repo ?? repository, number),
  source: options.dismissed ? "stack-dismissed" : "created",
  linkedAt: at(5),
  snapshot:
    options.state === undefined
      ? null
      : {
          state: options.state,
          title: "Change",
          headBranch: "change",
          baseBranch: "dev",
          isDraft: false,
          updatedAt: null,
          syncedAt: at(1),
        },
  stack: null,
});
/** A thread in this machine's projection holding these pull request links. */
const projectThread = (
  threadId: string,
  links: ReadonlyArray<unknown>,
  thread: {
    readonly settledAt?: string;
    readonly settledOverride?: "settled";
    readonly archivedAt?: string;
    readonly deleted?: true;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      pullRequests: links,
      settledAt: thread.settledAt ?? null,
      settledOverride: thread.settledOverride ?? null,
      archivedAt: thread.archivedAt ?? null,
    });
    const deletedAt = thread.deleted ? at(1) : null;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json) VALUES (${threadId}, 'project:repo', ${threadId}, 'codex', 'full-access', 'default', ${at(5)}, ${at(5)}, ${deletedAt}, ${payload})`;
  });
const setWorker = (taskId: string, threadId: string, host?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const worker = JSON.stringify({
      environmentId,
      threadId,
      generation: 1,
      ...(host === undefined ? {} : { host }),
    });
    yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.worker', json(${worker})) WHERE task_id = ${taskId}`;
  });
/** The copy the ledger made of the worker thread's links while the task ran. */
const setObserved = (
  taskId: string,
  pullRequests: ReadonlyArray<{ readonly number: number; readonly state?: State }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const observed = JSON.stringify({
      pullRequests: pullRequests.map((item) => ({
        repository,
        url: url(repository, item.number),
        watching: true,
        ...item,
      })),
      needsYou: [],
    });
    yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.observed', json(${observed})) WHERE task_id = ${taskId}`;
  });
const localLaunch = (taskId: string, childWorkId: string, state: "bound" | "completed") =>
  childRecord(taskId, childWorkId, {
    surface: "thread_launch",
    state,
    destination: { threadId: "thread:" + childWorkId },
  });
const current = Effect.gen(function* () {
  const service = yield* BotThreads.ChannelBotThreads;
  return yield* service.list(owner);
});
const lookup = (taskId: string) =>
  Effect.gen(function* () {
    const service = yield* BotThreads.ChannelBotThreads;
    return yield* service.getBotTask(
      { taskId: ChannelTaskId.make(taskId), botId: BotId.make("main") },
      owner,
    );
  });
const taskRow = (result: { readonly rows: ReadonlyArray<BotThreadRow> }, taskId: string) => {
  const row = result.rows.find((item) => item.kind === "task" && item.task.taskId === taskId);
  if (row?.kind !== "task") throw new Error("no row for " + taskId);
  return row;
};
const item = (number: number, state?: State, repo = repository) => ({
  repository: repo,
  number,
  ...(state === undefined ? {} : { state }),
  watching: false,
});

describe("ChannelBotThreads pull requests", () => {
  it.effect(
    "a turn task's row lists the pull request its launched thread opened, not the session thread's",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* insertTask("turn-1", { status: "running", createdAt: at(2), kind: "turn" });
          // The session thread serves several tasks, so its links belong to none of them.
          yield* setWorker("turn-1", "goat-bot-session:conv:bot");
          yield* projectThread("goat-bot-session:conv:bot", [link(99, { state: "open" })]);
          yield* localLaunch("turn-1", "launch-a", "bound");
          yield* projectThread("thread:launch-a", [link(12, { state: "open" })]);
          // A remote launch's thread is another machine's; a local thread with its id is not it.
          yield* childRecord("turn-1", "remote-a", {
            surface: "ssh_thread_launch",
            state: "bound",
            destination: { correlationId: "cw-remote", host: "box", threadId: "thread:remote-a" },
          });
          yield* projectThread("thread:remote-a", [link(13, { state: "open" })]);
          const row = taskRow(yield* current, "turn-1");
          assert.deepStrictEqual(row.pullRequests, [item(12, "open")]);
          assert.isUndefined(row.pullRequestsOmitted);
        }),
      ),
  );

  it.effect(
    "a finished work task shows its threads' merged pull requests, not the copy made while it ran",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* insertTask("work-2", { status: "completed", createdAt: at(2) });
          yield* setWorker("work-2", "thread:worker-2");
          yield* setObserved("work-2", [{ number: 21, state: "open" }]);
          yield* projectThread("thread:worker-2", [link(21, { state: "merged" })]);
          yield* localLaunch("work-2", "launch-b", "completed");
          yield* projectThread("thread:launch-b", [link(22, { state: "merged" })]);
          yield* insertTask("work-none", { status: "completed", createdAt: at(2) });
          const result = yield* current;
          assert.deepStrictEqual(taskRow(result, "work-2").pullRequests, [
            item(22, "merged"),
            item(21, "merged"),
          ]);
          const none = taskRow(result, "work-none");
          assert.isFalse("pullRequests" in none || "pullRequestsOmitted" in none);
        }),
      ),
  );

  it.effect("an open pull request nothing refreshes any more is listed without a state", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        const cases = [
          [
            "settled",
            { settledAt: at(1) },
            [link(31, { state: "open" }), link(32, { state: "merged" })],
          ],
          ["override", { settledOverride: "settled" as const }, [link(33, { state: "open" })]],
          ["archived", { archivedAt: at(1) }, [link(34, { state: "open" })]],
          [
            "deleted",
            { deleted: true as const },
            [link(35, { state: "closed" }), link(36, { state: "open" })],
          ],
          ["refreshed", {}, [link(37, { state: "open" })]],
        ] as const;
        for (const [name, thread, links] of cases) {
          yield* insertTask(name, { status: "completed", createdAt: at(2) });
          yield* setWorker(name, "thread:" + name);
          yield* projectThread("thread:" + name, links, thread);
        }
        // A remote worker's copy is refreshed only while its task runs or waits.
        for (const [name, status] of [
          ["copy-done", "completed"],
          ["copy-live", "running"],
        ] as const) {
          yield* insertTask(name, { status, createdAt: at(2) });
          yield* setWorker(name, "thread:" + name, "box");
          yield* setObserved(name, [{ number: 38, state: "open" }]);
        }
        const result = yield* current;
        const listed = (name: string) => taskRow(result, name).pullRequests;
        assert.deepStrictEqual(listed("settled"), [item(31), item(32, "merged")]);
        assert.deepStrictEqual(listed("override"), [item(33)]);
        assert.deepStrictEqual(listed("archived"), [item(34)]);
        assert.deepStrictEqual(listed("deleted"), [item(36), item(35, "closed")]);
        assert.deepStrictEqual(listed("refreshed"), [item(37, "open")]);
        assert.deepStrictEqual(listed("copy-done"), [{ ...item(38), watching: true }]);
        assert.deepStrictEqual(listed("copy-live"), [{ ...item(38, "open"), watching: true }]);
      }),
    ),
  );

  it.effect(
    "a pull request reopened on a refreshed thread reads open over an archived thread's closed, in either source order",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          for (const [taskId, archivedSide] of [
            ["archived-worker", "worker"],
            ["archived-launch", "launch"],
          ] as const) {
            yield* insertTask(taskId, { status: "completed", createdAt: at(2) });
            yield* setWorker(taskId, "thread:" + taskId + "-worker");
            yield* localLaunch(taskId, taskId + "-launch", "completed");
            for (const side of ["worker", "launch"] as const)
              yield* projectThread(
                "thread:" + taskId + "-" + side,
                [link(71, { state: side === archivedSide ? "closed" : "open" })],
                side === archivedSide ? { archivedAt: at(1) } : {},
              );
          }
          const result = yield* current;
          assert.deepStrictEqual(taskRow(result, "archived-worker").pullRequests, [
            item(71, "open"),
          ]);
          assert.deepStrictEqual(taskRow(result, "archived-launch").pullRequests, [
            item(71, "open"),
          ]);
        }),
      ),
  );

  it.effect("a remote worker's row never takes a local thread's links that share its id", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("local", { status: "completed", createdAt: at(2) });
        yield* setWorker("local", "thread:shared-worker");
        yield* projectThread("thread:shared-worker", [link(21, { state: "merged" })]);
        yield* insertTask("remote", { status: "completed", createdAt: at(2) });
        yield* setWorker("remote", "thread:shared-worker", "box");
        const result = yield* current;
        assert.deepStrictEqual(taskRow(result, "local").pullRequests, [item(21, "merged")]);
        assert.isUndefined(taskRow(result, "remote").pullRequests);
      }),
    ),
  );

  it.effect("caps a row at five pull requests, open first, and counts the rest", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("cap", { status: "running", createdAt: at(2) });
        yield* setWorker("cap", "thread:cap-worker");
        yield* projectThread("thread:cap-worker", [
          link(1, { state: "open" }),
          link(2, { state: "closed" }),
          link(3, { state: "merged" }),
          link(4, { state: "open" }),
          link(8, { state: "open", dismissed: true }),
        ]);
        yield* localLaunch("cap", "cap-launch", "bound");
        yield* projectThread("thread:cap-launch", [
          link(4, { state: "open" }),
          link(5, { state: "open", repo: "goat-si/docs" }),
          link(6),
        ]);
        yield* setObserved("cap", [
          { number: 7, state: "open" },
          { number: 4, state: "open" },
        ]);
        const row = taskRow(yield* current, "cap");
        assert.deepStrictEqual(row.pullRequests, [
          { ...item(7, "open"), watching: true },
          item(5, "open", "goat-si/docs"),
          item(4, "open"),
          item(1, "open"),
          item(6),
        ]);
        assert.strictEqual(row.pullRequestsOmitted, 2);
      }),
    ),
  );

  it.effect("history and lookup rows carry the same pull requests as the current list", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("both", { status: "running", createdAt: at(2) });
        yield* setWorker("both", "thread:both-worker");
        yield* projectThread("thread:both-worker", [link(51, { state: "open" })]);
        yield* localLaunch("both", "both-launch", "bound");
        yield* projectThread("thread:both-launch", [link(52, { state: "merged" })]);
        const expected = [item(51, "open"), item(52, "merged")];
        assert.deepStrictEqual(taskRow(yield* current, "both").pullRequests, expected);
        assert.deepStrictEqual(taskRow(yield* history(), "both").pullRequests, expected);
        const found = yield* lookup("both");
        assert.strictEqual(found.task.state, "known");
        if (found.task.state === "known")
          assert.deepStrictEqual(found.task.row.pullRequests, expected);
      }),
    ),
  );

  it.effect(
    "a worker thread whose stored payload is not JSON leaves every read to the row's other sources",
    () => {
      const log = warnings();
      return provide(
        Effect.gen(function* () {
          yield* setup;
          yield* insertTask("bad-worker", { status: "running", createdAt: at(2) });
          yield* setWorker("bad-worker", "thread:bad-worker");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread:bad-worker', 'project:repo', 'Bad', 'codex', 'full-access', 'default', ${at(5)}, ${at(5)}, 'not json')`;
          yield* setObserved("bad-worker", [{ number: 82, state: "open" }]);
          yield* localLaunch("bad-worker", "good-launch", "bound");
          yield* projectThread("thread:good-launch", [link(81, { state: "open" })]);
          const expected = [{ ...item(82, "open"), watching: true }, item(81, "open")];
          assert.deepStrictEqual(taskRow(yield* current, "bad-worker").pullRequests, expected);
          assert.deepStrictEqual(taskRow(yield* current, "bad-worker").pullRequests, expected);
          assert.lengthOf(
            log.logs.filter((line) => line.includes("thread:bad-worker")),
            1,
          );
          const page = yield* history();
          assert.deepStrictEqual(taskRow(page, "bad-worker").pullRequests, expected);
          assert.strictEqual(page.history?.partial, true);
          const found = yield* lookup("bad-worker");
          assert.strictEqual(found.partial, true);
          if (found.task.state === "known")
            assert.deepStrictEqual(found.task.row.pullRequests, expected);
          else assert.fail("the lookup lost its row");
        }).pipe(Effect.provide(log.layer)),
      );
    },
  );

  it.effect("a thread whose links cannot be read leaves the row to its other sources", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("unreadable", { status: "running", createdAt: at(2) });
        yield* setObserved("unreadable", [{ number: 61, state: "open" }]);
        yield* localLaunch("unreadable", "broken", "bound");
        yield* projectThread("thread:broken", [{ number: "not a number" }]);
        const expected = [{ ...item(61, "open"), watching: true }];
        assert.deepStrictEqual(taskRow(yield* current, "unreadable").pullRequests, expected);
        const page = yield* history();
        assert.deepStrictEqual(taskRow(page, "unreadable").pullRequests, expected);
        assert.strictEqual(page.history?.partial, true);
        assert.strictEqual((yield* lookup("unreadable")).partial, true);
      }),
    ),
  );
});
