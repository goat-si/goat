// @effect-diagnostics nodeBuiltinImport:off -- uploads are files in the attachments folder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  BotProfile,
  ChannelChildWorkId,
  ChannelGatewayError,
  ChannelTaskId,
  ChatAttachmentId,
  CommandId,
  GOAT_BOT_SESSION_THREAD_PREFIX,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AttachmentLifecycle from "../assets/AttachmentLifecycle.testkit.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import { memberBotKey } from "./channelBotLedger.ts";
import { botModel } from "./ChannelBotSession.testkit.ts";
import {
  botThreadId,
  defaultScript,
  environmentId,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { receptionDecisionChannels } from "./testkit/channelReceptionHarness.ts";

const MAIN = BotId.make("main");
const stranger = { ...owner, ownerId: "environment:stranger" };
const NOW = "2026-11-07T00:00:00.000Z";

// What an older build decodes a stored member profile with (ChannelBotProfiles at 577ee2556c).
const OlderMemberRecord = Schema.Struct({
  botId: BotProfile.fields.botId,
  role: Schema.Literal("member"),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  purpose: BotProfile.fields.purpose,
  defaultModelSelection: BotProfile.fields.defaultModelSelection,
  defaultProjectId: BotProfile.fields.defaultProjectId,
  environmentId: BotProfile.fields.environmentId,
  sessionThreadId: BotProfile.fields.sessionThreadId,
  createdAt: BotProfile.fields.createdAt,
  updatedAt: BotProfile.fields.updatedAt,
});
const decodeOlderMember = Schema.decodeUnknownExit(Schema.fromJsonString(OlderMemberRecord));
const profileKey = (botId: string, who = ownerId) =>
  "bot-profile:" + encodeURIComponent(who) + ":" + encodeURIComponent(botId);

/** The harness records launches without creating threads; a real launch creates the thread. */
const ensureThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const known = yield* threads.getThreadRecords(threadId, []).pipe(Effect.option);
    if (known._tag === "Some") return;
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:" + threadId),
      threadId,
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
  });

const createMember = (
  key: string,
  fields: { readonly name?: string; readonly model?: BotProfile["defaultModelSelection"] } = {},
  who = owner,
) =>
  Effect.gen(function* () {
    const members = yield* ChannelBotMembers.ChannelBotMembers;
    const bot = yield* members.create(
      {
        clientRequestId: key,
        name: fields.name ?? "Helper",
        avatar: null,
        purpose: "Checks builds.",
        defaultModelSelection: fields.model ?? null,
      },
      who,
    );
    yield* ensureThread(bot.sessionThreadId);
    return bot;
  });

const send = (threadId: ThreadId, text: string, key: string, who = owner) =>
  ThreadMessageIntake.dispatchCommand(
    {
      type: "message.dispatch",
      commandId: CommandId.make(key),
      threadId,
      messageId: MessageId.make(key + "-message"),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    },
    who,
  ).pipe(Effect.provide(AttachmentLifecycle.layerFiles));

const isGatewayError = Schema.is(ChannelGatewayError);
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isGatewayError(error) ? error.reason : String(error))),
  );

const threadView = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"]);
    return {
      archived: records.thread.archivedAt !== null,
      texts: records.messages.map((message) => message.text),
      cards: records.turnItems.flatMap((item) =>
        item.type === "notification" && item.ledgerTask ? [item.ledgerTask.taskId] : [],
      ),
    };
  });

const titles = (botId: BotId) =>
  ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) => ledger.listTasks({ ownerId, botId, limit: 20 })),
    Effect.map((page) => page.tasks.map((task) => task.title).sort()),
  );

