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
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { mainBotKey, memberBotKey } from "./channelBotLedger.ts";
import { bindingIdFor, contentHashFor, conversationIdFor, inputIdFor } from "./channelIds.ts";
import { makeCreatedTasks } from "./channelTaskWrites.ts";
import { goatInput, makeHarness, rpcContext, setupBot } from "./testkit/ChannelHarness.ts";

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
const goatMessage = (key: string, threadId: ThreadId) =>
  decodeMessage({
    kind: "goat",
    connectionId: "goat",
    conversationKey: threadId,
    externalMessageId: key,
    idempotencyKey: key,
    actor: {},
    replyAddress: { kind: "goat", environmentId, threadId },
    text: "check the build",
    attachments: [],
    receivedAt: NOW,
    intent: "message",
  });

/** Stores a GOAT message for a bot, as the gateway does once it has resolved the bot. */
const acceptFor = (botId: BotId, key: string, threadId: ThreadId, ownerId = "owner") =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const message = goatMessage(key, threadId);
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

      assert.strictEqual(yield* ledger.repairTaskBots(), 1);
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

describe("channel runtime after a downgrade", () => {
  it.effect("does no work until member tasks are back with their bots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const member = yield* acceptFor(MEMBER, "older-build", memberThread, rpcContext.ownerId);
      const { task } = createdTaskFor(member);
      yield* sql`UPDATE channel_inbox SET state = 'replied', task_ids_json = ${JSON.stringify([
        task.taskId,
      ])} WHERE input_id = ${member.inputId}`;
      yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
        generation, task_json, created_at, updated_at)
        VALUES (${task.taskId}, ${rpcContext.ownerId}, ${task.conversationId}, 'completed', 1, 1,
        ${JSON.stringify({ ...task, status: "completed" })}, ${NOW}, ${NOW})`;
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
});
