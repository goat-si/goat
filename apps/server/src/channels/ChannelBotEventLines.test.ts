import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  ChannelGatewayError,
  CommandId,
  ProjectId,
  ScheduledTaskId,
  type ScheduledTaskListResult,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { scheduledTaskFixture } from "../scheduledTasks/ScheduledTaskFixture.testkit.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import { watchRoutines } from "./ChannelBotRoutineEvents.ts";
import {
  botMessages,
  botThreadId,
  makeHarness,
  modelSelection,
  owner,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const main = BotId.make("main");
const NAMELESS_GREETING =
  "Hi, I'm your new bot. Give me a name, or tell me what you'd like me to start with.";

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

const createMember = (key: string, name: string, purpose = "") =>
  Effect.gen(function* () {
    const members = yield* ChannelBotMembers.ChannelBotMembers;
    const bot = yield* members.create(
      { clientRequestId: key, name, avatar: null, purpose, defaultModelSelection: null },
      owner,
    );
    yield* ensureThread(bot.sessionThreadId);
    return bot;
  });

const memberTexts = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.pipe(
    Effect.flatMap((threads) => threads.getThreadRecords(threadId, ["messages"])),
    Effect.map((records) => records.messages.map((message) => message.text)),
  );

const memberLines = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["turnItems"]);
    return records.turnItems.flatMap((item) =>
      item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
    );
  });

const isGatewayError = Schema.is(ChannelGatewayError);
const eventLines = Effect.gen(function* () {
  yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
  const records = yield* botMessages;
  return records.turnItems.flatMap((item) =>
    item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
  );
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

  it.effect("a member created with a generated name greets without stating it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* createMember("nameless", "New bot 2");
      assert.deepStrictEqual(yield* memberTexts(member.sessionThreadId), [NAMELESS_GREETING]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a member created with a typed name still greets by it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* createMember("named", "Ada");
      assert.deepStrictEqual(yield* memberTexts(member.sessionThreadId), [
        "Hi, I'm Ada. What would you like me to start with?",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a generated name still leaves the purpose it was set up for in the greeting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* createMember("nameless-purpose", "New bot 2", "Checks builds.");
      assert.deepStrictEqual(yield* memberTexts(member.sessionThreadId), [
        "Hi, I'm your new bot. You set me up for: Checks builds.\n\nGive me a name, or tell me what you'd like me to start with.",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a rename after a nameless greeting leaves it, and adds one line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const member = yield* createMember("nameless-rename", "New bot 2");
      yield* members.update({ botId: member.botId, name: "Ada" }, owner);
      assert.deepStrictEqual(yield* memberTexts(member.sessionThreadId), [NAMELESS_GREETING]);
      assert.deepStrictEqual(yield* memberLines(member.sessionThreadId), ["Renamed to Ada"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a rename after a named greeting leaves it, and adds one line", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const member = yield* createMember("named-rename", "Bea");
      yield* members.update({ botId: member.botId, name: "Ada" }, owner);
      assert.deepStrictEqual(yield* memberTexts(member.sessionThreadId), [
        "Hi, I'm Bea. What would you like me to start with?",
      ]);
      assert.deepStrictEqual(yield* memberLines(member.sessionThreadId), ["Renamed to Ada"]);
    }).pipe(Effect.provide(harness.layer));
  });
});
