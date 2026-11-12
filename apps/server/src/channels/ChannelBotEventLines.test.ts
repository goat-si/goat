import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  ChannelGatewayError,
  CommandId,
  MessageId,
  ProjectId,
  ScheduledTaskId,
  type ScheduledTaskListResult,
  type ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AttachmentLifecycle from "../assets/AttachmentLifecycle.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import { scheduledTaskFixture } from "../scheduledTasks/ScheduledTaskFixture.testkit.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import { watchRoutines } from "./ChannelBotRoutineEvents.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import {
  botMessages,
  botThreadId,
  environmentId,
  makeHarness,
  modelSelection,
  owner,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const main = BotId.make("main");
const isGatewayError = Schema.is(ChannelGatewayError);
const eventLines = Effect.gen(function* () {
  yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
  const records = yield* botMessages;
  return records.turnItems.flatMap((item) =>
    item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
  );
});

/** The scripted launch creates no thread; a real launch would. */
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

const newMember = (purpose = "Checks builds.") =>
  Effect.gen(function* () {
    const bot = yield* (yield* ChannelBotMembers.ChannelBotMembers).create(
      {
        clientRequestId: "new",
        name: "New bot 2",
        avatar: null,
        purpose,
        defaultModelSelection: null,
      },
      owner,
    );
    yield* ensureThread(bot.sessionThreadId);
    return bot;
  });

const send = (threadId: ThreadId, text: string, key: string) =>
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
    owner,
  ).pipe(Effect.provide(AttachmentLifecycle.layerFiles));

/** A member's chat once every queued line has landed: message texts, event lines, greeting. */
const memberChat = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"]);
    const greeting = records.turnItems.flatMap((item) =>
      item.type === "assistant_message" && item.text.startsWith("Hi, I'm") ? [item] : [],
    )[0];
    return {
      texts: records.messages.map((message) => message.text),
      lines: records.turnItems.flatMap((item) =>
        item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
      ),
      greeting,
      greetingMessage: records.messages.find((message) => message.id === greeting?.messageId),
    };
  });

