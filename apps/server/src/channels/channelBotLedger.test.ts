// @effect-diagnostics nodeBuiltinImport:off -- the restart test reopens a SQLite file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  ChannelInboundMessage,
  ChannelReceptionId,
  ChannelRequester,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { botProfileKey, mainBotKey, memberBotKey } from "./channelBotLedger.ts";
import { bindingIdFor, contentHashFor, conversationIdFor, inputIdFor } from "./channelIds.ts";
import { TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";
import { makeCreatedTasks } from "./channelTaskWrites.ts";
import { syncNewestAsks } from "./testkit/newestAsks.ts";
import { nextTaskChange, watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  botThreadId,
  defaultScript,
  environmentId as harnessEnvironment,
  goatInput,
  makeHarness,
  modelSelection,
  owner,
  ownerId as harnessOwner,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const NOW = "2026-11-07T00:00:00.000Z";
const MEMBER = BotId.make("m1abcdefghij");
const MAIN = BotId.make("main");
const memberThread = ThreadId.make("thread:member-bot");
const environmentId = EnvironmentId.make("environment:bot-ledger-test");
const ref = (threadId: ThreadId) => ({
  environmentId,
  projectId: ProjectId.make("project:bots"),
  threadId,
});
const TestLayer = ChannelLedger.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const requester = Schema.decodeSync(ChannelRequester)({
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "goat",
  runtimeModeCeiling: "full-access",
  grantedScopes: ["orchestration:read", "orchestration:operate"],
});

const decodeMessage = Schema.decodeSync(ChannelInboundMessage);
const goatMessage = (key: string, threadId: ThreadId, text = "check the build") =>
  decodeMessage({
    kind: "goat",
    connectionId: "goat",
    conversationKey: threadId,
    externalMessageId: key,
    idempotencyKey: key,
    actor: {},
    replyAddress: { kind: "goat", environmentId, threadId },
    text,
    attachments: [],
    receivedAt: NOW,
    intent: "message",
  });

/** Stores a GOAT message for a bot, as the gateway does once it has resolved the bot. */
const acceptFor = (
  botId: BotId,
  key: string,
  threadId: ThreadId,
  ownerId = "owner",
  text?: string,
) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const sql = yield* SqlClient.SqlClient;
    // The ledger stores a member's input only while the member is active.
    if (botId !== MAIN) {
      const profile = { botId, role: "member", state: "active" };
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${botProfileKey(ownerId, botId)}, ${JSON.stringify(profile)}, ${NOW})
        ON CONFLICT (key) DO NOTHING`;
    }
    const message = goatMessage(key, threadId, text);
    const conversationId = conversationIdFor({ ownerId, ...message });
    return yield* ledger.acceptInput({
      ownerId,
      inputId: inputIdFor({ ownerId, ...message }),
      conversationId,
      bindingId: bindingIdFor(conversationId, threadId),
      message,
      contentHash: contentHashFor(message),
      requester: { ...requester, ownerId },
      acceptedAt: NOW,
      botId,
    });
  });

const createdTaskFor = (accepted: { inputId: string; conversationId: string; bindingId: string }) =>
  makeCreatedTasks({
    action: { type: "run_turn", title: "Check the build", instruction: "check the build" },
    inputId: accepted.inputId as never,
    conversationId: accepted.conversationId as never,
    originBindingId: accepted.bindingId as never,
    originAddress: { kind: "goat", environmentId, threadId: memberThread },
    requester,
    now: NOW,
  })[0]!;

const receive = (inputId: string, createdTask: ReturnType<typeof createdTaskFor>) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const receptionId = ChannelReceptionId.make("reception");
    const owner = "test-owner";
    yield* ledger.claimOwnership({ token: owner, now: NOW, staleBefore: NOW });
    yield* ledger.beginReception({ owner, inputId: inputId as never, receptionId, readAt: NOW });
    return yield* ledger.completeReception({
      owner,
      inputId: inputId as never,
      receptionId,
      replyText: "On it.",
      decision: { replyText: "On it.", action: { type: "report_only" } },
      createdTask,
      deliveries: [],
      now: NOW,
    });
  });

describe("channel tasks keep their bot", () => {
  it.effect("a task carries its input's bot, and both still do after a restart", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-bot-ids-"));
      const layer = ChannelLedger.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerFromPath(NodePath.join(dir, "state.sqlite"))),
        Layer.provide(NodeServices.layer),
      );
      try {
        const ids = yield* Effect.gen(function* () {
          const member = yield* acceptFor(MEMBER, "member-1", memberThread);
          const main = yield* acceptFor(MAIN, "main-1", ThreadId.make("thread:main-bot"));
          const memberTask = createdTaskFor(member);
          const mainTask = createdTaskFor(main);
          yield* receive(member.inputId, memberTask);
          yield* receive(main.inputId, mainTask);
          return { member, main, memberTask: memberTask.task, mainTask: mainTask.task };
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const ledger = yield* ChannelLedger.ChannelLedger;
          assert.strictEqual((yield* ledger.getInput(ids.member.inputId))?.botId, MEMBER);
          assert.strictEqual((yield* ledger.getTask(ids.memberTask.taskId))?.botId, MEMBER);
          assert.strictEqual((yield* ledger.getInput(ids.main.inputId))?.botId, MAIN);
          assert.strictEqual((yield* ledger.getTask(ids.mainTask.taskId))?.botId, MAIN);
        }).pipe(Effect.provide(layer));
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "refuses a task whose input belongs to another owner, keeping the input as it was",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const mine = yield* acceptFor(MAIN, "mine", memberThread);
        const theirs = yield* acceptFor(MAIN, "theirs", memberThread, "other-owner");
        const error = yield* Effect.flip(receive(mine.inputId, createdTaskFor(theirs)));
        assert.strictEqual(error.reason, "persistence");
        assert.strictEqual((yield* ledger.getInput(mine.inputId))?.snapshot.state, "processing");
        assert.isUndefined(yield* ledger.getTask(createdTaskFor(theirs).task.taskId));
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("returns member tasks an older build created as main, and touches nothing else", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const member = yield* acceptFor(MEMBER, "before-downgrade", memberThread);
      const { task } = createdTaskFor(member);
      const json = JSON.stringify(task);
      // The older build's own statements: they name their columns and never bot_id.
      yield* sql`UPDATE channel_inbox SET state = 'processing', reception_id = 'old',
        read_at = COALESCE(read_at, ${NOW}) WHERE input_id = ${member.inputId}
        AND state IN ('accepted', 'processing')`;
      yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
        generation, task_json, created_at, updated_at)
        VALUES (${task.taskId}, 'owner', ${task.conversationId}, 'received', 1, 1, ${json},
        ${NOW}, ${NOW})`;
      yield* sql`UPDATE channel_inbox SET state = 'replied', decision_json = '{}',
        reply_json = '{"text":"On it."}', task_ids_json = ${JSON.stringify([task.taskId])}
        WHERE input_id = ${member.inputId} AND state = 'processing' AND reception_id = 'old'`;
      yield* sql`UPDATE channel_tasks SET status = 'completed', version = 2, generation = 1,
        worker_thread_id = NULL, task_json = ${json}, updated_at = ${NOW},
        pending_answer_message_id = pending_answer_message_id, completion_hold = completion_hold
        WHERE task_id = ${task.taskId} AND version = 1`;
      // Its result went to the main bot's chat and was recorded as delivered there.
      yield* sql`INSERT INTO channel_outbox (delivery_id, cause_key, input_id, task_id, kind,
        destination_kind, message_json, state, attempts, next_attempt_at, created_at, updated_at)
        VALUES ('d1', 'result:old', ${member.inputId}, ${task.taskId}, 'result', 'goat', '{}',
        'delivered', 1, ${NOW}, ${NOW}, ${NOW})`;
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MAIN);
      const inboxBefore = yield* sql`SELECT * FROM channel_inbox ORDER BY input_id`;
      const outboxBefore = yield* sql`SELECT * FROM channel_outbox ORDER BY delivery_id`;
      // A mounted list hears that the owner's tasks moved to another bot.
      const seen = yield* Queue.unbounded<number>();
      yield* ledger.taskChangeRevisions("owner").pipe(
        Stream.runForEach((revision) => Queue.offer(seen, revision)),
        Effect.forkChild,
      );
      assert.strictEqual(yield* Queue.take(seen), 0);

      assert.strictEqual(yield* ledger.repairTaskBots(), 1);
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(seen), 1);
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MEMBER);
      assert.strictEqual(yield* ledger.repairTaskBots(), 0);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM channel_inbox ORDER BY input_id`,
        inboxBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM channel_outbox ORDER BY delivery_id`,
        outboxBefore,
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("bot records", () => {
  it.effect("keep members and main bots of look-alike owners apart", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const member = { bot: ref(memberThread), ownerId: "a", botId: "b" };
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${memberBotKey("a", "b")}, ${JSON.stringify(member)}, ${NOW})`;
      for (const ownerId of ["a:b", "member:a"]) {
        yield* ledger.setBotIfAbsent({
          ownerId,
          bot: ref(ThreadId.make("main:" + ownerId)),
          now: NOW,
        });
      }
      assert.strictEqual(
        (yield* ledger.getBotById("a", BotId.make("b")))?.bot.threadId,
        memberThread,
      );
      assert.isUndefined(yield* ledger.getBotById("a:b", BotId.make("b")));
      assert.strictEqual((yield* ledger.getBot("a:b"))?.bot.threadId, "main:a:b");
      assert.strictEqual((yield* ledger.getBot("member:a"))?.bot.threadId, "main:member:a");
      assert.isUndefined(yield* ledger.getBot("a"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuse an untrimmed owner and a member row under a main key", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const bot = ref(ThreadId.make("thread:main"));
      for (const ownerId of [" a", "a ", ""]) {
        assert.isTrue((yield* Effect.exit(ledger.getBot(ownerId)))._tag === "Failure");
        assert.isTrue(
          (yield* Effect.exit(ledger.setBotIfAbsent({ ownerId, bot, now: NOW })))._tag ===
            "Failure",
        );
        assert.isTrue(
          (yield* Effect.exit(
            ledger.replaceBot({ ownerId, previousThreadId: bot.threadId, bot, now: NOW }),
          ))._tag === "Failure",
        );
      }
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${mainBotKey("x")}, ${JSON.stringify({ bot, ownerId: "x", botId: "y" })}, ${NOW})`;
      assert.isTrue((yield* Effect.exit(ledger.getBot("x")))._tag === "Failure");
    }).pipe(Effect.provide(TestLayer)),
  );
});

