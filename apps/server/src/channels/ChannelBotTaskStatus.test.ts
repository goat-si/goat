import { assert, describe, it } from "@effect/vitest";
import { BotId, type ChannelTaskId, CommandId, MessageId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AttachmentLifecycle from "../assets/AttachmentLifecycle.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { botActiveTasksStatement } from "./channelWaitingTasks.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  botThreadId,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const stranger = { ...owner, ownerId: "environment:stranger" };
const SINCE = "2026-11-07T00:00:00.000Z";

const createMember = (key: string) =>
  Effect.gen(function* () {
    const bot = yield* (yield* ChannelBotMembers.ChannelBotMembers).create(
      {
        clientRequestId: key,
        name: "Helper",
        avatar: null,
        purpose: "Checks builds.",
        defaultModelSelection: null,
      },
      owner,
    );
    // The harness records launches without creating threads; a real launch creates the thread.
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:" + bot.sessionThreadId),
      threadId: bot.sessionThreadId,
      projectId: scratchProjectId,
      title: "Member",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    return bot;
  });

/** The person sends a task in a bot's chat; returns the task once the runtime has dispatched it. */
const startTask = (threadId: ThreadId, botId: BotId, title: string, key: string) =>
  Effect.gen(function* () {
    yield* ThreadMessageIntake.dispatchCommand(
      {
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId,
        messageId: MessageId.make(key + "-message"),
        text: "do: " + title,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      },
      owner,
    ).pipe(Effect.provide(AttachmentLifecycle.layerFiles));
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const { tasks } = yield* ledger.listTasks({ ownerId, botId, limit: 20 });
    const task = tasks.find((each) => each.title === title);
    assert.isDefined(task);
    return task!;
  });

const statusOf = (botId?: BotId, who = owner) =>
  ChannelBotRegistry.ChannelBotRegistry.pipe(
    Effect.flatMap((registry) => registry.status(who, botId)),
  );

const ledgerStatus = (taskId: ChannelTaskId) =>
  ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) => ledger.getTask(taskId)),
    Effect.map((stored) => stored?.task.status),
  );

/** Rewrites a task's stored status and what its worker reported, as an observation would. */
const shapeTask = (
  taskId: string,
  shape: {
    readonly status: string;
    readonly observed?: object | null;
    readonly openQuestions?: ReadonlyArray<object>;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const withObserved =
      shape.observed === undefined || shape.observed === null
        ? sql`json_remove(task_json, '$.observed')`
        : sql`json_set(task_json, '$.observed', json(${JSON.stringify(shape.observed)}))`;
    yield* sql`UPDATE channel_tasks SET status = ${shape.status},
      task_json = json_set(${withObserved}, '$.status', ${shape.status},
        '$.openQuestions', json(${JSON.stringify(shape.openQuestions ?? [])}))
      WHERE task_id = ${taskId}`;
  });

const observed = (fields: object) => ({ pullRequests: [], needsYou: [], ...fields });
const need = (kind: string, extra: object = {}) => ({ kind, since: SINCE, ...extra });

const projectionUpdatedAt = (threadId: ThreadId) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly updated_at: string }>`
        SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`,
    ),
    Effect.map((rows) => rows[0]?.updated_at),
  );

/** The status the newest chip of each task in a thread says. */
const chipStatuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"]);
    const newest = new Map<string, { readonly version: number; readonly status: string }>();
    for (const item of turnItems) {
      if (item.type !== "notification" || item.ledgerTask === undefined) continue;
      const chip = item.ledgerTask;
      const previous = newest.get(chip.taskId);
      if (previous === undefined || chip.taskVersion > previous.version) {
        newest.set(chip.taskId, { version: chip.taskVersion, status: chip.status });
      }
    }
    return new Map([...newest].map(([taskId, chip]) => [taskId, chip.status]));
  });

const finishWork = (harness: ReturnType<typeof makeHarness>, taskId: string) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const task = (yield* ledger.getTask(taskId as never))?.task;
    harness.world.setStatus(task!.worker!.threadId, 1, "completed", "Done.");
    yield* (yield* ChannelWorkerReports.ChannelWorkerReports).reconcile(runtime.ownerToken);
    yield* runtime.drain;
  });