describe("GOAT Bot event lines", () => {
  it.effect("keeps the routine a line is about, so the line can open it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const events = yield* ChannelBotEvents.ChannelBotEvents;
      const subject = { kind: "routine" as const, id: "routine-1", name: "Standup" };
      yield* events.emit({
        ownerId: owner.ownerId,
        botId: main,
        kind: "routine-paused",
        id: "routine-1",
        text: "Routine Standup paused",
        subject,
      });
      yield* events.flush;
      const lines = (yield* botMessages).turnItems.flatMap((item) =>
        item.type === "notification" && item.source.kind === "goat_bot_event" ? [item] : [],
      );
      assert.deepStrictEqual(
        lines.map((item) => [item.summary, item.source]),
        [["Routine Standup paused", { kind: "goat_bot_event", subject }]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a routine titled over 200 characters still leaves its line, with a chip", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const events = yield* ChannelBotEvents.ChannelBotEvents;
      const feed = yield* Queue.unbounded<ScheduledTaskListResult>();
      const emitted = yield* Queue.unbounded<ChannelBotEvents.BotEvent>();
      yield* watchRoutines({
        subscribe: () => Stream.fromQueue(feed),
        botForThread: () => Effect.succeed({ ownerId: owner.ownerId, botId: main }),
        emit: (event) => events.emit(event).pipe(Effect.andThen(Queue.offer(emitted, event))),
      }).pipe(Effect.forkScoped);
      const routine = scheduledTaskFixture(ProjectId.make("project"), {
        id: ScheduledTaskId.make("long"),
        title: "Look over every open pull request ".repeat(8).trim(),
        threadId: botThreadId,
        goatBotRoutine: true,
      });
      yield* Queue.offer(feed, { tasks: [] });
      yield* Queue.offer(feed, { tasks: [routine] });
      yield* Queue.take(emitted);
      // A refused write is retried with backoff, so let the clock run past every try.
      const flushed = yield* events.flush.pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(flushed);
      const lines = (yield* botMessages).turnItems.flatMap((item) =>
        item.type === "notification" && item.source.kind === "goat_bot_event" ? [item] : [],
      );
      assert.strictEqual(lines.length, 1);
      const source = lines[0]?.source;
      const name = source?.kind === "goat_bot_event" ? (source.subject?.name ?? "") : "";
      assert.isTrue(name.endsWith("…"));
      assert.strictEqual(lines[0]?.summary, "Routine " + name + " set up");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("records a bot event line once per record key, without a run", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const record = {
        recordKey: "event:profile-name:main:change-1",
        entry: { type: "event" as const, text: "Renamed to Ada" },
      };
      for (const commandId of ["event-1", "event-1-retry"]) {
        yield* orchestrator.dispatch({
          type: "channel.timeline.record",
          commandId: CommandId.make(commandId),
          threadId: botThreadId,
          record,
        });
      }
      const after = yield* botMessages;
      const events = after.turnItems.flatMap((item) =>
        item.type === "notification" && item.source.kind === "goat_bot_event" ? [item] : [],
      );
      assert.deepStrictEqual(
        events.map((item) => [item.summary, item.ledgerTask]),
        [["Renamed to Ada", undefined]],
      );
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a saved rename and a new purpose each leave one line; a save that changes nothing leaves none",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        yield* members.update({ botId: main, name: "Ada" }, owner);
        yield* members.update({ botId: main, name: "Ada", avatar: "🦊" }, owner);
        yield* members.update({ botId: main, purpose: "Watch the deploys." }, owner);
        assert.deepStrictEqual(yield* eventLines, ["Renamed to Ada", "Purpose updated"]);
        const after = yield* botMessages;
        assert.deepStrictEqual(after.runs, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a refused edit leaves no line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const error = yield* Effect.flip(
        members.update({ botId: BotId.make("ghost"), name: "Ghost" }, owner),
      );
      assert.isTrue(isGatewayError(error));
      assert.deepStrictEqual(yield* eventLines, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("two renames at once leave their lines in the order they were saved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const first = yield* members
        .update({ botId: main, name: "Ada" }, owner)
        .pipe(Effect.forkChild);
      const second = yield* members
        .update({ botId: main, name: "Bea" }, owner)
        .pipe(Effect.forkChild);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      const saved = (yield* members.list({}, owner)).find((bot) => bot.botId === main);
      const lines = yield* eventLines;
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines.at(-1), "Renamed to " + saved?.name);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a new member's greeting after an early rename or purpose change", () => {
  it.effect(
    "a greeting record that changes nothing commits an accepted receipt with no events, and replays it",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const bot = yield* newMember();
        yield* send(bot.sessionThreadId, "hello", "after-greeting");
        const before = yield* memberChat(bot.sessionThreadId);
        const meta = before.greetingMessage?.channel;
        assert.isDefined(meta);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const command = {
          type: "channel.timeline.record" as const,
          commandId: CommandId.make("greeting-after-the-person"),
          threadId: bot.sessionThreadId,
          record: {
            recordKey: "greeting:" + bot.botId,
            entry: {
              type: "message" as const,
              role: "assistant" as const,
              text: "Hi, I'm Bea.",
              meta: meta!,
            },
          },
        };
        const first = yield* orchestrator.dispatch(command);
        assert.deepStrictEqual(first.storedEvents, []);
        const again = yield* orchestrator.dispatch(command);
        assert.deepStrictEqual(
          [again.sequence, again.storedEvents, again.replayed],
          [first.sequence, [], true],
        );
        assert.deepStrictEqual((yield* memberChat(bot.sessionThreadId)).texts, before.texts);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a rename right after creating a member renames its greeting and adds no line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* newMember();
      yield* members.update({ botId: bot.botId, name: "Ada" }, owner);
      const chat = yield* memberChat(bot.sessionThreadId);
      assert.lengthOf(chat.texts, 1);
      assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm Ada."));
      assert.isFalse(chat.texts.some((text) => text.includes("New bot 2")));
      assert.deepStrictEqual(chat.lines, []);
      const status = yield* (yield* ChannelBotRegistry.ChannelBotRegistry).status(owner, bot.botId);
      assert.isTrue(status.latest?.text.startsWith("Hi, I'm Ada."));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("renames back and forth in one instant leave the greeting on the last name", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* newMember();
      for (const name of ["Ada", "Bea", "Ada", "Bea"])
        yield* members.update({ botId: bot.botId, name }, owner);
      const chat = yield* memberChat(bot.sessionThreadId);
      assert.lengthOf(chat.texts, 1);
      assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm Bea."));
      assert.deepStrictEqual(chat.lines, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a new purpose before anything follows the greeting is quoted there, with no line",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const bot = yield* newMember();
        yield* members.update({ botId: bot.botId, purpose: "Watch the deploys." }, owner);
        const chat = yield* memberChat(bot.sessionThreadId);
        assert.lengthOf(chat.texts, 1);
        assert.include(chat.texts[0], "You set me up for: Watch the deploys.");
        assert.deepStrictEqual(chat.lines, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Passes on dev by design (dev never re-records); fails if a same-text record counted as written.
  it.effect(
    "a purpose change past what the greeting quotes keeps the greeting and writes Purpose updated",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const shown = "a".repeat(300);
        const bot = yield* newMember(shown + " first ending");
        const before = yield* memberChat(bot.sessionThreadId);
        yield* TestClock.adjust("1 minute");
        yield* members.update({ botId: bot.botId, purpose: shown + " second ending" }, owner);
        const after = yield* memberChat(bot.sessionThreadId);
        assert.deepStrictEqual(after.texts, before.texts);
        assert.deepStrictEqual(after.greeting?.updatedAt, before.greeting?.updatedAt);
        assert.deepStrictEqual(after.lines, ["Purpose updated"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a rename between a member's thread ref and its first greeting leaves the greeting on the new name",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const entered = yield* Deferred.make<BotId>();
        const release = yield* Deferred.make<void>();
        // A member is renamable once its ref exists (ChannelBotProfiles lists it then), and its
        // greeting comes after: hold creation in that gap, with the ref written as launch does.
        harness.launch.afterAccepted = (launch) =>
          Effect.gen(function* () {
            const threadId = launch.threadId!;
            // Read straight from the profile row, so nothing reconciles or launches again.
            const [row] = yield* sql<{ readonly bot_id: string }>`
              SELECT json_extract(value_json, '$.botId') AS bot_id FROM channel_runtime_state
              WHERE json_extract(value_json, '$.sessionThreadId') = ${threadId}`;
            const botId = BotId.make(row!.bot_id);
            yield* ledger.setMemberBotIfAbsent({
              ownerId: owner.ownerId,
              botId,
              bot: { environmentId, projectId: launch.projectId, threadId },
              now: "2026-10-12T00:00:00.000Z",
            });
            yield* Deferred.succeed(entered, botId);
            yield* Deferred.await(release);
          }).pipe(Effect.orDie);
        const creating = yield* members
          .create(
            {
              clientRequestId: "new",
              name: "New bot 2",
              avatar: null,
              purpose: "",
              defaultModelSelection: null,
            },
            owner,
          )
          .pipe(Effect.forkChild);
        const botId = yield* Deferred.await(entered);
        yield* members.update({ botId, name: "Bea" }, owner);
        yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
        yield* Deferred.succeed(release, undefined);
        const bot = yield* Fiber.join(creating);
        yield* ensureThread(bot.sessionThreadId);
        const chat = yield* memberChat(bot.sessionThreadId);
        assert.lengthOf(chat.texts, 1);
        assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm Bea."));
        assert.deepStrictEqual(chat.lines, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Passes on dev by design; fails if the rename re-records while a line is still queued.
  it.effect(
    "a rename while an earlier line still waits keeps the greeting and writes its line",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const events = yield* ChannelBotEvents.ChannelBotEvents;
        const bot = yield* newMember();
        // GoatBotEventSubject caps a name at 200 characters, so the timeline refuses this line on
        // every try and it waits in the bot's queue, as a line in retry does.
        yield* events.emit({
          ownerId: owner.ownerId,
          botId: bot.botId,
          kind: "routine-paused",
          id: "routine-1",
          text: "Routine paused",
          subject: { kind: "routine", id: "routine-1", name: "x".repeat(201) },
        });
        yield* members.update({ botId: bot.botId, name: "Ada" }, owner);
        const flushed = yield* events.flush.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(flushed);
        const chat = yield* memberChat(bot.sessionThreadId);
        assert.lengthOf(chat.texts, 1);
        assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm New bot 2."));
        assert.deepStrictEqual(chat.lines, ["Renamed to Ada"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Passes on dev by design.
  it.effect("once the person has written, a rename keeps the greeting and writes its line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* newMember();
      yield* send(bot.sessionThreadId, "hello", "person-first");
      yield* members.update({ botId: bot.botId, name: "Ada" }, owner);
      const chat = yield* memberChat(bot.sessionThreadId);
      assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm New bot 2."));
      assert.deepStrictEqual(chat.texts.slice(1), ["hello"]);
      assert.deepStrictEqual(chat.lines, ["Renamed to Ada"]);
    }).pipe(Effect.provide(harness.layer));
  });

  // Passes on dev by design; fails if only messages, not every turn item, kept the greeting.
  it.effect("an event line after the greeting keeps it, and the rename's line follows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const events = yield* ChannelBotEvents.ChannelBotEvents;
      const bot = yield* newMember();
      yield* events.emit({
        ownerId: owner.ownerId,
        botId: bot.botId,
        kind: "routine-paused",
        id: "routine-1",
        text: "Routine Standup paused",
        subject: { kind: "routine", id: "routine-1", name: "Standup" },
      });
      yield* events.flush;
      yield* members.update({ botId: bot.botId, name: "Ada" }, owner);
      const chat = yield* memberChat(bot.sessionThreadId);
      assert.lengthOf(chat.texts, 1);
      assert.isTrue(chat.texts[0]?.startsWith("Hi, I'm New bot 2."));
      assert.deepStrictEqual(chat.lines, ["Routine Standup paused", "Renamed to Ada"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a re-recorded greeting keeps its time and place, marks nothing unread, and emits only the update events",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const registry = yield* ChannelBotRegistry.ChannelBotRegistry;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const eventSink = yield* EventSink.EventSinkV2;
        const bot = yield* newMember();
        const threadId = bot.sessionThreadId;
        const unreadOf = Effect.map(threads.getThreadShell(threadId), (shell) => [
          shell?.notificationCompletedAt,
          shell?.markedUnreadCompletionAt,
        ]);
        const before = yield* memberChat(threadId);
        const latestBefore = (yield* registry.status(owner, bot.botId)).latest;
        const unreadBefore = yield* unreadOf;
        const start = yield* eventSink.latestSequence({ threadId });
        yield* TestClock.adjust("1 minute");
        yield* members.update({ botId: bot.botId, name: "Ada" }, owner);
        const after = yield* memberChat(threadId);
        assert.isTrue(after.texts[0]?.startsWith("Hi, I'm Ada."));
        assert.deepStrictEqual(
          [after.greetingMessage?.createdAt, after.greeting?.ordinal, after.greeting?.startedAt],
          [before.greetingMessage?.createdAt, before.greeting?.ordinal, before.greeting?.startedAt],
        );
        assert.strictEqual((yield* registry.status(owner, bot.botId)).latest?.at, latestBefore?.at);
        assert.deepStrictEqual(yield* unreadOf, unreadBefore);
        const end = yield* eventSink.latestSequence({ threadId });
        assert.isAbove(end, start);
        const written = yield* eventSink.stream({ threadId, afterSequence: start }).pipe(
          Stream.takeUntil((stored) => stored.sequence >= end),
          Stream.runCollect,
        );
        assert.deepStrictEqual(
          Array.from(written, ({ event }) =>
            event.type === "turn-item.updated" ? [event.type, event.payload.type] : [event.type],
          ),
          [["message.updated"], ["turn-item.updated", "assistant_message"]],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Passes on dev by design: one of the two outcomes, never a greeting below the person's message.
  it.effect("a send racing a rename ends with either the renamed greeting or the line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const bot = yield* newMember();
      const sending = yield* send(bot.sessionThreadId, "hello", "racing").pipe(Effect.forkChild);
      const renaming = yield* members
        .update({ botId: bot.botId, name: "Ada" }, owner)
        .pipe(Effect.forkChild);
      yield* Fiber.join(sending);
      yield* Fiber.join(renaming);
      const chat = yield* memberChat(bot.sessionThreadId);
      assert.deepStrictEqual(chat.texts.slice(1), ["hello"]);
      const renamed = chat.texts[0]?.startsWith("Hi, I'm Ada.") === true;
      const kept = chat.texts[0]?.startsWith("Hi, I'm New bot 2.") === true;
      assert.isTrue(renamed !== kept);
      assert.deepStrictEqual(chat.lines, renamed ? [] : ["Renamed to Ada"]);
    }).pipe(Effect.provide(harness.layer));
  });
});