/** A member's input whose task an older build created as main. */
const downgradedMemberTask = (
  ownerId: string,
  botId = MEMBER,
  status: "completed" | "running" = "completed",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const member = yield* acceptFor(botId, "older-build", memberThread, ownerId);
    const { task } = createdTaskFor(member);
    yield* sql`UPDATE channel_inbox SET state = 'replied',
      task_ids_json = ${JSON.stringify([task.taskId])} WHERE input_id = ${member.inputId}`;
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
      generation, task_json, created_at, updated_at)
      VALUES (${task.taskId}, ${ownerId}, ${task.conversationId}, ${status}, 1, 1,
      ${JSON.stringify({ ...task, status })}, ${NOW}, ${NOW})`;
    return task;
  });

describe("channel runtime after a downgrade", () => {
  it.effect(
    "fails repair on a malformed referenced task then reports partial after a successful repair",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const threads = yield* ChannelBotThreads.ChannelBotThreads;
        const bot = yield* members.create(
          {
            clientRequestId: "malformed-repair",
            name: "Helper",
            avatar: null,
            purpose: "Checks builds.",
            defaultModelSelection: null,
          },
          owner,
        );
        const task = yield* downgradedMemberTask(harnessOwner, bot.botId, "running");
        yield* sql`UPDATE channel_tasks SET task_json = '{' WHERE task_id = ${task.taskId}`;
        const refused = yield* Effect.flip(
          threads.searchBotTasks({ botId: bot.botId, query: task.title }, owner),
        );
        assert.strictEqual(refused.reason, "persistence_failed");
        yield* sql`UPDATE channel_tasks SET task_json = ${JSON.stringify({ ...task, status: "running", kind: "work" })} WHERE task_id = ${task.taskId}`;
        const repaired = yield* threads.searchBotTasks(
          { botId: bot.botId, query: task.title },
          owner,
        );
        assert.isTrue(repaired.tasks.some((row) => row.taskId === task.taskId));
        yield* sql`UPDATE channel_tasks SET task_json = '{' WHERE task_id = ${task.taskId}`;
        const partial = yield* threads.searchBotTasks(
          { botId: bot.botId, query: task.title },
          owner,
        );
        assert.strictEqual(partial.partial, true);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "repairs member ownership before bot task lookup and search and fails closed on repair errors",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const threads = yield* ChannelBotThreads.ChannelBotThreads;
        const bot = yield* members.create(
          {
            clientRequestId: "lookup-repair",
            name: "Helper",
            avatar: null,
            purpose: "Checks builds.",
            defaultModelSelection: null,
          },
          owner,
        );
        const task = yield* downgradedMemberTask(harnessOwner, bot.botId, "running");
        yield* sql`UPDATE channel_tasks SET task_json = json_remove(task_json, '$.kind') WHERE task_id = ${task.taskId}`;
        yield* sql`CREATE TRIGGER hold_lookup_repair BEFORE UPDATE OF bot_id ON channel_tasks BEGIN SELECT RAISE(ABORT, 'repair held'); END`;
        const byId = yield* Effect.flip(
          threads.getBotTask({ taskId: task.taskId, botId: bot.botId }, owner),
        );
        const search = yield* Effect.flip(
          threads.searchBotTasks({ botId: bot.botId, query: task.title }, owner),
        );
        assert.strictEqual(byId.reason, "persistence_failed");
        assert.strictEqual(search.reason, "persistence_failed");
        yield* sql`DROP TRIGGER hold_lookup_repair`;
        const found = yield* threads.getBotTask({ taskId: task.taskId, botId: bot.botId }, owner);
        assert.strictEqual(found.task.state, "known");
        const page = yield* threads.searchBotTasks({ botId: bot.botId, query: task.title }, owner);
        assert.isTrue(page.tasks.some((row) => row.taskId === task.taskId));
        const wrongBot = yield* Effect.flip(
          threads.getBotTask({ taskId: task.taskId, botId: MAIN }, owner),
        );
        assert.strictEqual(wrongBot.reason, "not_found");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does no work until member tasks are back with their bots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const task = yield* downgradedMemberTask(rpcContext.ownerId);
      yield* sql`CREATE TRIGGER hold_repair BEFORE UPDATE OF bot_id ON channel_tasks
        BEGIN SELECT RAISE(ABORT, 'repair held'); END`;
      const waiting = yield* gateway.ingest(goatInput("hello", "after-upgrade"), rpcContext);

      assert.isFalse(yield* runtime.claimForWork);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getInput(waiting.inputId))?.snapshot.state, "accepted");
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MAIN);

      yield* sql`DROP TRIGGER hold_repair`;
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MEMBER);
      assert.strictEqual((yield* ledger.getInput(waiting.inputId))?.snapshot.state, "replied");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("bot lists and deletes wait until member tasks are back with their bots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const botThreads = yield* ChannelBotThreads.ChannelBotThreads;
      const bot = yield* members.create(
        {
          clientRequestId: "downgraded",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const task = yield* downgradedMemberTask(harnessOwner, bot.botId, "running");
      const tasksOf = (botId: BotId) =>
        ledger
          .listTasks({ ownerId: harnessOwner, botId, limit: 10 })
          .pipe(Effect.map((page) => page.tasks.map((stored) => stored.taskId)));
      yield* sql`CREATE TRIGGER hold_repair BEFORE UPDATE OF bot_id ON channel_tasks
        BEGIN SELECT RAISE(ABORT, 'repair held'); END`;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(tasksOf(MAIN))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(ledger.countWaitingTasks(harnessOwner, undefined))),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(botThreads.list(owner))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(members.remove({ botId: bot.botId }, owner))),
      );
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MAIN);

      yield* sql`DROP TRIGGER hold_repair`;
      assert.deepStrictEqual(yield* tasksOf(MAIN), []);
      assert.deepStrictEqual(yield* tasksOf(bot.botId), [task.taskId]);
      const busy = yield* Effect.flip(members.remove({ botId: bot.botId }, owner));
      assert.strictEqual(busy.reason, "bot_busy");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("archiving a bot tells every owner whose tasks its repair moved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* members.create(
        {
          clientRequestId: "archive-repairs-others",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const elsewhere = "environment:elsewhere";
      const theirs = yield* downgradedMemberTask(elsewhere);
      const seen = yield* watchTaskChanges({ ownerId: elsewhere });
      yield* members.remove({ botId: bot.botId }, owner);
      assert.strictEqual((yield* ledger.getTask(theirs.taskId))?.botId, MEMBER);
      assert.strictEqual(yield* nextTaskChange(seen), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("open asks are read after the repair, under the bot that asked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* members.create(
        {
          clientRequestId: "asks-after-repair",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const task = yield* downgradedMemberTask(harnessOwner, bot.botId, "running");
      const question = [{ questionId: "q-repair", text: "Which repo?", askedAt: NOW }];
      yield* sql`UPDATE channel_tasks SET status = 'waiting_input',
        task_json = json_set(task_json, '$.status', 'waiting_input',
          '$.openQuestions', json(${JSON.stringify(question)}))
        WHERE task_id = ${task.taskId}`;
      yield* syncNewestAsks();
      const { asks } = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((ask) => [ask.taskId, ask.botId]),
        [[task.taskId, bot.botId]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a refused delete that ran the repair first leaves the next reads repairing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* members.create(
        {
          clientRequestId: "downgraded-delete-first",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const task = yield* downgradedMemberTask(harnessOwner, bot.botId, "running");

      const busy = yield* Effect.flip(members.remove({ botId: bot.botId }, owner));
      assert.strictEqual(busy.reason, "bot_busy");
      const page = yield* ledger.listTasks({ ownerId: harnessOwner, botId: bot.botId, limit: 10 });
      assert.deepStrictEqual(
        page.tasks.map((stored) => stored.taskId),
        [task.taskId],
      );
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, bot.botId);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("member bot deliveries before members can be created", () => {
  /** A member bot as 040b will store it: its own session thread, ref and profile. */
  const seedMember = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-member-bot"),
      threadId: memberThread,
      projectId: scratchProjectId,
      title: "Helper",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    const bot = {
      environmentId: harnessEnvironment,
      projectId: scratchProjectId,
      threadId: memberThread,
    };
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
      ${memberBotKey(harnessOwner, MEMBER)}, ${JSON.stringify({ bot, ownerId: harnessOwner, botId: MEMBER })},
      ${NOW})`;
    const profile = {
      botId: MEMBER,
      role: "member",
      name: "Helper",
      avatar: null,
      purpose: "Checks builds.",
      defaultModelSelection: null,
      defaultProjectId: null,
      environmentId: harnessEnvironment,
      sessionThreadId: memberThread,
      createdAt: NOW,
      updatedAt: NOW,
    };
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES (
      ${"bot-profile:" + encodeURIComponent(harnessOwner) + ":" + MEMBER}, ${JSON.stringify(profile)},
      ${NOW})`;
  });

  const threadText = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const records = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"]);
      return {
        texts: records.messages.map((message) => message.text),
        cards: records.turnItems.flatMap((item) =>
          item.type === "notification" && item.ledgerTask ? [item.ledgerTask.taskId] : [],
        ),
      };
    });

  it.effect("a reply and a task card for a member's input land in the member's thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* seedMember;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* acceptFor(MEMBER, "member-hello", memberThread, harnessOwner, "hello");
      yield* acceptFor(MEMBER, "member-task", memberThread, harnessOwner, "do: check the build");
      yield* runtime.drain;

      const page = yield* ledger.listTasks({ ownerId: harnessOwner, limit: 10 });
      assert.lengthOf(page.tasks, 1);
      const taskId = page.tasks[0]!.taskId;
      assert.strictEqual((yield* ledger.getTask(taskId))?.botId, MEMBER);
      const member = yield* threadText(memberThread);
      const main = yield* threadText(botThreadId);
      assert.include(member.texts, "Okay.");
      assert.include(member.cards, taskId);
      assert.notInclude(main.texts, "Okay.");
      assert.notInclude(main.cards, taskId);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("background channel runtime after a downgrade", () => {
  it.effect("starts no reception until a heartbeat finds member tasks repaired", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const task = yield* downgradedMemberTask(harnessOwner);
      yield* sql`CREATE TRIGGER hold_repair BEFORE UPDATE OF bot_id ON channel_tasks
        BEGIN SELECT RAISE(ABORT, 'repair held'); END`;
      const receiving = yield* Deferred.make<void>();
      harness.script.current = (input) =>
        Deferred.succeed(receiving, undefined).pipe(Effect.andThen(defaultScript(input)));
      const waiting = yield* gateway.ingest(goatInput("hello", "background"), rpcContext);

      yield* Layer.build(ChannelRuntime.layerBackground);
      yield* TestClock.adjust("15 seconds");
      assert.isFalse(yield* Deferred.isDone(receiving));
      assert.strictEqual((yield* ledger.getInput(waiting.inputId))?.snapshot.state, "accepted");

      yield* sql`DROP TRIGGER hold_repair`;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(receiving);
      yield* runtime.settle([waiting.inputId]);
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.botId, MEMBER);
      assert.strictEqual((yield* ledger.getInput(waiting.inputId))?.snapshot.state, "replied");
    }).pipe(Effect.provide(harness.layer));
  });
});
