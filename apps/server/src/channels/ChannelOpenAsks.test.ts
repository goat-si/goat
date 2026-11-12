import { assert, describe, it } from "@effect/vitest";
import { NodeId, type OrchestrationV2RuntimeRequest, RuntimeRequestId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { openAskCandidates } from "./channelOpenAsks.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { syncNewestAsks } from "./testkit/newestAsks.ts";
import { nextTaskChange, watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  linkSlackUser,
  makeHarness,
  owner,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("approval:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-10-12T00:01:00.000Z"),
  resolvedAt: null,
});

const stranger = { ...owner, ownerId: "environment:stranger" };

/** Starts work from Slack and has its worker wait on the request, as a worker would. */
const startWaiting = (
  harness: ReturnType<typeof makeHarness>,
  text: string,
  key: string,
  pending?: OrchestrationV2RuntimeRequest,
) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const ledger = yield* ChannelLedger.ChannelLedger;
    yield* gateway.ingest(slackInput(text, key), slackContext);
    yield* runtime.drain;
    const tasks = (yield* ledger.listTasks({ ownerId: owner.ownerId, limit: 10 })).tasks;
    const task = tasks.find((each) => text.includes(each.title))!;
    if (pending !== undefined) {
      harness.world.runtimeRequests.set(task.worker!.threadId, [pending]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
    }
    return task;
  });