const storedProfile = (botId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${profileKey(botId)}`,
    ),
    Effect.map((rows) => rows[0]?.value_json ?? ""),
  );

const setProfile = (botId: string, patch: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const next = { ...JSON.parse(yield* storedProfile(botId)), ...patch };
    yield* sql`UPDATE channel_runtime_state SET value_json = ${JSON.stringify(next)}
      WHERE key = ${profileKey(botId)}`;
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

describe("creating member bots", () => {
  it.effect(
    "a retry returns the same bot, an interrupted create is finished, owners never mix",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* createMember("create-1");
        const again = yield* createMember("create-1");
        assert.strictEqual(again.botId, first.botId);
        assert.strictEqual(again.sessionThreadId, first.sessionThreadId);
        assert.notStrictEqual(first.botId, MAIN);
        const listed = yield* members.list({}, owner);
        assert.deepStrictEqual(
          listed.map((bot) => [bot.role, bot.name]),
          [
            ["main", "GOAT Bot"],
            ["member", "Helper"],
          ],
        );
        assert.strictEqual(decodeOlderMember(yield* storedProfile(first.botId))._tag, "Success");
        assert.deepStrictEqual(yield* members.list({}, stranger), []);

        yield* sql`DELETE FROM channel_runtime_state WHERE key = ${memberBotKey(ownerId, first.botId)}`;
        assert.isUndefined(yield* ledger.getBotById(ownerId, first.botId));
        const finished = (yield* members.list({}, owner)).find((bot) => bot.botId === first.botId);
        assert.strictEqual(finished?.sessionThreadId, first.sessionThreadId);
        assert.strictEqual(
          (yield* ledger.getBotById(ownerId, first.botId))?.bot.threadId,
          first.sessionThreadId,
        );
        assert.strictEqual(
          harness.world.launches.filter((launch) => launch.threadId === first.sessionThreadId)
            .length > 0,
          true,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("two bots", () => {
  it.effect(
    "a member's model edit is what its next turn reads; the main bot's stays a setting",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const profiles = yield* ChannelBotProfiles.ChannelBotProfiles;
        const bot = yield* createMember("model-edit");
        const small = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-small" };
        const edited = yield* members.update(
          { botId: bot.botId, defaultModelSelection: small },
          owner,
        );
        assert.deepStrictEqual(edited.defaultModelSelection, small);
        assert.strictEqual(edited.name, "Helper");
        assert.deepStrictEqual(yield* profiles.modelFor(ownerId, bot.botId), small);
        const listed = (yield* members.list({}, owner)).find((each) => each.botId === bot.botId);
        assert.deepStrictEqual(listed?.defaultModelSelection, small);
        // A rename alone keeps the model; null returns the member to the main bot's model.
        yield* members.update({ botId: bot.botId, name: "Builder" }, owner);
        assert.deepStrictEqual(yield* profiles.modelFor(ownerId, bot.botId), small);
        yield* members.update({ botId: bot.botId, defaultModelSelection: null }, owner);
        assert.isNull(yield* profiles.modelFor(ownerId, bot.botId));
        assert.strictEqual(
          yield* refusal(members.update({ botId: MAIN, defaultModelSelection: small }, owner)),
          "invalid_input",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a member answers in its own conversation and thread, and keeps its work apart", () => {
    const harness = makeHarness();
    const identities: Array<string> = [];
    harness.script.current = (input) => {
      if (input.mode === "input") identities.push(input.identity?.name ?? "");
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const registry = yield* ChannelBotRegistry.ChannelBotRegistry;
      const botThreads = yield* ChannelBotThreads.ChannelBotThreads;
      const member = yield* createMember("two-bots");
      const memberThread = member.sessionThreadId;
      yield* send(memberThread, "hello", "m-hello");
      yield* send(botThreadId, "hello main", "main-hello");
      yield* send(memberThread, "do: check the build", "m-task");
      yield* send(botThreadId, "do: count the stars", "main-task");
      yield* runtime.drain;

      const inputs = yield* sql<{ readonly bot_id: string; readonly conversation_id: string }>`
        SELECT bot_id, conversation_id FROM channel_inbox ORDER BY rowid`;
      assert.deepStrictEqual(
        inputs.map((row) => row.bot_id),
        [member.botId, "main", member.botId, "main"],
      );
      assert.notStrictEqual(inputs[0]!.conversation_id, inputs[1]!.conversation_id);
      assert.include(identities, "Helper");
      assert.include(identities, "GOAT Bot");
      assert.deepStrictEqual(yield* titles(member.botId), ["check the build"]);
      assert.deepStrictEqual(yield* titles(MAIN), ["count the stars"]);
      const memberView = yield* threadView(memberThread);
      const mainView = yield* threadView(botThreadId);
      assert.deepStrictEqual(
        memberView.texts.filter((text) => text === "hello main"),
        [],
      );
      assert.include(memberView.texts, "hello");
      assert.notInclude(mainView.texts, "hello");
      const memberRows = (yield* botThreads.list(owner, member.botId)).rows;
      assert.deepStrictEqual(
        memberRows.flatMap((row) => (row.kind === "task" ? [row.task.title] : [])),
        ["check the build"],
      );

      yield* sql`UPDATE channel_tasks SET status = 'waiting_input',
        task_json = json_set(task_json, '$.status', 'waiting_input')`;
      assert.strictEqual((yield* registry.status(owner, member.botId)).waitingCount, 1);
      assert.strictEqual((yield* registry.status(owner)).waitingCount, 1);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.visit",
        commandId: CommandId.make("visit-member"),
        threadId: memberThread,
        visitedAt: NOW,
      });
      assert.strictEqual((yield* registry.status(owner, member.botId)).waitingCount, 0);
      assert.strictEqual((yield* registry.status(owner)).waitingCount, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists a member's turn with live child work under that member only", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const botThreads = yield* ChannelBotThreads.ChannelBotThreads;
      const member = yield* createMember("turn-child");
      yield* send(member.sessionThreadId, "do: check the build", "m-turn");
      yield* runtime.drain;
      const [stored] = yield* sql<{ readonly task_id: string; readonly generation: number }>`
        SELECT task_id, generation FROM channel_tasks WHERE bot_id = ${member.botId}`;
      assert.isDefined(stored);
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.kind', 'turn') WHERE task_id = ${stored!.task_id}`;
      const memberTasks = () =>
        botThreads
          .list(owner, member.botId)
          .pipe(
            Effect.map((result) =>
              result.rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
            ),
          );
      assert.deepStrictEqual(yield* memberTasks(), []);

      yield* (yield* ChildStore.ChannelChildWorkStore).admitReserved(
        {
          ownerId,
          taskId: ChannelTaskId.make(stored!.task_id),
          childWorkId: ChannelChildWorkId.make("member-child"),
          generation: stored!.generation,
          callerThreadId: member.sessionThreadId,
          requestKey: "member-child",
          promptDigest: "digest",
          surface: "thread_launch",
          destination: { threadId: ThreadId.make("thread:member-child") },
          state: "bound",
          createdAt: NOW,
          updatedAt: NOW,
        },
        100,
      );
      assert.deepStrictEqual(yield* memberTasks(), [stored!.task_id]);
      const mainRows = (yield* botThreads.list(owner)).rows;
      assert.notInclude(
        mainRows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
        stored!.task_id,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses messages no active bot of this owner can take", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const member = yield* createMember("refusals");
      const unknown = ThreadId.make("thread:nobody");
      assert.strictEqual(
        yield* refusal(
          gateway.ingest(
            {
              ...goatInput("hi", "unknown"),
              conversationKey: unknown,
              replyAddress: { kind: "goat", environmentId, threadId: unknown },
            },
            rpcContext,
          ),
        ),
        "forbidden",
      );
      assert.strictEqual(
        yield* refusal(send(member.sessionThreadId, "hi", "stranger", stranger)),
        "forbidden",
      );
      yield* members.remove({ botId: member.botId }, owner);
      assert.strictEqual(
        yield* refusal(send(member.sessionThreadId, "hi", "after-delete")),
        "forbidden",
      );
      const slack = yield* gateway.ingest(slackInput("hi", "slack-1"), slackContext);
      assert.strictEqual((yield* ledger.getInput(slack.inputId))?.botId, MAIN);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("hiding, deleting and restoring member bots", () => {
  it.effect(
    "a member's color survives a retried create, edits and hiding; null clears it; main takes none",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const create = () =>
          members.create(
            {
              clientRequestId: "colored",
              name: "Helper",
              avatar: null,
              purpose: "",
              defaultModelSelection: null,
              color: "#2F80ED",
            },
            owner,
          );
        const bot = yield* create();
        assert.strictEqual(bot.color, "#2F80ED");
        assert.strictEqual((yield* create()).color, "#2F80ED");
        const listed = () =>
          members
            .list({}, owner)
            .pipe(Effect.map((bots) => bots.find((b) => b.botId === bot.botId)));
        yield* members.update({ botId: bot.botId, name: "Builder" }, owner);
        yield* members.setHidden({ botId: bot.botId, hidden: true }, owner);
        yield* members.setHidden({ botId: bot.botId, hidden: false }, owner);
        assert.strictEqual((yield* listed())?.color, "#2F80ED");
        assert.strictEqual((yield* listed())?.name, "Builder");
        assert.strictEqual(decodeOlderMember(yield* storedProfile(bot.botId))._tag, "Success");
        const recolored = yield* members.update({ botId: bot.botId, color: "#C2410C" }, owner);
        assert.strictEqual(recolored.color, "#C2410C");
        const cleared = yield* members.update({ botId: bot.botId, color: null }, owner);
        assert.isUndefined(cleared.color);
        assert.isUndefined((yield* listed())?.color);
        assert.strictEqual(
          yield* refusal(members.update({ botId: MAIN, color: "#2F80ED" }, owner)),
          "invalid_input",
        );
        const main = yield* members.update({ botId: MAIN, color: null }, owner);
        assert.isUndefined(main.color);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("delete waits for open work, archives the thread, and restore brings it back", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const member = yield* createMember("lifecycle");
      yield* send(member.sessionThreadId, "do: check the build", "busy-task");
      yield* runtime.drain;
      assert.strictEqual(
        yield* refusal(members.remove({ botId: member.botId }, owner)),
        "bot_busy",
      );
      const [task] = (yield* ledger.listTasks({ ownerId, botId: member.botId, limit: 5 })).tasks;
      yield* finishWork(harness, task!.taskId);

      const other = yield* createMember("lifecycle-2", { name: "Second" });
      yield* send(other.sessionThreadId, "hello", "unanswered");
      assert.strictEqual(yield* refusal(members.remove({ botId: other.botId }, owner)), "bot_busy");

      const removed = yield* members.remove({ botId: member.botId }, owner);
      assert.strictEqual(removed.state, "deleted");
      assert.isTrue((yield* threadView(member.sessionThreadId)).archived);
      assert.notInclude(
        (yield* members.list({}, owner)).map((bot) => bot.botId),
        member.botId,
      );
      assert.strictEqual(
        (yield* members.list({ includeDeleted: true }, owner)).find(
          (bot) => bot.botId === member.botId,
        )?.state,
        "deleted",
      );

      // A delivery for its finished work still lands, in the archived thread.
      const memberInput = (yield* ledger.getTask(task!.taskId))!.task.originInputId;
      yield* ledger.enqueueDeliveries(
        [
          {
            deliveryId: "late-delivery" as never,
            causeKey: "late-delivery",
            inputId: memberInput,
            message: {
              deliveryId: "late-delivery" as never,
              destination: { kind: "goat", environmentId, threadId: member.sessionThreadId },
              kind: "receipt",
              text: "A late note.",
              inReplyToInputId: memberInput,
            },
          },
        ],
        DateTime.formatIso(yield* DateTime.now),
      );
      yield* runtime.drain;
      assert.include((yield* threadView(member.sessionThreadId)).texts, "A late note.");

      const restored = yield* members.restore({ botId: member.botId }, owner);
      assert.strictEqual(restored.sessionThreadId, member.sessionThreadId);
      assert.notStrictEqual(restored.state, "deleted");
      assert.isFalse((yield* threadView(member.sessionThreadId)).archived);
      yield* send(member.sessionThreadId, "back again", "after-restore");

      assert.strictEqual(yield* refusal(members.remove({ botId: MAIN }, owner)), "invalid_input");
      assert.strictEqual(
        yield* refusal(members.setHidden({ botId: MAIN, hidden: true }, owner)),
        "invalid_input",
      );
      yield* members.setHidden({ botId: member.botId, hidden: true }, owner);
      const hidden = (yield* members.list({}, owner)).find((bot) => bot.botId === member.botId);
      assert.strictEqual(hidden?.hidden, true);
      yield* members.setHidden({ botId: member.botId, hidden: false }, owner);
      const shown = (yield* members.list({}, owner)).find((bot) => bot.botId === member.botId);
      assert.notStrictEqual(shown?.hidden, true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a step left pending by a crash is finished at startup, never against a newer one",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const deleted = yield* createMember("crash-delete");
        const restoredLater = yield* createMember("crash-restore", { name: "Second" });
        const archivedByHand = yield* createMember("by-hand", { name: "Third" });
        // A delete committed, then the process stopped before archiving.
        yield* setProfile(deleted.botId, {
          state: "deleted",
          lifecycle: { pending: "archive", at: "2026-11-07T00:00:01.000Z" },
        });
        // A delete whose archive never ran was restored, and that unarchive failed too.
        yield* setProfile(restoredLater.botId, {
          state: "active",
          lifecycle: { pending: "unarchive", at: "2026-11-07T00:00:02.000Z" },
        });
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("person-archives"),
          threadId: archivedByHand.sessionThreadId,
        });

        const archivedEvent = orchestrator
          .streamStoredEventsFrom({ threadId: deleted.sessionThreadId })
          .pipe(
            Stream.filter((stored) => stored.event.type === "thread.archived"),
            Stream.runHead,
          );
        yield* Layer.build(ChannelRuntime.layerBackground);
        yield* TestClock.adjust("1 second");
        yield* archivedEvent;
        // A list waits for the reconciler's permit, so it sees the finished state.
        yield* members.list({}, owner);
        assert.isTrue((yield* threadView(deleted.sessionThreadId)).archived);
        assert.notInclude(yield* storedProfile(deleted.botId), "pending");
        assert.isFalse((yield* threadView(restoredLater.sessionThreadId)).archived);
        assert.notInclude(yield* storedProfile(restoredLater.botId), "pending");
        assert.isTrue((yield* threadView(archivedByHand.sessionThreadId)).archived);

        // Restore after a failed archive, and delete after a failed unarchive, end where asked.
        yield* members.restore({ botId: deleted.botId }, owner);
        assert.isFalse((yield* threadView(deleted.sessionThreadId)).archived);
        yield* setProfile(restoredLater.botId, {
          lifecycle: { pending: "unarchive", at: "2026-11-07T00:00:03.000Z" },
        });
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archived-before-unarchive"),
          threadId: restoredLater.sessionThreadId,
        });
        yield* members.remove({ botId: restoredLater.botId }, owner);
        yield* members.list({}, owner);
        assert.isTrue((yield* threadView(restoredLater.sessionThreadId)).archived);
        assert.notInclude(yield* storedProfile(restoredLater.botId), "pending");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("a delete racing a message", () => {
  it.effect(
    "the ledger refuses a new message once the delete committed, and keeps a stored one",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const member = yield* createMember("race");
        const thread = member.sessionThreadId;
        const toMember = (key: string) => ({
          ...goatInput("hello", key),
          conversationKey: thread,
          replyAddress: { kind: "goat" as const, environmentId, threadId: thread },
        });
        // Stored and answered before the delete.
        const answered = yield* gateway.ingest(toMember("answered"), rpcContext);
        yield* runtime.drain;
        const stored = (yield* ledger.getInput(answered.inputId))!;
        assert.isDefined(yield* ledger.resolveIngressBot(ownerId, thread));
        yield* members.remove({ botId: member.botId }, owner);
        const replay = yield* ledger.acceptInput({
          ownerId,
          inputId: answered.inputId,
          conversationId: stored.snapshot.conversationId,
          bindingId: stored.snapshot.bindingId,
          message: stored.message,
          contentHash: (yield* SqlClient.SqlClient.pipe(
            Effect.flatMap(
              (sql) => sql<{ readonly content_hash: string }>`
              SELECT content_hash FROM channel_inbox WHERE input_id = ${answered.inputId}`,
            ),
          ))[0]!.content_hash,
          requester: stored.requester,
          acceptedAt: NOW,
          botId: member.botId,
        });
        assert.isTrue(replay.duplicate);
        const fresh = yield* Effect.flip(
          ledger.acceptInput({
            ownerId,
            inputId: "channel-input:fresh" as never,
            conversationId: stored.snapshot.conversationId,
            bindingId: stored.snapshot.bindingId,
            message: { ...stored.message, idempotencyKey: "fresh" },
            contentHash: "fresh",
            requester: stored.requester,
            acceptedAt: NOW,
            botId: member.botId,
          }),
        );
        assert.strictEqual(fresh.reason, "bot_inactive");
        assert.strictEqual(
          yield* refusal(gateway.ingest(toMember("answered"), rpcContext)),
          "forbidden",
        );

        // The other order: a stored, unanswered message makes the delete wait.
        yield* members.restore({ botId: member.botId }, owner);
        yield* gateway.ingest(toMember("waiting"), rpcContext);
        assert.strictEqual(
          yield* refusal(members.remove({ botId: member.botId }, owner)),
          "bot_busy",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a message that passed the early check is refused at storage and its upload let go",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const config = yield* ServerConfig.ServerConfig;
        const member = yield* createMember("upload-race");
        const thread = member.sessionThreadId;
        // The delete commits after the gateway's early check and before the ledger stores.
        const racing = ChannelLedger.ChannelLedger.of({
          ...ledger,
          acceptInput: (input) =>
            members
              .remove({ botId: member.botId }, owner)
              .pipe(Effect.orDie, Effect.andThen(ledger.acceptInput(input))),
        });
        const context = yield* Layer.build(
          Layer.fresh(ChannelGateway.layer).pipe(
            Layer.provide(Layer.succeed(ChannelLedger.ChannelLedger, racing)),
          ),
        );
        const gateway = Context.get(context, ChannelGateway.ChannelGateway);
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        const id = ChatAttachmentId.make(createPendingAttachmentId());
        NodeFS.writeFileSync(
          NodePath.join(config.attachmentsDir, id + ".png"),
          new Uint8Array([1]),
        );
        const files = () => NodeFS.readdirSync(config.attachmentsDir, { recursive: true }).sort();
        const before = files();
        const reason = yield* refusal(
          gateway.ingest(
            {
              ...goatInput("look at this", "upload"),
              conversationKey: thread,
              replyAddress: { kind: "goat", environmentId, threadId: thread },
              attachments: [
                { type: "image", id, name: "a.png", mimeType: "image/png", sizeBytes: 1 },
              ],
            },
            rpcContext,
          ),
        );
        assert.strictEqual(reason, "forbidden");
        assert.deepStrictEqual(files(), before);
        assert.lengthOf(
          (yield* ledger.listTasks({ ownerId, botId: member.botId, limit: 5 })).tasks,
          0,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("a member's model", () => {
  const astra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" } as const;
  const missing = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-gone" } as const;
  const modelHarness = (goatBotModelSelection: typeof botModel | typeof missing) => {
    const harness = makeHarness({
      botWorkspace: true,
      providerInstances: [
        { instanceId: "codex", models: ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"] },
      ],
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        goatBotModelSelection,
      }).pipe(Layer.orDie),
    });
    harness.script.current = (input) => {
      const text = input.inputText ?? "";
      return input.mode === "input" && text.startsWith("look:")
        ? Effect.succeed({
            replyText: "Looking now.",
            action: { type: "run_turn" as const, title: text.slice(5).trim(), instruction: text },
          })
        : defaultScript(input);
    };
    return harness;
  };
  const turnModel = (
    harness: ReturnType<typeof makeHarness>,
    bot: ChannelBotMembers.MemberBot,
    key: string,
  ) =>
    Effect.gen(function* () {
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* send(bot.sessionThreadId, "look: the build", key);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, botId: bot.botId, limit: 5 })).tasks;
      const sessionThread = task?.worker?.threadId ?? "";
      assert.isTrue(sessionThread.startsWith(GOAT_BOT_SESSION_THREAD_PREFIX));
      return harness.world.launches.find((launch) => launch.threadId === sessionThread)
        ?.modelSelection.model;
    });

  it.effect(
    "runs a member's turns on its model, else the GOAT Bot model when its own is gone",
    () => {
      const harness = modelHarness(botModel);
      return Effect.gen(function* () {
        yield* setupBot;
        const own = yield* createMember("model-own", { model: astra });
        const gone = yield* createMember("model-gone", { name: "Second", model: missing });
        assert.strictEqual(yield* turnModel(harness, own, "own"), "gpt-6-astra");
        assert.strictEqual(yield* turnModel(harness, gone, "gone"), "gpt-6-luna");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "falls back to the default when neither the member's nor GOAT Bot's model is offered",
    () => {
      const harness = modelHarness(missing);
      return Effect.gen(function* () {
        yield* setupBot;
        const gone = yield* createMember("model-default", { model: missing });
        assert.strictEqual(yield* turnModel(harness, gone, "default"), modelSelection.model);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a member's turn answers as a reply to the request in its own thread only", () => {
    const harness = makeHarness({
      botWorkspace: true,
      channelsLayer: receptionDecisionChannels,
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        goatBotModelSelection: botModel,
      }).pipe(Layer.orDie),
    });
    harness.script.current = (input) => {
      const text = input.inputText ?? "";
      return input.mode === "input" && text.startsWith("look:")
        ? Effect.succeed({
            replyText: "Looking now.",
            action: { type: "run_turn" as const, title: "the build", instruction: text },
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* createMember("turn-reply");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* send(member.sessionThreadId, "look: the build", "turn-reply");
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, botId: member.botId, limit: 5 })).tasks;
      harness.world.setStatus(task!.worker!.threadId, 1, "completed", "The build is green.");
      yield* (yield* ChannelWorkerReports.ChannelWorkerReports).reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { messages } = yield* threads.getThreadRecords(member.sessionThreadId, ["messages"]);
      const replies = (text: string) =>
        messages.filter(
          (message) =>
            message.text === text && message.channel?.inReplyToInputId === task!.originInputId,
        );
      assert.lengthOf(replies("Looking now."), 1);
      assert.lengthOf(replies("The build is green."), 1);
      assert.notInclude((yield* threadView(botThreadId)).texts, "The build is green.");
      // The member's session gets the same personal data and read-only rules as the main bot.
      const launched = harness.world.launches.find(
        (launch) => launch.threadId === task!.worker!.threadId,
      )?.initialMessage?.text;
      assert.include(launched, "only through a connector already connected for that account");
      assert.include(
        launched,
        "no updating, installing, or signing in to apps, CLIs, browsers, or extensions",
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("member limits", () => {
  it.effect("refuses a bot past the limit, and a restore that would pass it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const create = (key: string) =>
        members.create(
          {
            clientRequestId: key,
            name: "Bot " + key,
            avatar: null,
            purpose: "",
            defaultModelSelection: null,
          },
          owner,
        );
      const first = yield* create("limit-0");
      for (let index = 1; index < ChannelBotMembers.MEMBER_LIMIT; index++) {
        yield* create("limit-" + index);
      }
      assert.strictEqual(yield* refusal(create("limit-over")), "bot_limit");
      yield* members.remove({ botId: first.botId }, owner);
      yield* create("limit-after-delete");
      assert.strictEqual(
        yield* refusal(members.restore({ botId: first.botId }, owner)),
        "bot_limit",
      );
      assert.lengthOf(yield* members.list({}, owner), ChannelBotMembers.MEMBER_LIMIT + 1);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("reconciling many members", () => {
  it.effect("finishes a member behind more than a batch of steps that keep failing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const stuckOwner = "environment:stuck";
      const record = (botId: string, threadId: string) => ({
        botId,
        role: "member",
        name: "Bot",
        avatar: null,
        purpose: "",
        defaultModelSelection: null,
        defaultProjectId: null,
        environmentId,
        sessionThreadId: threadId,
        createdAt: NOW,
        updatedAt: NOW,
        state: "deleted",
        lifecycle: { pending: "archive", at: NOW },
      });
      // Their threads do not exist, so every archive fails and stays pending.
      for (let index = 0; index < 120; index++) {
        const botId = "a" + String(index).padStart(11, "0");
        yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES
          (${profileKey(botId, stuckOwner)}, ${JSON.stringify(record(botId, "thread:gone-" + index))}, ${NOW})`;
      }
      const thread = ThreadId.make("thread:last-member");
      yield* ensureThread(thread);
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES
        (${profileKey("zzzzzzzzzzzz", stuckOwner)}, ${JSON.stringify(record("zzzzzzzzzzzz", thread))}, ${NOW})`;

      yield* members.reconcileAll;
      assert.isTrue((yield* threadView(thread)).archived);
    }).pipe(Effect.provide(harness.layer));
  });
});