describe("bot status tasks", () => {
  it.effect(
    "a member's status says its task is going while it runs and not after it ends; the main bot is unaffected",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const member = yield* createMember("working");
        assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: false });
        const task = yield* startTask(
          member.sessionThreadId,
          member.botId,
          "check the build",
          "w-1",
        );
        assert.strictEqual(yield* ledgerStatus(task.taskId), "running");
        assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: true });
        assert.deepStrictEqual((yield* statusOf()).tasks, { active: false });

        yield* finishWork(harness, task.taskId);
        assert.strictEqual(yield* ledgerStatus(task.taskId), "completed");
        assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: false });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a visited task still blocked on the person is neither waiting nor working", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* createMember("blocked");
      const task = yield* startTask(member.sessionThreadId, member.botId, "deploy", "b-1");
      yield* shapeTask(task.taskId, {
        status: "running",
        observed: observed({ needsYou: [need("approval")] }),
      });
      assert.strictEqual((yield* statusOf(member.botId)).waitingCount, 1);
      assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: false });
      yield* TestClock.adjust("1 minute");
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.visit",
        commandId: CommandId.make("visit-blocked"),
        threadId: member.sessionThreadId,
        visitedAt: "2026-11-08T00:00:00.000Z",
      });
      const visited = yield* statusOf(member.botId);
      assert.strictEqual(visited.waitingCount, 0);
      assert.deepStrictEqual(visited.tasks, { active: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a going task is active only when the chat would not say it waits on the person (activity.ts attention)",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const member = yield* createMember("branches");
        const task = yield* startTask(member.sessionThreadId, member.botId, "the branches", "a-1");
        const cases: ReadonlyArray<readonly [string, Parameters<typeof shapeTask>[1], boolean]> = [
          ["running with no observation", { status: "running", observed: null }, true],
          ["running with nothing asked", { status: "running", observed: observed({}) }, true],
          ["received", { status: "received", observed: null }, true],
          ["dispatching", { status: "dispatching", observed: null }, true],
          [
            'has("approval"): Waiting for your approval',
            { status: "running", observed: observed({ needsYou: [need("approval")] }) },
            false,
          ],
          [
            'has("question"): a native question, Waiting for your answer',
            { status: "running", observed: observed({ needsYou: [need("question")] }) },
            false,
          ],
          [
            "openQuestionCount > 0: Waiting for your answer",
            {
              status: "running",
              observed: null,
              openQuestions: [{ questionId: "q-1", text: "Which repo?", askedAt: SINCE }],
            },
            false,
          ],
          [
            'has("sign_in"): Waiting for you to sign in',
            { status: "running", observed: observed({ needsYou: [need("sign_in")] }) },
            false,
          ],
          [
            'has("usage_limit"): Paused on a usage limit',
            { status: "running", observed: observed({ needsYou: [need("usage_limit")] }) },
            false,
          ],
          [
            "usageLimitResetAt with no need: an automatic pause, Paused on a usage limit",
            { status: "running", observed: observed({ usageLimitResetAt: SINCE }) },
            false,
          ],
          [
            'status === "waiting_input": Waiting for you',
            { status: "waiting_input", observed: null },
            false,
          ],
        ];
        for (const [name, shape, active] of cases) {
          yield* shapeTask(task.taskId, shape);
          assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active }, name);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("the main bot's tasks are its owner's alone, though main is one bot id for all", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* startTask(botThreadId, BotId.make("main"), "count the stars", "o-1");
      assert.deepStrictEqual((yield* statusOf()).tasks, { active: true });
      assert.deepStrictEqual((yield* statusOf(undefined, stranger)).tasks, { active: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a retried task is active again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const member = yield* createMember("retry");
      const task = yield* startTask(member.sessionThreadId, member.botId, "retry it", "r-1");
      yield* finishWork(harness, task.taskId);
      assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: false });
      const stored = (yield* ledger.getTask(task.taskId))!;
      yield* commitTransition(ledger, stored, {
        type: "task.retry.requested",
        payload: { generation: stored.task.generation + 1 },
      });
      assert.deepStrictEqual((yield* statusOf(member.botId)).tasks, { active: true });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "each task start and end moves the member conversation with a chip of the new status",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const member = yield* createMember("fresh");
        const thread = member.sessionThreadId;
        const before = yield* projectionUpdatedAt(thread);
        const mainBefore = yield* projectionUpdatedAt(botThreadId);
        const mainChips = yield* chipStatuses(botThreadId);

        yield* TestClock.adjust("1 minute");
        const task = yield* startTask(thread, member.botId, "fresh work", "f-1");
        assert.strictEqual((yield* chipStatuses(thread)).get(task.taskId), "running");
        const started = yield* projectionUpdatedAt(thread);
        assert.isTrue(started! > before!, started + " after " + before);

        yield* TestClock.adjust("1 minute");
        const stored = (yield* ledger.getTask(task.taskId))!;
        yield* commitTransition(ledger, stored, {
          type: "task.failed",
          payload: { generation: stored.task.generation, reason: "The build broke." },
        });
        yield* runtime.drain;
        assert.strictEqual((yield* chipStatuses(thread)).get(task.taskId), "failed");
        const ended = yield* projectionUpdatedAt(thread);
        assert.isTrue(ended! > started!, ended + " after " + started);

        assert.strictEqual(yield* projectionUpdatedAt(botThreadId), mainBefore);
        assert.deepStrictEqual(yield* chipStatuses(botThreadId), mainChips);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("reads one bot's going tasks through the owner, bot and status index alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statement = botActiveTasksStatement(sql, { ownerId, botId: BotId.make("main") });
      const plan = (yield* sql<{
        readonly detail: string;
      }>`EXPLAIN QUERY PLAN ${statement}`).map((row) => row.detail);
      const lines = plan.join("\n");
      const tasks = plan.filter((detail) => detail.includes("channel_tasks"));
      assert.lengthOf(tasks, 1, lines);
      assert.strictEqual(
        tasks[0],
        "SEARCH channel_tasks USING INDEX channel_tasks_owner_bot_status (owner_id=? AND bot_id=? AND status=?)",
        lines,
      );
      // The outer SELECT EXISTS has no table; SQLite prints it as SCAN CONSTANT ROW.
      assert.isFalse(
        plan.some((detail) => detail.startsWith("SCAN") && detail !== "SCAN CONSTANT ROW"),
        lines,
      );
      assert.isFalse(
        plan.some((detail) => detail.includes("TEMP B-TREE")),
        lines,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
