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
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
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
      assert.strictEqual(asks[1]?.text, "deploy staging: the agent wants to run a command.");
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
      const result = yield* members.openAsks(owner);
      assert.strictEqual(result.asks.length, 50);
      assert.strictEqual(result.total, 52);
      assert.isFalse(result.truncated);
      assert.strictEqual(result.asks[0]?.text, "Question 50");
      assert.notInclude(
        result.asks.map((ask) => ask.text),
        "Old question",
      );
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