/** Copies of one waiting task under new ids: each with its own bot, update time and question. */
const copyTask = (
  taskId: string,
  count: number,
  shape: (index: number) => {
    readonly botId: string;
    readonly updatedAt: string;
    readonly askedAt: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TEMP TABLE IF NOT EXISTS task_copy AS SELECT * FROM channel_tasks WHERE 0`;
    for (let index = 0; index < count; index++) {
      const { botId, updatedAt, askedAt } = shape(index);
      const copy = taskId + "-copy-" + index;
      const question = [{ questionId: "q-" + copy, text: "Filler " + index, askedAt }];
      yield* sql`DELETE FROM task_copy`;
      yield* sql`INSERT INTO task_copy SELECT * FROM channel_tasks WHERE task_id = ${taskId}`;
      yield* sql`UPDATE task_copy SET task_id = ${copy}, bot_id = ${botId},
        updated_at = ${updatedAt}, worker_thread_id = NULL,
        task_json = json_set(task_json, '$.taskId', ${copy},
          '$.openQuestions', json(${JSON.stringify(question)}))`;
      yield* sql`INSERT INTO channel_tasks SELECT * FROM task_copy`;
    }
    yield* syncNewestAsks();
  });

/** Puts one question on a task, asked and updated at the given times. */
const askOnce = (taskId: string, text: string, askedAt: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const question = [{ questionId: "q-" + taskId, text, askedAt }];
    yield* sql`UPDATE channel_tasks SET status = 'waiting_input', updated_at = ${updatedAt},
      task_json = json_set(task_json, '$.status', 'waiting_input',
        '$.openQuestions', json(${JSON.stringify(question)}))
      WHERE task_id = ${taskId}`;
    yield* syncNewestAsks();
  });

describe("open asks across bots", () => {
  it.effect("lists a task's open question with its words, for its owner only", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      assert.deepStrictEqual(yield* members.openAsks(owner), {
        asks: [],
        total: 0,
        truncated: false,
      });
      yield* startWaiting(harness, "do: which repo?", "Ev-q");
      const { asks } = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((ask) => [ask.kind, ask.botId]),
        [["question", "main"]],
      );
      assert.isAbove(asks[0]?.text.length ?? 0, 0);
      assert.isDefined(asks[0]?.questionId);
      assert.deepStrictEqual((yield* members.openAsks(stranger)).asks, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("words each approval as its card does, newest first", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* startWaiting(harness, "do: deploy staging", "Ev-1", request("deploy"));
      yield* TestClock.adjust("1 minute");
      yield* startWaiting(harness, "do: drop the cache", "Ev-2", request("cache"));
      const { asks } = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((each) => [each.kind, each.requestId]),
        [
          ["approval", "approval:cache"],
          ["approval", "approval:deploy"],
        ],
      );
      assert.strictEqual(
        asks[1]?.text,
        "deploy staging: the agent wants to run a command.\n" + CHANNEL_COPY.approvalDetailNotShown,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a coding thread's own question shows the words it asked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const pending = request("region", "user_input");
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "region",
          header: "Region",
          question: "Which region should staging use?",
          options: [{ label: "us-east", description: "Virginia" }],
        },
      ]);
      yield* startWaiting(harness, "do: deploy staging", "Ev-n", pending);
      const { asks } = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((ask) => [ask.kind, ask.text]),
        [["question", "Which region should staging use?"]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "lists every wait the bots' badges count: sign-in, a usage limit, and an approval left open on finished work",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* linkSlackUser();
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const since = "2026-10-12T00:02:00.000Z";
        const wait = (taskId: string, status: string, need: object) =>
          sql`UPDATE channel_tasks SET status = ${status},
            task_json = json_set(task_json, '$.status', ${status},
              '$.observed', json(${JSON.stringify({ pullRequests: [], needsYou: [need] })}))
            WHERE task_id = ${taskId}`;
        const login = yield* startWaiting(harness, "do: read the dashboard", "Ev-s");
        const limit = yield* startWaiting(harness, "do: summarize the logs", "Ev-u");
        const done = yield* startWaiting(harness, "do: tag the release", "Ev-a");
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.openQuestions', json('[]'))`;
        yield* wait(login.taskId, "running", { kind: "sign_in", since });
        yield* wait(limit.taskId, "running", { kind: "usage_limit", since });
        yield* wait(done.taskId, "completed", {
          kind: "approval",
          since,
          approval: { requestId: "approval:late", threadId: done.worker!.threadId },
        });
        yield* syncNewestAsks();
        const { asks, total } = yield* members.openAsks(owner);
        assert.deepStrictEqual(
          asks.map((ask) => [ask.taskId, ask.kind]).toSorted(),
          [
            [done.taskId, "approval"],
            [login.taskId, "sign_in"],
            [limit.taskId, "usage_limit"],
          ].toSorted(),
        );
        assert.strictEqual(total, 3);
        // The badge counts the same tasks.
        assert.strictEqual(yield* ledger.countWaitingTasks(owner.ownerId), 3);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("orders by when each ask was made, keeps the newest 50 and counts them all", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const sql = yield* SqlClient.SqlClient;
      const busy = yield* startWaiting(harness, "do: answer many things", "Ev-m");
      const recent = yield* startWaiting(harness, "do: recent work", "Ev-r");
      const questions = Array.from({ length: 51 }, (_, index) => ({
        questionId: "q-" + index,
        text: "Question " + index,
        askedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 9, 12, 1, index))),
      }));
      yield* sql`UPDATE channel_tasks SET status = 'waiting_input', updated_at = '2026-10-12T00:00:00.000Z',
        task_json = json_set(task_json, '$.openQuestions', json(${JSON.stringify(questions)}))
        WHERE task_id = ${busy.taskId}`;
      // Updated last, but asked first: it belongs at the end, not the start.
      yield* sql`UPDATE channel_tasks SET status = 'waiting_input', updated_at = '2026-10-13T00:00:00.000Z',
        task_json = json_set(task_json, '$.openQuestions', json(${JSON.stringify([
          { questionId: "old", text: "Old question", askedAt: "2026-10-11T00:00:00.000Z" },
        ])}))
        WHERE task_id = ${recent.taskId}`;
      yield* syncNewestAsks();
      const result = yield* members.openAsks(owner);
      assert.strictEqual(result.asks.length, 50);
      assert.strictEqual(result.total, 52);
      assert.isFalse(result.truncated);
      assert.strictEqual(result.asks[0]?.text, "Question 50");
      assert.notInclude(
        result.asks.map((ask) => ask.text),
        "Old question",
      );
      // A person who asks for more reaches the rest, oldest last.
      const more = yield* members.openAsks(owner, 100);
      assert.strictEqual(more.asks.length, 52);
      assert.strictEqual(more.total, 52);
      assert.strictEqual(more.asks.at(-1)?.text, "Old question");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("keeps the newest ask when 200 tasks updated later hold older ones", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const newest = yield* startWaiting(harness, "do: newest question", "Ev-newest");
      yield* askOnce(
        newest.taskId,
        "Newest question",
        "2026-10-12T05:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
      yield* copyTask(newest.taskId, 200, () => ({
        botId: "main",
        updatedAt: "2026-10-20T00:00:00.000Z",
        askedAt: "2026-10-12T01:00:00.000Z",
      }));
      const result = yield* members.openAsks(owner);
      assert.strictEqual(result.asks[0]?.text, "Newest question");
      assert.isTrue(result.truncated);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "keeps the newest ask when 200 tasks hold a newer wait that names no question to show",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* linkSlackUser();
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const sql = yield* SqlClient.SqlClient;
        const newest = yield* startWaiting(harness, "do: newest question", "Ev-unnamed");
        yield* askOnce(
          newest.taskId,
          "Newest question",
          "2026-10-12T05:00:00.000Z",
          "2026-10-01T00:00:00.000Z",
        );
        yield* copyTask(newest.taskId, 200, () => ({
          botId: "main",
          updatedAt: "2026-10-20T00:00:00.000Z",
          askedAt: "2026-10-12T01:00:00.000Z",
        }));
        // A native question reported without its request: the list has nothing to show for it.
        const unnamed = {
          pullRequests: [],
          needsYou: [{ kind: "question", since: "2026-10-12T09:00:00.000Z" }],
        };
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.observed',
          json(${JSON.stringify(unnamed)})) WHERE task_id <> ${newest.taskId}`;
        yield* syncNewestAsks();
        const result = yield* members.openAsks(owner);
        assert.strictEqual(result.asks[0]?.text, "Newest question");
        assert.isTrue(result.truncated);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a stored task's newest ask follows its asks and clears when none are left", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const sql = yield* SqlClient.SqlClient;
      const task = yield* startWaiting(harness, "do: deploy staging", "Ev-col", request("col"));
      const stored = () =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly newest_ask_at: string | null }>`
            SELECT newest_ask_at FROM channel_tasks WHERE task_id = ${task.taskId}`;
          return {
            column: row?.newest_ask_at ?? null,
            task: (yield* ledger.getTask(task.taskId))!,
          };
        });
      const approval = yield* stored();
      const since = approval.task.task.observed?.needsYou[0]?.since;
      assert.isDefined(since);
      assert.strictEqual(approval.column, since);

      const askedAt = "2026-10-12T03:00:00.000Z";
      yield* commitTransition(ledger, approval.task, {
        type: "task.question.opened",
        payload: { question: { questionId: "q-col" as never, text: "Which region?", askedAt } },
      });
      assert.strictEqual((yield* stored()).column, askedAt);

      yield* commitTransition(ledger, (yield* stored()).task, {
        type: "task.question.answered",
        payload: { questionId: "q-col" as never, answer: "us-east" },
      });
      assert.strictEqual((yield* stored()).column, since);

      harness.world.runtimeRequests.set(task.worker!.threadId, []);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const resolved = yield* stored();
      assert.deepStrictEqual(resolved.task.task.observed?.needsYou, []);
      assert.isNull(resolved.column);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads its candidates newest first from the newest ask index, without a sort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const botIds of [["main"], ["main", "helper"]]) {
        const candidates = openAskCandidates(sql, {
          ownerId: owner.ownerId,
          botIds: new Set(botIds),
        });
        const plan = (yield* sql<{
          readonly detail: string;
        }>`EXPLAIN QUERY PLAN ${candidates}`).map((row) => row.detail);
        assert.isTrue(
          plan.some((detail) => detail.includes("USING INDEX channel_tasks_owner_newest_ask")),
          plan.join("\n"),
        );
        assert.isFalse(
          plan.some((detail) => detail.includes("TEMP B-TREE")),
          plan.join("\n"),
        );
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a deleted bot's tasks out before counting toward the limit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const live = yield* startWaiting(harness, "do: live question", "Ev-live");
      yield* askOnce(
        live.taskId,
        "Live question",
        "2026-10-12T00:30:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
      yield* copyTask(live.taskId, 200, () => ({
        botId: "gone-bot",
        updatedAt: "2026-10-20T00:00:00.000Z",
        askedAt: "2026-10-12T04:00:00.000Z",
      }));
      const result = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        result.asks.map((ask) => ask.text),
        ["Live question"],
      );
      assert.strictEqual(result.total, 1);
      assert.isFalse(result.truncated);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("telling a mounted list that asks changed", () => {
  it.effect(
    "a new task and a worker that starts waiting each give its owner a revision, and no one else",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* linkSlackUser();
        const mine = yield* watchTaskChanges(owner);
        const theirs = yield* watchTaskChanges(stranger);
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(slackInput("do: fix the build", "changes-1"), slackContext);
        yield* runtime.drain;
        assert.isAbove(yield* nextTaskChange(mine), 0);
        const [task] = (yield* ledger.listTasks({ ownerId: owner.ownerId, limit: 10 })).tasks;
        harness.world.runtimeRequests.set(task!.worker!.threadId, [request("changes")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.isAbove(yield* nextTaskChange(mine), 1);
        yield* TestClock.adjust(Duration.seconds(5));
        assert.isTrue(Option.isNone(yield* Queue.poll(theirs)));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("archiving and restoring a bot give its owner a revision", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* members.create(
        {
          clientRequestId: "changes-bot",
          name: "Helper",
          avatar: null,
          purpose: "",
          defaultModelSelection: null,
        },
        owner,
      );
      const seen = yield* watchTaskChanges(owner);
      yield* members.remove({ botId: bot.botId }, owner);
      assert.strictEqual(yield* nextTaskChange(seen), 1);
      yield* members.restore({ botId: bot.botId }, owner);
      assert.strictEqual(yield* nextTaskChange(seen), 2);
    }).pipe(Effect.provide(harness.layer));
  });
});
